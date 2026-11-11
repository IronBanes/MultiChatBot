//! MCP client side: connects to the user's MCP servers (stdio on desktop, or
//! Streamable HTTP on every platform), lists their tools and runs tool calls.
//! Everything runs on this machine; the relay only ever sees tool names and statuses.

use crate::config::{McpMode, McpServer, McpTransport};
use crate::providers::ToolSpec;
use crate::secrets::McpSecrets;
use rmcp::model::{CallToolRequestParams, ContentBlock, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
#[cfg(desktop)]
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESULT_CHARS: usize = 20_000;
/// Images taken from one tool result.
const MAX_IMAGES: usize = 4;
/// Image files a tool mentions are only picked up if they're this fresh and small.
const IMAGE_FILE_MAX_AGE: Duration = Duration::from_secs(15 * 60);
const IMAGE_FILE_MAX_BYTES: u64 = 25 * 1024 * 1024;

type Client = RunningService<RoleClient, ()>;

struct Connection {
    /// Config + secrets the connection was made with; a change forces a reconnect.
    fingerprint: String,
    client: Client,
    tools: Vec<Tool>,
}

#[derive(Default)]
pub struct McpManager {
    conns: Mutex<HashMap<String, Arc<Connection>>>,
}

/// An image produced by a tool call, base64-encoded.
#[derive(Debug, Clone)]
pub struct ToolImage {
    pub mime: String,
    pub data: String,
}

pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
    pub images: Vec<ToolImage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
}

/// A tool offered to the model in one generation.
#[derive(Debug, Clone)]
pub struct ActiveTool {
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub mode: McpMode,
    pub spec: ToolSpec,
}

fn fingerprint(server: &McpServer, secrets: &McpSecrets) -> String {
    serde_json::to_string(&(server.transport, &server.command, &server.args, &server.url, secrets.env.iter().collect::<Vec<_>>(), secrets.headers.iter().collect::<Vec<_>>()))
        .unwrap_or_default()
}

/// Tool names must match `^[a-zA-Z0-9_-]{1,64}$` for both OpenAI and Anthropic.
fn qualified_name(server: &str, tool: &str, taken: &HashMap<String, ()>) -> String {
    let clean = |s: &str| -> String {
        s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
    };
    let base: String = format!("{}__{}", clean(server), clean(tool)).chars().take(60).collect();
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains_key(&name) {
        name = format!("{}_{n}", base.chars().take(57).collect::<String>());
        n += 1;
    }
    name
}

/// Builds the child process for a stdio server. Desktop only: iOS and Android
/// cannot spawn child processes.
#[cfg(desktop)]
fn stdio_command(server: &McpServer, secrets: &McpSecrets) -> tokio::process::Command {
    // On Windows, `npx`, `uvx` etc. are .cmd shims that only a shell can resolve.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&server.command);
        // CREATE_NO_WINDOW: don't flash a console window for each server.
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new(&server.command);
    cmd.args(&server.args);
    cmd.envs(&secrets.env);
    cmd.kill_on_drop(true);
    cmd
}

async fn connect(server: &McpServer, secrets: &McpSecrets) -> Result<Connection, String> {
    let client: Client = match server.transport {
        // stdio servers spawn a local command, which mobile OSes forbid.
        #[cfg(desktop)]
        McpTransport::Stdio => {
            if server.command.trim().is_empty() {
                return Err("No command set".into());
            }
            let (transport, _stderr) = TokioChildProcess::builder(stdio_command(server, secrets))
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("Could not start `{}`: {e}", server.command))?;
            ().serve(transport).await.map_err(|e| format!("MCP handshake failed: {e}"))?
        }
        #[cfg(mobile)]
        McpTransport::Stdio => {
            return Err(
                "Local command (stdio) MCP servers run on the desktop app only. Add the server as a Remote URL instead.".into(),
            );
        }
        McpTransport::Http => {
            if !(server.url.starts_with("http://") || server.url.starts_with("https://")) {
                return Err("URL must start with http:// or https://".into());
            }
            // Headers usually carry tokens; on a phone, don't send them over plain HTTP.
            #[cfg(mobile)]
            if server.url.starts_with("http://") && !secrets.headers.is_empty() {
                return Err("HTTPS is required for MCP servers with headers (they often hold tokens).".into());
            }
            let mut headers = HashMap::new();
            for (k, v) in &secrets.headers {
                let name = reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("Invalid header name `{k}`"))?;
                let value = reqwest::header::HeaderValue::from_str(v).map_err(|_| format!("Invalid value for header `{k}`"))?;
                headers.insert(name, value);
            }
            let config = StreamableHttpClientTransportConfig::with_uri(server.url.clone()).custom_headers(headers);
            let transport = StreamableHttpClientTransport::from_config(config);
            // Never echo the URL in errors; it may carry tokens.
            ().serve(transport).await.map_err(|e| format!("Could not connect to the MCP server: {}", short(&e.to_string(), &server.url)))?
        }
    };
    let tools = client.list_all_tools().await.map_err(|e| format!("Could not list tools: {e}"))?;
    Ok(Connection { fingerprint: fingerprint(server, secrets), client, tools })
}

fn short(msg: &str, url: &str) -> String {
    let s = if url.is_empty() { msg.to_string() } else { msg.replace(url, "[url]") };
    s.chars().take(200).collect()
}

impl McpManager {
    /// Returns a live connection, (re)connecting if needed.
    async fn get(&self, server: &McpServer, secrets: &McpSecrets) -> Result<Arc<Connection>, String> {
        let fp = fingerprint(server, secrets);
        if let Some(c) = self.conns.lock().await.get(&server.id)
            && c.fingerprint == fp && !c.client.is_transport_closed()
        {
            return Ok(c.clone());
        }
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, connect(server, secrets))
            .await
            .map_err(|_| format!("Timed out connecting to {}", server.name))??;
        let conn = Arc::new(conn);
        if let Some(old) = self.conns.lock().await.insert(server.id.clone(), conn.clone()) {
            drop(old); // the child process is killed when the last handle goes away
        }
        Ok(conn)
    }

    /// Connects (or reconnects) and lists the server's tools.
    pub async fn test(&self, server: &McpServer, secrets: &McpSecrets) -> Result<Vec<ToolInfo>, String> {
        self.disconnect(&server.id).await;
        let conn = self.get(server, secrets).await?;
        Ok(conn
            .tools
            .iter()
            .map(|t| ToolInfo {
                name: t.name.to_string(),
                description: t.description.as_deref().unwrap_or_default().to_string(),
            })
            .collect())
    }

    pub async fn disconnect(&self, server_id: &str) {
        self.conns.lock().await.remove(server_id);
    }

    /// Tools from every active server. Servers that fail to connect are skipped
    /// and reported in the second value.
    pub async fn tools_for(&self, servers: &[(McpServer, McpMode, McpSecrets)]) -> (Vec<ActiveTool>, Vec<String>) {
        let mut tools = Vec::new();
        let mut errors = Vec::new();
        let mut taken = HashMap::new();
        for (server, mode, secrets) in servers {
            match self.get(server, secrets).await {
                Ok(conn) => {
                    for t in &conn.tools {
                        let name = qualified_name(&server.name, &t.name, &taken);
                        taken.insert(name.clone(), ());
                        tools.push(ActiveTool {
                            server_id: server.id.clone(),
                            server_name: server.name.clone(),
                            tool: t.name.to_string(),
                            mode: *mode,
                            spec: ToolSpec {
                                name,
                                description: t.description.as_deref().unwrap_or_default().to_string(),
                                schema: serde_json::Value::Object((*t.input_schema).clone()),
                            },
                        });
                    }
                }
                Err(e) => errors.push(format!("{}: {e}", server.name)),
            }
        }
        (tools, errors)
    }

    /// Runs a tool. Images are collected only if the server is set to share them:
    /// image content blocks, plus fresh image files the result text points to
    /// (how ComfyUI-style servers report their outputs).
    pub async fn call(&self, server: &McpServer, secrets: &McpSecrets, tool: &str, args: serde_json::Value) -> ToolOutput {
        let fail = |text: String| ToolOutput { text, is_error: true, images: Vec::new() };
        let conn = match self.get(server, secrets).await {
            Ok(c) => c,
            Err(e) => return fail(e),
        };
        let mut params = CallToolRequestParams::new(tool.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map);
        }
        let timeout = Duration::from_secs(u64::from(server.timeout_secs.clamp(5, 3600)));
        let res = match tokio::time::timeout(timeout, conn.client.call_tool(params)).await {
            Err(_) => return fail(format!("Tool call timed out after {}s", timeout.as_secs())),
            Ok(Err(e)) => return fail(format!("Tool call failed: {e}")),
            Ok(Ok(r)) => r,
        };
        let mut images = Vec::new();
        let mut parts: Vec<String> = Vec::new();
        for c in &res.content {
            match c {
                ContentBlock::Text(t) => parts.push(t.text.clone()),
                ContentBlock::Image(img) => {
                    if server.share_images && images.len() < MAX_IMAGES {
                        images.push(ToolImage { mime: img.mime_type.clone(), data: img.data.clone() });
                        parts.push("[image shared with the room]".into());
                    } else {
                        parts.push("[image omitted]".into());
                    }
                }
                ContentBlock::Audio(_) => parts.push("[audio omitted]".into()),
                ContentBlock::Resource(r) => parts.push(serde_json::to_string(r).unwrap_or_default()),
                ContentBlock::ResourceLink(r) => parts.push(serde_json::to_string(r).unwrap_or_default()),
                _ => parts.push("[unsupported content omitted]".into()),
            }
        }
        if parts.is_empty()
            && let Some(s) = &res.structured_content
        {
            parts.push(s.to_string());
        }
        let mut text = parts.join("\n");
        if server.share_images && images.len() < MAX_IMAGES {
            let mut scan = text.clone();
            if let Some(s) = &res.structured_content {
                scan.push('\n');
                scan.push_str(&s.to_string());
            }
            for path in image_paths(&scan) {
                if images.len() >= MAX_IMAGES {
                    break;
                }
                if let Some(img) = read_fresh_image(&path).await
                    && !images.iter().any(|i| i.data == img.data)
                {
                    images.push(img);
                }
            }
        }
        if text.chars().count() > MAX_RESULT_CHARS {
            text = text.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n[truncated]";
        }
        ToolOutput { text, is_error: res.is_error.unwrap_or(false), images }
    }
}

fn image_mime(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    [(".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".webp", "image/webp"), (".gif", "image/gif")]
        .into_iter()
        .find(|(ext, _)| lower.ends_with(ext))
        .map(|(_, m)| m)
}

/// Absolute paths to image files mentioned in a tool result (also inside JSON strings,
/// where Windows backslashes arrive doubled).
fn image_paths(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // The first split keeps quoted paths that contain spaces; the second finds bare ones in prose.
    let quoted = ['"', '\'', '\n', '`', '<', '>'];
    let bare = ['"', '\'', '\n', '`', '<', '>', '(', ')', ' ', ','];
    let pieces = text.split(|c: char| quoted.contains(&c)).chain(text.split(|c: char| bare.contains(&c)));
    for raw in pieces {
        let cand = raw.trim().trim_end_matches(['.', ';', ':']).replace("\\\\", "\\");
        let b = cand.as_bytes();
        let absolute = cand.starts_with('/') || (b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'));
        if absolute && image_mime(&cand).is_some() && !out.contains(&cand) {
            out.push(cand);
        }
    }
    out
}

async fn read_fresh_image(path: &str) -> Option<ToolImage> {
    use base64::Engine;
    let mime = image_mime(path)?;
    let meta = tokio::fs::metadata(path).await.ok()?;
    let fresh = meta.modified().ok()?.elapsed().map(|age| age <= IMAGE_FILE_MAX_AGE).unwrap_or(true);
    if !meta.is_file() || !fresh || meta.len() > IMAGE_FILE_MAX_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(ToolImage { mime: mime.to_string(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_names_are_valid_and_unique() {
        let mut taken = HashMap::new();
        let a = qualified_name("My Files!", "read.file", &taken);
        assert_eq!(a, "My_Files___read_file");
        taken.insert(a.clone(), ());
        let b = qualified_name("My Files!", "read.file", &taken);
        assert_ne!(a, b);
        let long = qualified_name(&"s".repeat(80), &"t".repeat(80), &HashMap::new());
        assert!(long.len() <= 64);
    }

    #[test]
    fn finds_image_paths_in_text_and_json() {
        let text = r#"Saved to C:\out\ComfyUI_0001_.png and {"files":["C:\\My Renders\\a.webp","/tmp/render.webp"]}. Also notes.txt and C:/x/y.JPG."#;
        let paths = image_paths(text);
        for want in [r"C:\out\ComfyUI_0001_.png", r"C:\My Renders\a.webp", "/tmp/render.webp", "C:/x/y.JPG"] {
            assert!(paths.iter().any(|p| p == want), "missing {want} in {paths:?}");
        }
        assert!(!paths.iter().any(|p| p.contains("notes")));
    }
}
