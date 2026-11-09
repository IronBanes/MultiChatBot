//! Secrets live in the OS keychain (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux): API keys keyed by profile id, and MCP server
//! env vars / headers keyed by server id. Android has no keychain the `keyring`
//! crate can use, so there they go in a JSON file in the app's private storage,
//! which other apps can't read.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SERVICE: &str = "multichat-bot";

/// Tells the Android file store where to keep secrets; does nothing elsewhere.
pub fn init(_path: std::path::PathBuf) {
    #[cfg(target_os = "android")]
    file_store::init(_path);
}

#[cfg(target_os = "android")]
mod file_store {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    static PATH: OnceLock<PathBuf> = OnceLock::new();
    /// Read-modify-write of the whole file, so writes take turns.
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn init(path: PathBuf) {
        let _ = PATH.set(path);
    }

    fn path() -> Result<&'static PathBuf, String> {
        PATH.get().ok_or_else(|| "Secret storage isn't ready yet".to_string())
    }

    fn read(path: &PathBuf) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Secret storage is unreadable: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("Could not read secret storage: {e}")),
        }
    }

    fn write(path: &PathBuf, all: &BTreeMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_vec(all).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not save secret: {e}"))?;
        }
        // Write then rename, so a crash mid-write can't leave half a file.
        // Each step is synced, so a power cut can't lose a save that already
        // reported success.
        let fail = |e: std::io::Error| format!("Could not save secret: {e}");
        let tmp = path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(fail)?;
            f.write_all(&json).map_err(fail)?;
            f.sync_all().map_err(fail)?;
        }
        std::fs::rename(&tmp, path).map_err(fail)?;
        if let Some(dir) = path.parent() {
            std::fs::File::open(dir).and_then(|d| d.sync_all()).map_err(fail)?;
        }
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        let _turn = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(read(path()?)?.remove(account))
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        let _turn = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = path()?;
        let mut all = read(path)?;
        all.insert(account.to_string(), value.to_string());
        write(path, &all)
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let _turn = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = path()?;
        let mut all = read(path)?;
        if all.remove(account).is_some() {
            write(path, &all)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "android")]
use file_store::{delete, get, set};

#[cfg(not(target_os = "android"))]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("Keychain unavailable: {e}"))
}

#[cfg(not(target_os = "android"))]
fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read from keychain: {e}")),
    }
}

#[cfg(not(target_os = "android"))]
fn set(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|e| format!("Could not store in keychain: {e}"))
}

#[cfg(not(target_os = "android"))]
fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete from keychain: {e}")),
    }
}

/// A profile's API key and the endpoint (base URL) it was saved for. Kept together in
/// one keychain entry, so a key can never be used with an endpoint it wasn't saved
/// for, even if a save failed part-way and the app restarted since (#8).
#[derive(Serialize, Deserialize)]
struct PairedKey {
    key: String,
    endpoint: String,
}

/// Shown when a stored key belongs to a different endpoint than the profile's.
pub const KEY_ENDPOINT_MISMATCH: &str =
    "The saved API key belongs to a different address. Enter the key again in Settings to use it with this one.";

/// The API key for `profile_id`, if it was saved for `endpoint`. A key saved for another
/// endpoint is refused with [`KEY_ENDPOINT_MISMATCH`]. A key stored before keys were
/// paired (a plain string) is returned as is; see [`pair_legacy_key`].
pub fn get_key(profile_id: &str, endpoint: &str) -> Result<Option<String>, String> {
    let Some(raw) = get(&format!("profile:{profile_id}"))? else { return Ok(None) };
    match serde_json::from_str::<PairedKey>(&raw) {
        Ok(p) if self::endpoint(&p.endpoint) == self::endpoint(endpoint) => Ok(Some(p.key)),
        Ok(_) => Err(KEY_ENDPOINT_MISMATCH.into()),
        Err(_) => Ok(Some(raw)),
    }
}

/// The form keys are paired with: trimmed, without a trailing `/`, so the same
/// address always compares equal however it was typed.
pub fn endpoint(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// The key for a form's address `form`, read once: a paired key only for its own
/// endpoint; a key from before pairing only when `form` is the profile's saved address
/// `saved` (and it's paired there, best effort). Read errors are passed on.
pub fn get_key_for_form(profile_id: &str, form: &str, saved: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = get(&format!("profile:{profile_id}"))? else { return Ok(None) };
    match serde_json::from_str::<PairedKey>(&raw) {
        Ok(p) if endpoint(&p.endpoint) == endpoint(form) => Ok(Some(p.key)),
        Ok(_) => Err(KEY_ENDPOINT_MISMATCH.into()),
        Err(_) if saved.map(endpoint).as_deref() == Some(endpoint(form).as_str()) => {
            let _ = set_key(profile_id, &raw, form);
            Ok(Some(raw))
        }
        Err(_) => Err(KEY_ENDPOINT_MISMATCH.into()),
    }
}

/// True when a key is stored for the profile (whatever endpoint it belongs to).
pub fn has_key(profile_id: &str) -> bool {
    get(&format!("profile:{profile_id}")).ok().flatten().is_some()
}

/// Stores `key` for `profile_id`, paired with `endpoint`.
pub fn set_key(profile_id: &str, key: &str, endpoint: &str) -> Result<(), String> {
    let json = serde_json::to_string(&PairedKey { key: key.into(), endpoint: self::endpoint(endpoint) })
        .map_err(|e| e.to_string())?;
    set(&format!("profile:{profile_id}"), &json)
}

/// Pairs a key stored before pairing existed with `endpoint` (best effort: the key is
/// still used if this fails, and it's tried again next time).
pub fn pair_legacy_key(profile_id: &str, endpoint: &str) {
    if let Ok(Some(raw)) = get(&format!("profile:{profile_id}"))
        && serde_json::from_str::<PairedKey>(&raw).is_err()
    {
        let _ = set_key(profile_id, &raw, endpoint);
    }
}

/// The keychain entry exactly as stored, to put back if a save fails part-way.
pub fn key_record(profile_id: &str) -> Result<Option<String>, String> {
    get(&format!("profile:{profile_id}"))
}

/// Puts back a record from [`key_record`].
pub fn set_key_record(profile_id: &str, record: &str) -> Result<(), String> {
    set(&format!("profile:{profile_id}"), record)
}

pub fn delete_key(profile_id: &str) -> Result<(), String> {
    delete(&format!("profile:{profile_id}"))
}

/// The keychain name of the secret that signs this app instance in to `user_id`. Each
/// instance (`MULTICHAT_INSTANCE`) keeps its own copy, so unlinking one doesn't sign the
/// others out; the default instance keeps the plain name.
fn account_entry(instance: &str, user_id: &str) -> String {
    if instance == "default" { format!("account:{user_id}") } else { format!("account:{instance}:{user_id}") }
}

/// The secret that signs this app instance in to account `user_id` on the relay. A
/// non-default instance without its own copy picks up the shared one (from before
/// secrets were per instance) without making a new secret.
pub fn get_account(instance: &str, user_id: &str) -> Result<Option<String>, String> {
    let own = get(&account_entry(instance, user_id))?;
    if own.is_some() || instance == "default" {
        return Ok(own);
    }
    let shared = get(&format!("account:{user_id}"))?;
    if let Some(s) = &shared {
        set(&account_entry(instance, user_id), s)?;
    }
    Ok(shared)
}

pub fn set_account(instance: &str, user_id: &str, secret: &str) -> Result<(), String> {
    set(&account_entry(instance, user_id), secret)
}

pub fn delete_account(instance: &str, user_id: &str) -> Result<(), String> {
    delete(&account_entry(instance, user_id))
}

/// Env vars (stdio servers) and HTTP headers (remote servers) for an MCP server.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpSecrets {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// The server address (URL, or command and args) these were saved for. Secrets for
    /// another address aren't used (#8). None for secrets saved before pairing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn endpoints_compare_however_they_were_typed() {
        assert_eq!(endpoint(" https://api.example.com/v1/ "), "https://api.example.com/v1");
        assert_eq!(endpoint("https://api.example.com/v1//"), "https://api.example.com/v1");
        assert_eq!(endpoint("https://api.example.com/v1"), endpoint("https://api.example.com/v1/"));
        assert_ne!(endpoint("https://api.example.com/v1"), endpoint("https://evil.example.com/v1"));
    }
}
