//! OpenAI-compatible Chat Completions (`POST {base}/chat/completions`, SSE).
//! Covers OpenAI, NanoGPT, OpenRouter, Groq, Ollama, LM Studio and others.

use super::{
    ChatRequest, EventStream, ModelInfo, Provider, ProviderError, StreamEvent, ToolCall, ToolResult, http_error,
    parse_models, sse_data,
};
use crate::context::Role;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct OpenAiCompatible {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

impl OpenAiCompatible {
    fn is_nanogpt(&self) -> bool {
        self.base_url.contains("nano-gpt.com")
    }

    fn get(&self, url: String) -> reqwest::RequestBuilder {
        let mut r = self.http.get(url);
        if let Some(key) = &self.api_key {
            r = r.bearer_auth(key);
        }
        r
    }
}

/// A tool call being assembled from streamed fragments.
#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

#[async_trait::async_trait]
impl Provider for OpenAiCompatible {
    async fn stream_chat(&self, req: &ChatRequest) -> Result<EventStream, ProviderError> {
        let mut messages = vec![json!({ "role": "system", "content": req.system })];
        messages.extend(req.messages.iter().map(|m| {
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            json!({ "role": role, "content": m.content })
        }));
        messages.extend(req.continuation.iter().cloned());

        let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(effort) = &req.reasoning_effort {
            body["reasoning_effort"] = json!(effort);
        }
        if !req.show_reasoning && self.is_nanogpt() {
            // Reasoning still happens; NanoGPT just stops sending it.
            body["reasoning"] = json!({ "exclude": true });
        }
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(
                req.tools
                    .iter()
                    .map(|t| {
                        json!({
                            "type": "function",
                            "function": { "name": t.name, "description": t.description, "parameters": t.schema }
                        })
                    })
                    .collect(),
            );
            if !req.allow_tool_calls {
                body["tool_choice"] = json!("none");
            }
        }

        let mut http = self.http.post(format!("{}/chat/completions", self.base_url)).json(&body);
        if let Some(key) = &self.api_key {
            http = http.bearer_auth(key);
        }
        let resp = http.send().await.map_err(|e| ProviderError::from_reqwest(&e))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }

        let show_reasoning = req.show_reasoning;
        let mut data = Box::pin(sse_data(resp));
        Ok(Box::pin(async_stream::stream! {
            let mut calls: BTreeMap<u64, PartialCall> = BTreeMap::new();
            let mut text = String::new();
            while let Some(item) = data.next().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => { yield Err(e); return; }
                };
                if payload == "[DONE]" {
                    break;
                }
                let Ok(v) = serde_json::from_str::<Value>(&payload) else { continue };
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(Value::as_str).unwrap_or("Provider returned an error");
                    yield Err(ProviderError::new(msg));
                    return;
                }
                let Some(delta) = v.pointer("/choices/0/delta") else { continue };
                if show_reasoning {
                    // NanoGPT/OpenRouter use `reasoning`; DeepSeek and others `reasoning_content`.
                    let r = delta.get("reasoning").or_else(|| delta.get("reasoning_content")).and_then(Value::as_str);
                    if let Some(r) = r.filter(|r| !r.is_empty()) {
                        yield Ok(StreamEvent::Reasoning(r.to_string()));
                    }
                }
                if let Some(t) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    text.push_str(t);
                    yield Ok(StreamEvent::Text(t.to_string()));
                }
                for tc in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let index = tc.get("index").and_then(Value::as_u64).unwrap_or(calls.len() as u64);
                    let c = calls.entry(index).or_default();
                    if let Some(id) = tc.get("id").and_then(Value::as_str) {
                        c.id = id.to_string();
                    }
                    if let Some(n) = tc.pointer("/function/name").and_then(Value::as_str) {
                        c.name.push_str(n);
                    }
                    if let Some(a) = tc.pointer("/function/arguments").and_then(Value::as_str) {
                        c.arguments.push_str(a);
                    }
                }
            }
            if !calls.is_empty() {
                let calls: Vec<ToolCall> = calls
                    .into_values()
                    .enumerate()
                    .map(|(i, c)| ToolCall {
                        id: if c.id.is_empty() { format!("call_{i}") } else { c.id },
                        arguments: serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({})),
                        name: c.name,
                    })
                    .collect();
                let assistant = json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                    "tool_calls": calls.iter().map(|c| json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": c.arguments.to_string() }
                    })).collect::<Vec<_>>(),
                });
                yield Ok(StreamEvent::ToolCalls { calls, assistant });
            }
        }))
    }

    fn tool_results(&self, results: &[ToolResult]) -> Vec<Value> {
        results
            .iter()
            .map(|r| json!({ "role": "tool", "tool_call_id": r.call_id, "content": r.content }))
            .collect()
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // NanoGPT adds context length and capabilities with `detailed=true`; for
        // subscription accounts the list is already limited to what the key can use.
        let url = if self.is_nanogpt() {
            format!("{}/models?detailed=true", self.base_url)
        } else {
            format!("{}/models", self.base_url)
        };
        let resp = self.get(url).send().await.map_err(|e| ProviderError::from_reqwest(&e))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }
        let v: Value = resp.json().await.map_err(|e| ProviderError::from_reqwest(&e))?;
        Ok(parse_models(&v))
    }
}
