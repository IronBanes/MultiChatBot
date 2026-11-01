//! OpenAI-compatible Chat Completions (`POST {base}/chat/completions`, SSE).

use super::{ChatRequest, DeltaStream, Provider, ProviderError, http_error, sse_data};
use crate::context::Role;
use futures_util::StreamExt;
use serde_json::{Value, json};

pub struct OpenAiCompatible {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[async_trait::async_trait]
impl Provider for OpenAiCompatible {
    async fn stream_chat(&self, req: &ChatRequest) -> Result<DeltaStream, ProviderError> {
        let mut messages = vec![json!({ "role": "system", "content": req.system })];
        messages.extend(req.messages.iter().map(|m| {
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            json!({ "role": role, "content": m.content })
        }));
        let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }

        let mut http = self.http.post(format!("{}/chat/completions", self.base_url)).json(&body);
        if let Some(key) = &self.api_key {
            http = http.bearer_auth(key);
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
                if payload == "[DONE]" {
                    return;
                }
                let Ok(v) = serde_json::from_str::<Value>(&payload) else { continue };
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(Value::as_str).unwrap_or("Provider returned an error");
                    yield Err(ProviderError::new(msg));
                    return;
                }
                if let Some(text) = v.pointer("/choices/0/delta/content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        yield Ok(text.to_string());
                    }
                }
            }
        }))
    }
}
