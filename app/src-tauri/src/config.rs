//! Local, non-secret client configuration (identity, server URL, profiles).
//! API keys are never stored here — see `secrets.rs`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:8787/ws";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Groq, Ollama, LM Studio, ...).
    Openai,
    /// Anthropic Messages API.
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    pub label: String,
    pub provider: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub max_context_tokens: u32,
    #[serde(default)]
    pub temperature: Option<f64>,
    /// Ask the model for its reasoning and show it in the chat.
    #[serde(default = "yes")]
    pub show_reasoning: bool,
    /// "low" | "medium" | "high" | ... ; `None` leaves the provider default.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Off profiles can't reply, here or for the user's other devices.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum McpMode {
    /// Tools are not offered to the model.
    #[default]
    Off,
    /// The model may call tools, but each call waits for the sender's approval.
    Ask,
    /// Tool calls run without asking.
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    /// A local command speaking MCP over stdin/stdout.
    Stdio,
    /// A remote server speaking Streamable HTTP.
    Http,
}

/// When the app shows a system notification for a room's new messages.
/// A room without an entry in `notify_by_room` behaves as `Mentions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotifyMode {
    /// Every message from someone else, and finished AI replies.
    All,
    /// Only messages that @mention this user (the default), and AI replies
    /// answering this user's message.
    #[default]
    Mentions,
    /// Never notify.
    Off,
}

/// An MCP server the user added. Env vars and HTTP headers can hold secrets,
/// so they live in the keychain (`secrets::McpSecrets`), not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    /// Mode used in rooms where the user hasn't picked one.
    #[serde(default)]
    pub default_mode: McpMode,
    /// Share images this server returns (e.g. renders) with the room.
    #[serde(default)]
    pub share_images: bool,
    /// How long one tool call may run before it's abandoned.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
}

fn default_timeout() -> u32 {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub user_id: String,
    #[serde(default)]
    pub display_name: String,
    /// Stable id of this physical device, used for device linking.
    #[serde(default = "new_device_id")]
    pub device_id: String,
    /// The user_id this device had before linking to another device's account.
    /// Unlinking returns to it.
    #[serde(default)]
    pub linked_from: Option<String>,
    /// This device's own display name from before linking, restored on unlink.
    #[serde(default)]
    pub linked_from_name: Option<String>,
    #[serde(default = "default_server_url")]
    pub server_url: String,
    #[serde(default)]
    pub last_profile_by_room: HashMap<String, String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServer>,
    /// room id → server id → mode, overriding the server's default in that room.
    #[serde(default)]
    pub mcp_modes_by_room: HashMap<String, HashMap<String, McpMode>>,
    /// room id → which messages earn a system notification. Rooms without an
    /// entry use `NotifyMode::Mentions`.
    #[serde(default)]
    pub notify_by_room: HashMap<String, NotifyMode>,
    /// Port of the relay this app hosts (desktop only); `None` when not hosting.
    /// Hosting resumes on the next launch.
    #[serde(default)]
    pub host_relay_port: Option<u16>,
    /// Lets this user's other devices switch this device's MCP servers and profiles,
    /// and gives replies generated for them tools (every call approved first). Off
    /// until the user turns it on here: the commands arrive through the relay.
    #[serde(default)]
    pub remote_control: bool,
}

impl Config {
    /// The servers that are not off in `room_id`, with their effective mode.
    pub fn active_mcp(&self, room_id: &str) -> Vec<(McpServer, McpMode)> {
        let overrides = self.mcp_modes_by_room.get(room_id);
        self.mcp_servers
            .iter()
            .map(|s| {
                let mode = overrides.and_then(|o| o.get(&s.id)).copied().unwrap_or(s.default_mode);
                (s.clone(), mode)
            })
            .filter(|(_, m)| *m != McpMode::Off)
            .collect()
    }

    /// The servers a reply in `room_id` may use. A reply generated for another of this
    /// user's devices gets tools only with remote control on, and every call is approved
    /// first even on an Auto server: nobody may be at this computer, and a request
    /// arriving through the relay must not run anything unseen.
    pub fn mcp_for_reply(&self, room_id: &str, delegated: bool) -> Vec<(McpServer, McpMode)> {
        if !delegated {
            return self.active_mcp(room_id);
        }
        if !self.remote_control {
            return Vec::new();
        }
        self.active_mcp(room_id).into_iter().map(|(s, _)| (s, McpMode::Ask)).collect()
    }
}

fn default_server_url() -> String {
    DEFAULT_SERVER_URL.to_string()
}

fn new_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            user_id: uuid::Uuid::new_v4().to_string(),
            display_name: String::new(),
            device_id: new_device_id(),
            linked_from: None,
            linked_from_name: None,
            server_url: default_server_url(),
            last_profile_by_room: HashMap::new(),
            profiles: Vec::new(),
            mcp_servers: Vec::new(),
            mcp_modes_by_room: HashMap::new(),
            notify_by_room: HashMap::new(),
            host_relay_port: None,
            remote_control: false,
        }
    }
}

/// Name of this client instance. Set `MULTICHAT_INSTANCE` to run several clients
/// (each with its own identity and profiles) on one machine. Desktop only: mobile
/// apps have no environment variables and always use the default instance.
#[cfg(desktop)]
pub fn instance_name() -> String {
    let raw = std::env::var("MULTICHAT_INSTANCE").unwrap_or_default();
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if clean.is_empty() { "default".into() } else { clean }
}

#[cfg(mobile)]
pub fn instance_name() -> String {
    "default".into()
}

pub fn config_path(base: &Path) -> PathBuf {
    base.join("instances").join(instance_name()).join("config.json")
}

pub fn load(path: &Path) -> Config {
    let raw = std::fs::read_to_string(path).ok();
    let cfg = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Config>(s).ok());
    match cfg {
        Some(c) => {
            // A config written before device ids existed gets a fresh device_id
            // from serde's default; save it now so it stays this device's id.
            if !raw.as_deref().is_some_and(|s| s.contains("\"device_id\"")) {
                let _ = save(path, &c);
            }
            c
        }
        None => {
            let c = Config::default();
            let _ = save(path, &c);
            c
        }
    }
}

pub fn save(path: &Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, default_mode: McpMode) -> McpServer {
        McpServer {
            id: id.into(),
            name: id.into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://example.com/mcp".into(),
            default_mode,
            share_images: false,
            timeout_secs: 120,
        }
    }

    fn config() -> Config {
        let mut c = Config { mcp_servers: vec![server("auto", McpMode::Auto), server("off", McpMode::Off)], ..Config::default() };
        c.mcp_modes_by_room.insert("room".into(), HashMap::from([("off".to_string(), McpMode::Ask)]));
        c
    }

    fn modes(list: Vec<(McpServer, McpMode)>) -> Vec<(String, McpMode)> {
        list.into_iter().map(|(s, m)| (s.id, m)).collect()
    }

    #[test]
    fn a_reply_started_here_keeps_each_servers_mode() {
        assert_eq!(modes(config().mcp_for_reply("room", false)), [("auto".to_string(), McpMode::Auto), ("off".to_string(), McpMode::Ask)]);
    }

    #[test]
    fn a_delegated_reply_gets_no_tools_without_remote_control() {
        assert!(config().mcp_for_reply("room", true).is_empty());
    }

    #[test]
    fn a_delegated_reply_asks_for_every_call_even_on_auto() {
        let c = Config { remote_control: true, ..config() };
        assert_eq!(modes(c.mcp_for_reply("room", true)), [("auto".to_string(), McpMode::Ask), ("off".to_string(), McpMode::Ask)]);
        // A server that's off stays off.
        assert_eq!(modes(c.mcp_for_reply("other", true)), [("auto".to_string(), McpMode::Ask)]);
    }

    #[test]
    fn configs_from_before_this_setting_stay_locked_and_profiles_stay_on() {
        let c: Config = serde_json::from_str(r#"{"user_id":"u"}"#).unwrap();
        assert!(!c.remote_control);
        let p: Profile = serde_json::from_str(r#"{"label":"l","provider":"openai","base_url":"http://x","model":"m","max_context_tokens":1000}"#).unwrap();
        assert!(p.enabled);
    }
}
