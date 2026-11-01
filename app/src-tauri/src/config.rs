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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub user_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_server_url")]
    pub server_url: String,
    #[serde(default)]
    pub last_profile_by_room: HashMap<String, String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

fn default_server_url() -> String {
    DEFAULT_SERVER_URL.to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            user_id: uuid::Uuid::new_v4().to_string(),
            display_name: String::new(),
            server_url: default_server_url(),
            last_profile_by_room: HashMap::new(),
            profiles: Vec::new(),
        }
    }
}

/// Name of this client instance. Set `MULTICHAT_INSTANCE` to run several clients
/// (each with its own identity and profiles) on one machine.
pub fn instance_name() -> String {
    let raw = std::env::var("MULTICHAT_INSTANCE").unwrap_or_default();
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if clean.is_empty() { "default".into() } else { clean }
}

pub fn config_path(base: &Path) -> PathBuf {
    base.join("instances").join(instance_name()).join("config.json")
}

pub fn load(path: &Path) -> Config {
    let cfg = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok());
    match cfg {
        Some(c) => c,
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
