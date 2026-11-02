//! MCP client side: connects to the user's MCP servers (stdio or Streamable HTTP),
//! lists their tools and runs tool calls. Everything runs on this machine; the
//! relay only ever sees tool names and statuses.

use crate::config::{McpMode, McpServer, McpTransport};
use crate::providers::ToolSpec;
use crate::secrets::McpSecrets;
use rmcp::model::{CallToolRequestParams, ContentBlock, Tool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESULT_CHARS: usize = 20_000;

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
        McpTransport::Http => {
            if !(server.url.starts_with("http://") || server.url.starts_with("https://")) {
                return Err("URL must start with http:// or https://".into());
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
        if let Some(c) = self.conns.lock().await.get(&server.id) {
            if c.fingerprint == fp && !c.client.is_transport_closed() {
                return Ok(c.clone());
            }
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

    /// Runs a tool. Returns (text result, is_error).
    pub async fn call(&self, server: &McpServer, secrets: &McpSecrets, tool: &str, args: serde_json::Value) -> (String, bool) {
        let conn = match self.get(server, secrets).await {
            Ok(c) => c,
            Err(e) => return (e, true),
        };
        let mut params = CallToolRequestParams::new(tool.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map);
        }
        let res = match tokio::time::timeout(CALL_TIMEOUT, conn.client.call_tool(params)).await {
            Err(_) => return ("Tool call timed out".into(), true),
            Ok(Err(e)) => return (format!("Tool call failed: {e}"), true),
            Ok(Ok(r)) => r,
        };
        let mut parts: Vec<String> = res
            .content
            .iter()
            .map(|c| match c {
                ContentBlock::Text(t) => t.text.clone(),
                ContentBlock::Image(_) => "[image omitted]".into(),
                ContentBlock::Audio(_) => "[audio omitted]".into(),
                ContentBlock::Resource(r) => serde_json::to_string(r).unwrap_or_default(),
                ContentBlock::ResourceLink(r) => serde_json::to_string(r).unwrap_or_default(),
                _ => "[unsupported content omitted]".into(),
            })
            .collect();
        if parts.is_empty() {
            if let Some(s) = &res.structured_content {
                parts.push(s.to_string());
            }
        }
        let mut text = parts.join("\n");
        if text.chars().count() > MAX_RESULT_CHARS {
            text = text.chars().take(MAX_RESULT_CHARS).collect::<String>() + "\n[truncated]";
        }
        (text, res.is_error.unwrap_or(false))
    }
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
}
