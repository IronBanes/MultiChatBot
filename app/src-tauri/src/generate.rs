//! One AI reply: streams text and reasoning (batched ~100ms), runs MCP tool rounds
//! (asking the sender first in `Ask` mode), and ends with exactly one `done` or
//! `error` event.

use crate::config::{McpMode, McpServer};
use crate::mcp;
use crate::mcp::{ActiveTool, McpManager};
use crate::providers::{ChatRequest, Provider, ProviderError, StreamEvent, ToolResult};
use crate::secrets::McpSecrets;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::oneshot;

const FLUSH_EVERY: Duration = Duration::from_millis(100);
/// Tool rounds before tools are withdrawn and the model must answer.
const MAX_TOOL_ROUNDS: usize = 8;
/// How long any approval (local or lent) waits before it counts as denied.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    AwaitingApproval,
    Running,
    Done,
    Error,
    Denied,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum GenEvent {
    Delta { text: String },
    Reasoning { text: String },
    /// The room's new shared summary, covering messages up to `upto_seq`. The
    /// webview stores it with the relay, so every member's AI uses it.
    Summary { text: String, upto_seq: i64 },
    /// Tool activity. `args` and `detail` are for the sender's eyes only.
    Tool { call_id: String, server: String, tool: String, status: ToolStatus, args: Option<String>, detail: Option<String> },
    /// The model called a tool borrowed from a room member: the webview sends
    /// `call_lent_tool` with `call_id` and waits for the answer.
    LentCall { call_id: String, device_id: String, server_id: String, tool: String, args: serde_json::Value },
    /// An image a tool produced, to share with the room (base64).
    Image { call_id: String, mime: String, data: String },
    /// Something the sender should know that doesn't fail the reply.
    Notice { message: String },
    Done { content: String, stopped: bool },
    Error { message: String, partial: String },
}

/// Pending approvals: "<message id>:<call id>" → answer.
pub type Approvals = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

/// A tool borrowed from a room member, as `generate` receives it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LentToolSpec {
    pub device_id: String,
    pub owner_name: String,
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub description: String,
    pub schema: serde_json::Value,
}

/// The lender's answer to a borrowed tool call (from the webview).
#[derive(Debug, Clone)]
pub struct LentResult {
    pub content: String,
    pub is_error: bool,
    pub images: Vec<crate::mcp::ToolImage>,
}

/// Lent tool results: "<message id>:<call id>" → answer from the lender.
pub type LentResults = Arc<Mutex<HashMap<String, oneshot::Sender<LentResult>>>>;

/// How long a lent call may wait for its answer.
const LENT_CALL_TIMEOUT: Duration = Duration::from_secs(11 * 60);

pub struct Job {
    pub id: String,
    pub provider: Box<dyn Provider>,
    pub req: ChatRequest,
    pub servers: Vec<(McpServer, McpMode, McpSecrets)>,
    /// Tools borrowed from room members (ignored for delegated replies).
    pub lent_tools: Vec<LentToolSpec>,
    pub mcp: Arc<McpManager>,
    pub approvals: Approvals,
    /// Answers from room members to borrowed tool calls.
    pub lent_results: LentResults,
    pub scrub: Box<dyn Fn(ProviderError) -> String + Send + Sync>,
    pub events: Channel<GenEvent>,
    pub stop: oneshot::Receiver<()>,
}

/// Text and reasoning waiting for the next flush.
#[derive(Default)]
struct Pending {
    text: String,
    reasoning: String,
}

impl Pending {
    fn flush(&mut self, events: &Channel<GenEvent>) {
        if !self.reasoning.is_empty() {
            let _ = events.send(GenEvent::Reasoning { text: std::mem::take(&mut self.reasoning) });
        }
        if !self.text.is_empty() {
            let _ = events.send(GenEvent::Delta { text: std::mem::take(&mut self.text) });
        }
    }
}

enum Outcome {
    Finished,
    Stopped,
}

pub async fn run(job: Job) {
    let Job {
        id,
        provider,
        mut req,
        servers,
        lent_tools,
        mcp,
        approvals,
        lent_results,
        scrub,
        events,
        mut stop,
    } = job;
    let mut full = String::new();
    let mut pending = Pending::default();

    let outcome: Result<Outcome, String> = async {
        let tools: Vec<ActiveTool> = if servers.is_empty() {
            Vec::new()
        } else {
            let (tools, errors) = tokio::select! {
                _ = &mut stop => return Ok(Outcome::Stopped),
                r = mcp.tools_for(&servers) => r,
            };
            for e in errors {
                let _ = events.send(GenEvent::Notice { message: format!("MCP server unavailable — {e}") });
            }
            tools
        };
        // Borrowed tools join the local ones, named with the same rules so
        // names stay unique and valid for both providers. They're appended
        // after the local tools.
        let mut taken = tools.iter().map(|t| (t.spec.name.clone(), ())).collect::<HashMap<_, _>>();
        let mut lent_specs: Vec<(LentToolSpec, String)> = Vec::new();
        for t in &lent_tools {
            let name = mcp::qualified_name(&format!("{} {}", t.owner_name, t.server_name), &t.tool, &taken);
            taken.insert(name.clone(), ());
            lent_specs.push((t.clone(), name));
        }
        req.tools = tools.iter().map(|t| t.spec.clone()).collect();
        req.tools.extend(lent_specs.iter().map(|(t, name)| crate::providers::ToolSpec {
            name: name.clone(),
            description: format!("[on {}'s computer] {}", t.owner_name, t.description),
            schema: t.schema.clone(),
        }));

        let mut rounds = 0;
        loop {
            let mut stream = tokio::select! {
                _ = &mut stop => return Ok(Outcome::Stopped),
                s = provider.stream_chat(&req) => s.map_err(&scrub)?,
            };
            // Separate text from different tool rounds.
            let mut needs_separator = !full.is_empty();
            let mut tool_round = None;
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = &mut stop => return Ok(Outcome::Stopped),
                    item = stream.next() => match item {
                        Some(Ok(StreamEvent::Text(t))) => {
                            if needs_separator && !t.trim().is_empty() {
                                full.push_str("\n\n");
                                pending.text.push_str("\n\n");
                                needs_separator = false;
                            }
                            full.push_str(&t);
                            pending.text.push_str(&t);
                        }
                        Some(Ok(StreamEvent::Reasoning(r))) => pending.reasoning.push_str(&r),
                        Some(Ok(StreamEvent::ToolCalls { calls, assistant })) => tool_round = Some((calls, assistant)),
                        Some(Err(e)) => return Err(scrub(e)),
                        None => break,
                    },
                    _ = tick.tick() => pending.flush(&events),
                }
            }
            pending.flush(&events);

            let Some((calls, assistant)) = tool_round else { return Ok(Outcome::Finished) };
            let mut results = Vec::with_capacity(calls.len());
            for call in calls {
                // A borrowed tool: ask the owner's computer, and wait here for
                // its answer (the webview shuttles the frames through the relay).
                if let Some((spec, _)) = lent_specs.iter().find(|(_, name)| *name == call.name) {
                    let args = call.arguments.clone();
                    let _ = events.send(GenEvent::Tool {
                        call_id: call.id.clone(),
                        server: spec.server_name.clone(),
                        tool: spec.tool.clone(),
                        status: ToolStatus::AwaitingApproval,
                        args: Some(serde_json::to_string_pretty(&args).unwrap_or_default()),
                        detail: Some(format!("Waiting for {}", spec.owner_name)),
                    });
                    let _ = events.send(GenEvent::LentCall {
                        call_id: call.id.clone(),
                        device_id: spec.device_id.clone(),
                        server_id: spec.server_id.clone(),
                        tool: spec.tool.clone(),
                        args,
                    });
                    let key = format!("{id}:{}", call.id);
                    let (tx, rx) = oneshot::channel();
                    if let Ok(mut waiting) = lent_results.lock() {
                        waiting.insert(key.clone(), tx);
                    }
                    let answer = tokio::select! {
                        _ = &mut stop => {
                            if let Ok(mut waiting) = lent_results.lock() { waiting.remove(&key); }
                            return Ok(Outcome::Stopped);
                        }
                        r = rx => r.ok(),
                        _ = tokio::time::sleep(LENT_CALL_TIMEOUT) => None,
                    };
                    if let Ok(mut waiting) = lent_results.lock() {
                        waiting.remove(&key);
                    }
                    let Some(out) = answer else {
                        let _ = events.send(GenEvent::Tool {
                            call_id: call.id.clone(),
                            server: spec.server_name.clone(),
                            tool: spec.tool.clone(),
                            status: ToolStatus::Error,
                            args: None,
                            detail: Some(format!("{} didn't answer in time.", spec.owner_name)),
                        });
                        results.push(ToolResult {
                            call_id: call.id.clone(),
                            content: format!("{} didn't answer in time.", spec.owner_name),
                            is_error: true,
                        });
                        continue;
                    };
                    for img in out.images {
                        let _ = events.send(GenEvent::Image { call_id: call.id.clone(), mime: img.mime, data: img.data });
                    }
                    let preview: String = out.content.chars().take(600).collect();
                    let _ = events.send(GenEvent::Tool {
                        call_id: call.id.clone(),
                        server: spec.server_name.clone(),
                        tool: spec.tool.clone(),
                        status: if out.is_error { ToolStatus::Error } else { ToolStatus::Done },
                        args: None,
                        detail: Some(preview),
                    });
                    results.push(ToolResult { call_id: call.id.clone(), content: out.content, is_error: out.is_error });
                    continue;
                }
                let Some(tool) = tools.iter().find(|t| t.spec.name == call.name) else {
                    results.push(ToolResult { call_id: call.id, content: format!("Unknown tool `{}`", call.name), is_error: true });
                    continue;
                };
                let Some((server, _, secrets)) = servers.iter().find(|(s, _, _)| s.id == tool.server_id) else { continue };
                let args = serde_json::to_string_pretty(&call.arguments).unwrap_or_default();
                let send = |status: ToolStatus, args: Option<String>, detail: Option<String>| {
                    let _ = events.send(GenEvent::Tool {
                        call_id: call.id.clone(),
                        server: tool.server_name.clone(),
                        tool: tool.tool.clone(),
                        status,
                        args,
                        detail,
                    });
                };

                if tool.mode == McpMode::Ask {
                    send(ToolStatus::AwaitingApproval, Some(args.clone()), None);
                    let key = format!("{id}:{}", call.id);
                    let (tx, rx) = oneshot::channel();
                    if let Ok(mut a) = approvals.lock() {
                        a.insert(key.clone(), tx);
                    }
                    let approved = tokio::select! {
                        _ = &mut stop => {
                            if let Ok(mut a) = approvals.lock() { a.remove(&key); }
                            return Ok(Outcome::Stopped);
                        }
                        r = rx => r.unwrap_or(false),
                        _ = tokio::time::sleep(APPROVAL_TIMEOUT) => false,
                    };
                    if let Ok(mut a) = approvals.lock() {
                        a.remove(&key);
                    }
                    if !approved {
                        send(ToolStatus::Denied, None, None);
                        results.push(ToolResult {
                            call_id: call.id.clone(),
                            content: "The user declined to run this tool.".into(),
                            is_error: true,
                        });
                        continue;
                    }
                }

                send(ToolStatus::Running, Some(args), None);
                let out = tokio::select! {
                    _ = &mut stop => return Ok(Outcome::Stopped),
                    r = mcp.call(server, secrets, &tool.tool, call.arguments.clone()) => r,
                };
                let preview: String = out.text.chars().take(600).collect();
                for img in out.images {
                    let _ = events.send(GenEvent::Image { call_id: call.id.clone(), mime: img.mime, data: img.data });
                }
                send(if out.is_error { ToolStatus::Error } else { ToolStatus::Done }, None, Some(preview));
                results.push(ToolResult { call_id: call.id.clone(), content: out.text, is_error: out.is_error });
            }

            req.continuation.push(assistant);
            req.continuation.extend(provider.tool_results(&results));
            rounds += 1;
            if rounds >= MAX_TOOL_ROUNDS {
                // Make the model wrap up instead of looping on tools. The tool
                // definitions stay, since the history now contains tool calls.
                req.allow_tool_calls = false;
            }
        }
    }
    .await;

    pending.flush(&events);
    let event = match outcome {
        Ok(Outcome::Stopped) => GenEvent::Done { content: full, stopped: true },
        Ok(Outcome::Finished) if !full.trim().is_empty() => GenEvent::Done { content: full, stopped: false },
        Ok(Outcome::Finished) => GenEvent::Error { message: "The model returned an empty response".into(), partial: full },
        Err(message) => GenEvent::Error { message, partial: full },
    };
    let _ = events.send(event);
}
