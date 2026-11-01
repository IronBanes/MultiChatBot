//! LLM providers. Adding a provider = implementing [`Provider`] and adding a
//! `ProviderKind` variant wired up in [`for_profile`].

mod anthropic;
mod openai;

use crate::config::{Profile, ProviderKind};
use crate::context::ChatMessage;
use futures_util::{Stream, StreamExt};
use std::pin::Pin;

pub struct ChatRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub max_output_tokens: u32,
    pub temperature: Option<f64>,
}

/// A user-facing, already-short error. Must never contain the key or endpoint
/// (callers additionally run [`sanitize`] before it leaves the machine).
#[derive(Debug, Clone)]
pub struct ProviderError(pub String);

impl ProviderError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }

    /// Never use reqwest's Display: it includes the request URL.
    pub fn from_reqwest(e: &reqwest::Error) -> Self {
        let msg = if e.is_timeout() {
            "Request to the provider timed out"
        } else if e.is_connect() {
            "Could not connect to the provider"
        } else if e.is_body() || e.is_decode() {
            "Connection to the provider dropped mid-response"
        } else if e.is_request() {
            "Could not send the request to the provider"
        } else {
            "Network error talking to the provider"
        };
        Self::new(msg)
    }
}

pub type DeltaStream = Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>;

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Starts a streaming completion. Resolves once response headers arrive;
    /// the stream then yields text deltas.
    async fn stream_chat(&self, req: &ChatRequest) -> Result<DeltaStream, ProviderError>;
}

pub fn for_profile(profile: &Profile, api_key: Option<String>, http: reqwest::Client) -> Box<dyn Provider> {
    let base_url = profile.base_url.trim().trim_end_matches('/').to_string();
    let api_key = api_key.filter(|k| !k.trim().is_empty());
    match profile.provider {
        ProviderKind::Openai => Box::new(openai::OpenAiCompatible { http, base_url, api_key }),
        ProviderKind::Anthropic => Box::new(anthropic::Anthropic { http, base_url, api_key }),
    }
}

/// Builds a short error from a non-2xx response, using the provider's own message when present.
pub(crate) async fn http_error(resp: reqwest::Response) -> ProviderError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| {
        let e = v.get("error").unwrap_or(&v);
        e.get("message")
            .and_then(|m| m.as_str())
            .or_else(|| e.as_str())
            .map(str::to_string)
    });
    let reason = status.canonical_reason().unwrap_or("error");
    match detail {
        Some(d) if !d.trim().is_empty() => ProviderError(format!("HTTP {}: {}", status.as_u16(), d.trim())),
        _ => ProviderError(format!("HTTP {} {}", status.as_u16(), reason)),
    }
}

/// Yields the payload of each `data:` line of a server-sent-events response.
pub(crate) fn sse_data(resp: reqwest::Response) -> impl Stream<Item = Result<String, ProviderError>> + Send {
    async_stream::stream! {
        let mut bytes = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(c) => buf.extend_from_slice(&c),
                Err(e) => { yield Err(ProviderError::from_reqwest(&e)); return; }
            }
            // '\n' never occurs inside a multi-byte UTF-8 sequence, so splitting bytes is safe.
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches(['\r', '\n']);
                if let Some(data) = line.strip_prefix("data:") {
                    yield Ok(data.trim_start().to_string());
                }
            }
        }
        let rest = String::from_utf8_lossy(&buf);
        if let Some(data) = rest.trim().strip_prefix("data:") {
            yield Ok(data.trim_start().to_string());
        }
    }
}

/// Final scrub before an error is shown or broadcast: removes the key, the
/// endpoint, anything key-shaped or URL-shaped, and caps the length.
pub fn sanitize(msg: &str, api_key: Option<&str>, base_url: &str) -> String {
    let mut s = msg.to_string();
    if let Some(k) = api_key.map(str::trim).filter(|k| k.len() >= 6) {
        s = s.replace(k, "[redacted]");
        // Providers sometimes echo a prefix/suffix of the key.
        if k.len() >= 20 {
            for part in [k.get(..8), k.get(k.len() - 4..)].into_iter().flatten() {
                s = s.replace(part, "[redacted]");
            }
        }
    }
    let base = base_url.trim().trim_end_matches('/');
    if !base.is_empty() {
        s = s.replace(base, "[endpoint]");
        if let Ok(u) = reqwest::Url::parse(base) {
            if let Some(host) = u.host_str() {
                s = s.replace(host, "[endpoint]");
            }
        }
    }
    let words: Vec<String> = s
        .split(' ')
        .map(|w| {
            let lower = w.to_ascii_lowercase();
            if lower.contains("://") {
                "[url]".to_string()
            } else if lower.contains("sk-") || w.contains("***") || lower.starts_with("bearer") {
                "[redacted]".to_string()
            } else {
                w.to_string()
            }
        })
        .collect();
    let s = words.join(" ");
    let mut out: String = s.chars().take(240).collect();
    if s.chars().count() > 240 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitize_removes_secrets() {
        let out = sanitize(
            "Incorrect API key provided: sk-abc123***wxyz at https://api.example.com/v1/chat (api.example.com)",
            Some("sk-abc123secretwxyz"),
            "https://api.example.com/v1",
        );
        assert!(!out.contains("abc123"), "{out}");
        assert!(!out.contains("wxyz"), "{out}");
        assert!(!out.contains("example.com"), "{out}");
    }

    #[test]
    fn sanitize_truncates() {
        assert!(sanitize(&"a".repeat(1000), None, "").chars().count() <= 241);
    }
}
