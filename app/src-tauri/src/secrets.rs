//! Secrets live in the OS keychain (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux): API keys keyed by profile id, and MCP server
//! env vars / headers keyed by server id.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SERVICE: &str = "multichat-bot";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("Keychain unavailable: {e}"))
}

fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read from keychain: {e}")),
    }
}

fn set(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|e| format!("Could not store in keychain: {e}"))
}

fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete from keychain: {e}")),
    }
}

pub fn get_key(profile_id: &str) -> Result<Option<String>, String> {
    get(&format!("profile:{profile_id}"))
}

pub fn set_key(profile_id: &str, key: &str) -> Result<(), String> {
    set(&format!("profile:{profile_id}"), key)
}

pub fn delete_key(profile_id: &str) -> Result<(), String> {
    delete(&format!("profile:{profile_id}"))
}

/// Env vars (stdio servers) and HTTP headers (remote servers) for an MCP server.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpSecrets {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

pub fn get_mcp(server_id: &str) -> Result<McpSecrets, String> {
    Ok(get(&format!("mcp:{server_id}"))?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

pub fn set_mcp(server_id: &str, secrets: &McpSecrets) -> Result<(), String> {
    if secrets.env.is_empty() && secrets.headers.is_empty() {
        return delete(&format!("mcp:{server_id}"));
    }
    let json = serde_json::to_string(secrets).map_err(|e| e.to_string())?;
    set(&format!("mcp:{server_id}"), &json)
}

pub fn delete_mcp(server_id: &str) -> Result<(), String> {
    delete(&format!("mcp:{server_id}"))
}
