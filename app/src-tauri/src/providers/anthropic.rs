//! Anthropic Messages API (`POST {base}/v1/messages`, SSE).

use super::{ChatRequest, DeltaStream, Provider, ProviderError, http_error, sse_data};
use crate::context::Role;
use futures_util::StreamExt;
use serde_json::{Value, json};

/// API version 2026-10-21 rejects `temperature`/`top_p`/`top_k` on every model,
/// so a profile's temperature is not sent to Anthropic.
const API_VERSION: &str = "2026-10-21";

pub struct Anthropic {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

impl Anthropic {
    fn endpoint(&self) -> String {
        if self.base_url.ends_with("/v1") {
            format!("{}/messages", self.base_url)
        } else {
            format!("{}/v1/messages", self.base_url)
        }
    }
}

#[async_trait::async_trait]
impl Provider for Anthropic {
    async fn stream_chat(&self, req: &ChatRequest) -> Result<DeltaStream, ProviderError> {
        let messages: Vec<Value> = req
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
        let body = json!({
            "model": req.model,
            "max_tokens": req.max_output_tokens,
            "system": req.system,
            "messages": messages,
            "stream": true,
        });

        let mut http = self
            .http
            .post(self.endpoint())
            .header("anthropic-version", API_VERSION)
            .json(&body);
        if let Some(key) = &self.api_key {
            http = http.header("x-api-key", key);
        }
        let resp = http.send().await.map_err(|e| ProviderError::from_reqwest(&e))?;
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }

        let mut data = Box::pin(sse_data(resp));
        Ok(Box::pin(async_stream::stream! {
            while let Some(item) = data.next().await {
                let payload = match item {
                    Ok(p) => p,
                    Err(e) => { yield Err(e); return; }
                };
                let Ok(v) = serde_json::from_str::<Value>(&payload) else { continue };
                match v.get("type").and_then(Value::as_str) {
                    Some("content_block_delta") => {
                        if v.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                            if let Some(t) = v.pointer("/delta/text").and_then(Value::as_str) {
                                yield Ok(t.to_string());
                            }
                        }
                    }
                    Some("message_delta") => {
                        if v.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("refusal") {
                            yield Err(ProviderError::new("The model declined to respond"));
                            return;
                        }
                    }
                    Some("error") => {
                        let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("Provider stream error");
                        yield Err(ProviderError::new(msg));
                        return;
                    }
                    Some("message_stop") => return,
                    _ => {}
                }
            }
        }))
    }
}
