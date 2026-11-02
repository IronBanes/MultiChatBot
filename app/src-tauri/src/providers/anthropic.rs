//! Anthropic Messages API (`POST {base}/v1/messages`, SSE).

use super::{
    ChatRequest, EventStream, ModelInfo, Provider, ProviderError, StreamEvent, ToolCall, ToolResult, http_error,
    parse_models, sse_data,
};
use crate::context::Role;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// API version 2026-10-21 rejects `temperature`/`top_p`/`top_k` on every model,
/// so a profile's temperature is not sent to Anthropic.
const API_VERSION: &str = "2026-10-21";

pub struct Anthropic {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

impl Anthropic {
    fn url(&self, path: &str) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/{path}", self.base_url)
        } else {
            format!("{}/v1/{path}", self.base_url)
        }
    }

    fn request(&self, r: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let r = r.header("anthropic-version", API_VERSION);
        match &self.api_key {
            Some(key) => r.header("x-api-key", key),
            None => r,
        }
    }
}

/// A content block being assembled from stream events. Thinking blocks keep
/// their signature so they can be sent back unchanged in a tool round.
enum Block {
    Text(String),
    Thinking { thinking: String, signature: String },
    Redacted(Value),
    ToolUse { id: String, name: String, input: String },
    Other,
}

impl Block {
    fn to_json(&self) -> Option<Value> {
        match self {
            Block::Text(t) if !t.is_empty() => Some(json!({ "type": "text", "text": t })),
            Block::Text(_) | Block::Other => None,
            Block::Thinking { thinking, signature } => {
                Some(json!({ "type": "thinking", "thinking": thinking, "signature": signature }))
            }
            Block::Redacted(v) => Some(v.clone()),
            Block::ToolUse { id, name, input } => Some(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": serde_json::from_str::<Value>(input).unwrap_or_else(|_| json!({})),
            })),
        }
    }
}

#[async_trait::async_trait]
impl Provider for Anthropic {
    async fn stream_chat(&self, req: &ChatRequest) -> Result<EventStream, ProviderError> {
        let mut messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| {
                let role = match m.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                };
                json!({ "role": role, "content": m.content })
            })
            .collect();
        messages.extend(req.continuation.iter().cloned());

        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_output_tokens,
            "system": req.system,
            "messages": messages,
            "stream": true,
        });
        if req.show_reasoning {
            body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
        }
        if let Some(effort) = &req.reasoning_effort {
            body["output_config"] = json!({ "effort": effort });
        }
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(
                req.tools
                    .iter()
                    .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
                    .collect(),
            );
            if !req.allow_tool_calls {
                body["tool_choice"] = json!({ "type": "none" });
            }
        }

        let resp = self
            .request(self.http.post(self.url("messages")))
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }

        let mut data = Box::pin(sse_data(resp));
        Ok(Box::pin(async_stream::stream! {
            let mut blocks: BTreeMap<u64, Block> = BTreeMap::new();
            let mut stop_reason = String::new();
            while let Some(item) = data.next().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => { yield Err(e); return; }
                };
                let Ok(v) = serde_json::from_str::<Value>(&payload) else { continue };
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0);
                match v.get("type").and_then(Value::as_str) {
                    Some("content_block_start") => {
                        let cb = v.get("content_block").cloned().unwrap_or(Value::Null);
                        let str_of = |k: &str| cb.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
                        let block = match cb.get("type").and_then(Value::as_str) {
                            Some("text") => Block::Text(str_of("text")),
                            Some("thinking") => Block::Thinking { thinking: str_of("thinking"), signature: str_of("signature") },
                            Some("redacted_thinking") => Block::Redacted(cb.clone()),
                            Some("tool_use") => Block::ToolUse { id: str_of("id"), name: str_of("name"), input: String::new() },
                            _ => Block::Other,
                        };
                        blocks.insert(index, block);
                    }
                    Some("content_block_delta") => {
                        let d = v.get("delta").cloned().unwrap_or(Value::Null);
                        let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
                        match (d.get("type").and_then(Value::as_str), blocks.get_mut(&index)) {
                            (Some("text_delta"), Some(Block::Text(t))) => {
                                let piece = s("text");
                                t.push_str(&piece);
                                yield Ok(StreamEvent::Text(piece));
                            }
                            (Some("thinking_delta"), Some(Block::Thinking { thinking, .. })) => {
                                let piece = s("thinking");
                                thinking.push_str(&piece);
                                if !piece.is_empty() {
                                    yield Ok(StreamEvent::Reasoning(piece));
                                }
                            }
                            (Some("signature_delta"), Some(Block::Thinking { signature, .. })) => signature.push_str(&s("signature")),
                            (Some("input_json_delta"), Some(Block::ToolUse { input, .. })) => input.push_str(&s("partial_json")),
                            _ => {}
                        }
                    }
                    Some("message_delta") => {
                        if let Some(r) = v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                            stop_reason = r.to_string();
                        }
                        if stop_reason == "refusal" {
                            yield Err(ProviderError::new("The model declined to respond"));
                            return;
                        }
                    }
                    Some("error") => {
                        let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("Provider stream error");
                        yield Err(ProviderError::new(msg));
                        return;
                    }
                    Some("message_stop") => break,
                    _ => {}
                }
            }
            let calls: Vec<ToolCall> = blocks
                .values()
                .filter_map(|b| match b {
                    Block::ToolUse { id, name, input } => Some(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: serde_json::from_str(input).unwrap_or_else(|_| json!({})),
                    }),
                    _ => None,
                })
                .collect();
            if !calls.is_empty() {
                let content: Vec<Value> = blocks.values().filter_map(Block::to_json).collect();
                yield Ok(StreamEvent::ToolCalls { calls, assistant: json!({ "role": "assistant", "content": content }) });
            }
        }))
    }

    fn tool_results(&self, results: &[ToolResult]) -> Vec<Value> {
        let content: Vec<Value> = results
            .iter()
            .map(|r| json!({ "type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error }))
            .collect();
        vec![json!({ "role": "user", "content": content })]
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let resp = self
            .request(self.http.get(self.url("models?limit=1000")))
            .send()
            .await
            .map_err(|e| ProviderError::from_reqwest(&e))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let v: Value = resp.json().await.map_err(|e| ProviderError::from_reqwest(&e))?;
        Ok(parse_models(&v))
    }
}
