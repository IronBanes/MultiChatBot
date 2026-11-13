//! Tauri backend: local profiles, keychain access, MCP servers and every LLM call.
//! The webview only ever sees model text, never keys, endpoints or MCP secrets.

mod config;
mod context;
mod frame;
mod generate;
mod host;
mod mcp;
mod net;
mod providers;
mod secrets;

use config::{Config, McpMode, McpServer, McpTransport, NotifyMode, Profile};
use context::HistoryItem;
use futures_util::StreamExt;
use generate::{Approvals, GenEvent};
use mcp::McpManager;
use providers::{ChatRequest, ModelInfo, ProviderError, StreamEvent};
use secrets::McpSecrets;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::oneshot;

struct AppState {
    config_path: PathBuf,
    config: Mutex<Config>,
    http: reqwest::Client,
    /// In-flight generations by AI message id; sending stops the stream.
    generations: Mutex<HashMap<String, oneshot::Sender<()>>>,
    approvals: Approvals,
    mcp: Arc<McpManager>,
    host: Arc<host::Host>,
    /// Held for a whole secret-plus-settings save, so two saves can't interleave their
    /// keychain writes, settings update and rollback.
    saving: Mutex<()>,
    /// Profiles whose stored key may belong to settings that never got saved (the save,
    /// the key restore and the key removal all failed). They can't generate until the
    /// profile is saved successfully again.
    unsafe_keys: Mutex<HashSet<String>>,
}

impl AppState {
    /// Applies `f` and saves. The change is made on a copy, so if saving fails the
    /// settings in memory stay as they were and can't be persisted later by accident.
    fn update<T>(&self, f: impl FnOnce(&mut Config) -> T) -> Result<T, String> {
        let mut cfg = self.config.lock().map_err(|_| "config lock poisoned")?;
        let mut next = cfg.clone();
        let out = f(&mut next);
        config::save(&self.config_path, &next).map_err(|e| format!("Could not save settings: {e}"))?;
        *cfg = next;
        Ok(out)
    }

    fn snapshot(&self) -> Result<Config, String> {
        Ok(self.config.lock().map_err(|_| "config lock poisoned")?.clone())
    }

    fn profile(&self, id: &str) -> Result<Profile, String> {
        self.snapshot()?.profiles.into_iter().find(|p| p.id == id).ok_or_else(|| "Profile not found".to_string())
    }
}

#[derive(Serialize)]
struct ProfileView {
    #[serde(flatten)]
    profile: Profile,
    has_key: bool,
}

fn view(p: Profile) -> ProfileView {
    let has_key = secrets::has_key(&p.id);
    ProfileView { profile: p, has_key }
}

/// An MCP server as the webview sees it: secret names, never values.
#[derive(Serialize)]
struct McpServerView {
    #[serde(flatten)]
    server: McpServer,
    env_names: Vec<String>,
    header_names: Vec<String>,
}

fn mcp_view(server: McpServer) -> McpServerView {
    let s = secrets::get_mcp(&server.id).unwrap_or_default();
    McpServerView { server, env_names: s.env.into_keys().collect(), header_names: s.headers.into_keys().collect() }
}

#[derive(Serialize)]
struct ClientState {
    instance: String,
    user_id: String,
    display_name: String,
    device_id: String,
    /// Signs this device in to `user_id` on the relay (kept in the OS keychain).
    account_secret: String,
    linked: bool,
    server_url: String,
    platform: &'static str,
    last_profile_by_room: HashMap<String, String>,
    profiles: Vec<ProfileView>,
    mcp_servers: Vec<McpServerView>,
    mcp_modes_by_room: HashMap<String, HashMap<String, McpMode>>,
    notify_by_room: HashMap<String, NotifyMode>,
    remote_control: bool,
}

/// "desktop", "ios" or "android" — lets the UI adapt (mobile hides stdio MCP servers).
fn platform() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

/// The keychain secret for account `user_id`, made on first use for this device's
/// own account. A linked account's secret comes from the link code. If it's missing
/// (linked before accounts had secrets), none is sent: a made-up one could claim the
/// owner's account first. The relay then lets this device in as an older client until
/// the owner's device claims the account, after which it asks to link again.
fn account_secret(user_id: &str, linked: bool) -> Result<String, String> {
    let instance = config::instance_name();
    if let Some(s) = secrets::get_account(&instance, user_id)?.filter(|s| !s.is_empty()) {
        return Ok(s);
    }
    if linked {
        return Ok(String::new());
    }
    let fresh = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    secrets::set_account(&instance, user_id, &fresh)?;
    Ok(fresh)
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> Result<ClientState, String> {
    let cfg = state.snapshot()?;
    let account_secret = account_secret(&cfg.user_id, cfg.linked_from.is_some())?;
    Ok(ClientState {
        instance: config::instance_name(),
        account_secret,
        user_id: cfg.user_id,
        display_name: cfg.display_name,
        device_id: cfg.device_id,
        linked: cfg.linked_from.is_some(),
        server_url: cfg.server_url,
        platform: platform(),
        last_profile_by_room: cfg.last_profile_by_room,
        profiles: cfg.profiles.into_iter().map(view).collect(),
        mcp_servers: cfg.mcp_servers.into_iter().map(mcp_view).collect(),
        mcp_modes_by_room: cfg.mcp_modes_by_room,
        notify_by_room: cfg.notify_by_room,
        remote_control: cfg.remote_control,
    })
}

#[tauri::command]
fn link_device(
    state: State<'_, AppState>,
    user_id: String,
    display_name: String,
    secret: String,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&user_id).is_err() {
        return Err("Invalid user id".into());
    }
    if secret.is_empty() {
        return Err("The link code didn't include the account's sign-in. Update the other device.".into());
    }
    let name: String = display_name.trim().chars().take(40).collect();
    let instance = config::instance_name();
    // Re-linking from one linked account to another: that one's secret goes afterwards.
    let cfg = state.snapshot()?;
    let previous_link = cfg.linked_from.is_some().then(|| cfg.user_id.clone()).filter(|p| *p != user_id);
    // The secret first: without it this device couldn't sign in to the account.
    secrets::set_account(&instance, &user_id, &secret)?;
    state.update(|c| {
        // Remember this device's own account so unlinking can return to it.
        if c.linked_from.is_none() {
            c.linked_from = Some(c.user_id.clone());
            c.linked_from_name = Some(c.display_name.clone());
        }
        c.user_id = user_id;
        c.display_name = name;
    })?;
    if let Some(prev) = previous_link {
        let _ = secrets::delete_account(&instance, &prev);
    }
    Ok(())
}

#[tauri::command]
fn unlink_device(state: State<'_, AppState>) -> Result<(), String> {
    let linked = state.snapshot()?.user_id;
    state.update(|c| {
        // Back to this device's own account, or a fresh one if never linked.
        c.user_id =
            c.linked_from.take().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if let Some(name) = c.linked_from_name.take().filter(|n| !n.is_empty()) {
            c.display_name = name;
        }
    })?;
    // This device no longer signs in to the account it left.
    let _ = secrets::delete_account(&config::instance_name(), &linked);
    Ok(())
}

#[tauri::command]
fn set_identity(state: State<'_, AppState>, display_name: String, server_url: String) -> Result<(), String> {
    let name: String = display_name.trim().chars().take(40).collect();
    if name.is_empty() {
        return Err("Display name is required".into());
    }
    let url = server_url.trim();
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err("Server URL must start with ws:// or wss://".into());
    }
    // A phone is often on someone else's network; don't send chats unencrypted
    // across the internet. LAN relays may stay on plain ws://.
    #[cfg(mobile)]
    if url.starts_with("ws://") && !net::is_local_host(url) {
        return Err("Use wss:// for relays outside your local network (for example a cloudflared tunnel or `tailscale serve`).".into());
    }
    state.update(|c| {
        c.display_name = name;
        c.server_url = url.to_string();
    })
}

fn validate(p: &Profile) -> Result<(), String> {
    if p.label.trim().is_empty() || p.model.trim().is_empty() {
        return Err("Label and model are required".into());
    }
    validate_base_url(p)?;
    if p.max_context_tokens < 512 {
        return Err("Max context tokens must be at least 512".into());
    }
    Ok(())
}

fn validate_base_url(p: &Profile) -> Result<(), String> {
    let url = p.base_url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://".into());
    }
    Ok(())
}

/// The key typed into the form if any, else the stored one.
fn resolve_key(state: &AppState, profile: &Profile, api_key: Option<String>) -> Result<Option<String>, String> {
    match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Ok(Some(k)),
        None if !profile.id.is_empty() => {
            // A key typed into the form still works, so the user can test and recover.
            check_not_blocked(state, profile)?;
            // A key from before pairing belongs to the profile's saved address: pair it
            // there first, so it isn't tried on a different address typed into the form.
            // One read decides: a paired key only for its own address, and a key from
            // before pairing only at the profile's saved address (whether or not pairing
            // it there succeeds). Keychain errors are passed on, never read as "paired".
            let saved = state.snapshot()?.profiles.iter().find(|p| p.id == profile.id).map(|p| p.base_url.clone());
            // Taking turns with saves: pairing an old key here must not overwrite a key
            // a save is putting in place at the same moment.
            let _saving = state.saving.lock().map_err(|_| "save lock poisoned")?;
            secrets::get_key_for_form(&profile.id, &profile.base_url, saved.as_deref())
        }
        None => Ok(None),
    }
}

/// A profile whose key rollback failed must not use its stored key until it's saved again.
fn check_not_blocked(state: &AppState, profile: &Profile) -> Result<(), String> {
    if state.unsafe_keys.lock().map_err(|_| "lock poisoned")?.contains(&profile.id) {
        return Err(format!("{} is disabled after a failed save. Save it again in Settings to use it.", profile.label));
    }
    Ok(())
}

/// Puts a profile's previous API key back after a save failed part-way, so the new key
/// is never sent to the endpoint it wasn't meant for. If the old key can't come back,
/// the key is removed; if even that fails, the profile is disabled until saved again.
fn restore_key(state: &AppState, id: &str, previous_key: Option<String>, e: String) -> String {
    let restored = match &previous_key {
        Some(record) => secrets::set_key_record(id, record),
        None => secrets::delete_key(id),
    };
    if restored.is_ok() {
        return e;
    }
    match secrets::delete_key(id) {
        Ok(()) => format!("{e}. The API key for this profile was removed; enter it again."),
        Err(_) => {
            if let Ok(mut blocked) = state.unsafe_keys.lock() {
                blocked.insert(id.to_string());
            }
            format!("{e}. The API key for this profile couldn't be restored, so the profile is disabled until you save it again.")
        }
    }
}

/// `api_key`: `None` keeps the stored key, `Some("")` removes it, otherwise replaces it.
#[tauri::command]
fn save_profile(state: State<'_, AppState>, mut profile: Profile, api_key: Option<String>) -> Result<ProfileView, String> {
    validate(&profile)?;
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    profile.base_url = profile.base_url.trim().trim_end_matches('/').to_string();
    profile.model = profile.model.trim().to_string();
    profile.reasoning_effort = profile.reasoning_effort.filter(|e| !e.trim().is_empty());
    let _saving = state.saving.lock().map_err(|_| "save lock poisoned")?;
    let changing_key = api_key.is_some();
    let previous_key = if changing_key { secrets::key_record(&profile.id)? } else { None };
    // The endpoint the stored key is paired with now, to move a kept key to a new one.
    let old_endpoint = state.snapshot()?.profiles.iter().find(|p| p.id == profile.id).map(|p| p.base_url.clone());
    let written = match api_key.as_deref().map(str::trim) {
        Some("") => secrets::delete_key(&profile.id),
        Some(k) => secrets::set_key(&profile.id, k, &profile.base_url),
        None => Ok(()),
    };
    // A failed write may still have replaced the stored key (it can fail after the
    // new value is in place), so undo it just like a failed settings save.
    if let Err(e) = written {
        return Err(restore_key(&state, &profile.id, previous_key, e));
    }
    let saved = profile.clone();
    let id = profile.id.clone();
    let updated = state.update(move |c| match c.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => c.profiles.push(profile),
    });
    if let Err(e) = updated {
        return Err(if changing_key { restore_key(&state, &id, previous_key, e) } else { e });
    }
    // Only a new or removed key, saved together with the settings, repairs the pairing.
    if changing_key && let Ok(mut blocked) = state.unsafe_keys.lock() {
        blocked.remove(&saved.id);
    }
    // The address changed but the key was kept: the user moved it on purpose, so pair
    // it with the new address (after the settings, so a failure here leaves the key
    // tied to the old address and refused, never sent somewhere unintended).
    if !changing_key && let Some(old) = old_endpoint.filter(|o| *o != saved.base_url) {
        // A failed read counts as a failed move too: the save would otherwise look fine
        // while the key stays tied to the old address (and a later save wouldn't retry).
        let moved = match secrets::get_key(&saved.id, &old) {
            Ok(Some(key)) => secrets::set_key(&saved.id, &key, &saved.base_url),
            Ok(None) => Ok(()),
            Err(e) => Err(e),
        };
        if moved.is_err() {
            return Err(format!(
                "{} was saved, but its API key couldn't be moved to the new address. Enter the key again.",
                saved.label
            ));
        }
    }
    Ok(view(saved))
}

#[tauri::command]
fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    secrets::delete_key(&id)?;
    state.update(|c| {
        c.profiles.retain(|p| p.id != id);
        c.last_profile_by_room.retain(|_, p| *p != id);
    })
}

#[tauri::command]
fn set_last_profile(state: State<'_, AppState>, room_id: String, profile_id: String) -> Result<(), String> {
    state.update(|c| {
        c.last_profile_by_room.insert(room_id, profile_id);
    })
}

/// Turns a profile on or off, without touching its settings or key. `remote` marks a
/// command from another device, checked under the settings lock like the other two.
#[tauri::command]
fn set_profile_enabled(state: State<'_, AppState>, id: String, enabled: bool, remote: Option<bool>) -> Result<(), String> {
    state.update(|c| {
        c.allow_remote(remote.unwrap_or(false))?;
        match c.profiles.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.enabled = enabled;
                Ok(())
            }
            None => Err("Profile not found".to_string()),
        }
    })?
}

/// Whether this user's other devices may control this one (see `Config::remote_control`).
#[tauri::command]
fn set_remote_control(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.update(|c| c.remote_control = enabled)
}

/// Sends a tiny request with the (possibly unsaved) profile and reports the outcome.
#[tauri::command]
async fn test_profile(state: State<'_, AppState>, profile: Profile, api_key: Option<String>) -> Result<String, String> {
    validate(&profile)?;
    let key = resolve_key(&state, &profile, api_key)?;
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    let req = ChatRequest {
        model: profile.model.clone(),
        system: "You are a connection test.".into(),
        messages: vec![context::ChatMessage { role: context::Role::User, content: "Reply with just the word OK.".into() }],
        max_output_tokens: 1024,
        temperature: profile.temperature,
        show_reasoning: profile.show_reasoning,
        reasoning_effort: profile.reasoning_effort.clone(),
        tools: Vec::new(),
        allow_tool_calls: true,
        continuation: Vec::new(),
    };
    let scrub = |e: ProviderError| providers::sanitize(&e.0, key.as_deref(), &profile.base_url);
    let run = async {
        let mut stream = provider.stream_chat(&req).await.map_err(scrub)?;
        let (mut text, mut reasoned) = (String::new(), false);
        while let Some(ev) = stream.next().await {
            match ev.map_err(scrub)? {
                StreamEvent::Text(t) => text.push_str(&t),
                StreamEvent::Reasoning(_) => reasoned = true,
                StreamEvent::ToolCalls { .. } => {}
            }
            if text.len() > 40 {
                break;
            }
        }
        Ok::<_, String>((text, reasoned))
    };
    let (text, reasoned) = tokio::time::timeout(Duration::from_secs(90), run)
        .await
        .map_err(|_| "Timed out waiting for the provider".to_string())??;
    let text: String = text.trim().chars().take(40).collect();
    let thinking = if reasoned { " (with reasoning)" } else { "" };
    Ok(if text.is_empty() {
        format!("Connected to {}{thinking} (no text in reply)", profile.model)
    } else {
        format!("Connected to {}{thinking}. Model replied: \"{}\"", profile.model, text)
    })
}

/// Lists the models the (possibly unsaved) profile's key can use.
#[tauri::command]
async fn list_models(state: State<'_, AppState>, profile: Profile, api_key: Option<String>) -> Result<Vec<ModelInfo>, String> {
    validate_base_url(&profile)?;
    let key = resolve_key(&state, &profile, api_key)?;
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    tokio::time::timeout(Duration::from_secs(30), provider.list_models())
        .await
        .map_err(|_| "Timed out listing models".to_string())?
        .map_err(|e| providers::sanitize(&e.0, key.as_deref(), &profile.base_url))
}

// ------------------------------------------------------------------ MCP servers

/// One env var or header row from the editor. `value: None` keeps the stored value.
#[derive(Deserialize)]
struct SecretEdit {
    kind: String,
    name: String,
    value: Option<String>,
}

/// What a server's secrets are paired with: its URL, or its command and arguments.
fn mcp_target(s: &McpServer) -> String {
    match s.transport {
        McpTransport::Http => s.url.clone(),
        McpTransport::Stdio => std::iter::once(s.command.as_str()).chain(s.args.iter().map(String::as_str)).collect::<Vec<_>>().join("\u{0}"),
    }
}

/// A server's env vars and headers, only if they were saved for its current address.
/// Secrets from before pairing are used and paired now (best effort).
fn mcp_secrets_for(s: &McpServer) -> McpSecrets {
    let sec = secrets::get_mcp(&s.id).unwrap_or_default();
    match &sec.target {
        Some(t) if *t != mcp_target(s) => {
            eprintln!("[mcp] {}: stored secrets belong to another address; not using them", s.name);
            McpSecrets::default()
        }
        Some(_) => sec,
        None => {
            if !(sec.env.is_empty() && sec.headers.is_empty()) {
                let _ = secrets::set_mcp(&s.id, &McpSecrets { target: Some(mcp_target(s)), ..sec.clone() });
            }
            sec
        }
    }
}

/// The server as it will be saved (trimmed), for comparing addresses.
fn normalized(server: &McpServer) -> McpServer {
    let mut s = server.clone();
    s.command = s.command.trim().to_string();
    s.url = s.url.trim().to_string();
    s.args.retain(|a| !a.is_empty());
    s
}

/// The new values from the editor, plus stored ones kept (`value: None`) — but stored
/// values only if they were saved for `address`, the one being saved or tested.
/// Secrets from before pairing count as saved for the server's saved address. So
/// changing a server's URL or command never carries its secrets along unless they're
/// entered again.
fn merge_secrets(state: &AppState, server_id: &str, address: &str, edits: Option<Vec<SecretEdit>>) -> Result<McpSecrets, String> {
    let stored = if server_id.is_empty() { McpSecrets::default() } else { secrets::get_mcp(server_id)? };
    let stored_for = match &stored.target {
        Some(t) => Some(t.clone()),
        None => state.snapshot()?.mcp_servers.iter().find(|s| s.id == server_id).map(mcp_target),
    };
    let old = if stored_for.as_deref() == Some(address) { stored } else { McpSecrets::default() };
    let Some(edits) = edits else { return Ok(old) };
    let mut new = McpSecrets::default();
    for e in edits {
        let name = e.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let (target, previous): (&mut BTreeMap<String, String>, &BTreeMap<String, String>) =
            if e.kind == "header" { (&mut new.headers, &old.headers) } else { (&mut new.env, &old.env) };
        let value = match e.value {
            Some(v) => v,
            // A kept value that can't be reused here is dropped, not sent empty.
            None => match previous.get(&name) {
                Some(v) => v.clone(),
                None => continue,
            },
        };
        target.insert(name, value);
    }
    Ok(new)
}

fn validate_mcp(s: &McpServer) -> Result<(), String> {
    if s.name.trim().is_empty() {
        return Err("Name is required".into());
    }
    // Mobile OSes cannot spawn the local commands stdio servers need.
    #[cfg(mobile)]
    {
        if matches!(s.transport, McpTransport::Stdio) {
            return Err(
                "Local command (stdio) MCP servers run on the desktop app only. Add the server as a Remote URL instead.".into(),
            );
        }
    }
    match s.transport {
        McpTransport::Stdio if s.command.trim().is_empty() => Err("Command is required".into()),
        McpTransport::Http if !(s.url.starts_with("http://") || s.url.starts_with("https://")) => {
            Err("URL must start with http:// or https://".into())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
async fn save_mcp_server(
    state: State<'_, AppState>,
    mut server: McpServer,
    secrets: Option<Vec<SecretEdit>>,
) -> Result<McpServerView, String> {
    validate_mcp(&server)?;
    let saved = {
        // Merge against the stored secrets inside the lock, so a concurrent save of the
        // same server can't be overwritten with stale values.
        let _saving = state.saving.lock().map_err(|_| "save lock poisoned")?;
        let merged = merge_secrets(&state, &server.id, &mcp_target(&normalized(&server)), secrets)?;
        if server.id.is_empty() {
            server.id = uuid::Uuid::new_v4().to_string();
        }
        server.name = server.name.trim().to_string();
        server.command = server.command.trim().to_string();
        server.url = server.url.trim().to_string();
        server.args.retain(|a| !a.is_empty());
        let saved = server.clone();
        let previous = secrets::get_mcp(&server.id)?;
        // Saved together with this address, so they're never sent to another one.
        let merged = McpSecrets { target: Some(mcp_target(&server)), ..merged };
        secrets::set_mcp(&server.id, &merged)?;
        let updated = state.update(move |c| match c.mcp_servers.iter_mut().find(|s| s.id == server.id) {
            Some(existing) => *existing = server,
            None => c.mcp_servers.push(server),
        });
        if let Err(e) = updated {
            // Keep the secrets paired with the server settings that are still in effect,
            // or drop them if that fails.
            if secrets::set_mcp(&saved.id, &previous).is_err() {
                return Err(match secrets::delete_mcp(&saved.id) {
                    Ok(()) => format!("{e}. This server's env vars and headers were removed; enter them again."),
                    Err(_) => format!("{e}. This server's env vars and headers couldn't be restored; enter them again before using it."),
                });
            }
            return Err(e);
        }
        saved
    };
    // Pick up the new settings on next use.
    state.mcp.disconnect(&saved.id).await;
    Ok(mcp_view(saved))
}

#[tauri::command]
async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    secrets::delete_mcp(&id)?;
    state.mcp.disconnect(&id).await;
    state.update(|c| {
        c.mcp_servers.retain(|s| s.id != id);
        for modes in c.mcp_modes_by_room.values_mut() {
            modes.remove(&id);
        }
    })
}

/// Connects with the (possibly unsaved) settings and lists the server's tools.
#[tauri::command]
async fn test_mcp_server(
    state: State<'_, AppState>,
    server: McpServer,
    secrets: Option<Vec<SecretEdit>>,
) -> Result<Vec<mcp::ToolInfo>, String> {
    validate_mcp(&server)?;
    // Stored secrets only go to the address they were saved for, even in a test.
    let merged = merge_secrets(&state, &server.id, &mcp_target(&normalized(&server)), secrets)?;
    // Test exactly what would be saved (and what the secrets are paired with).
    let mut probe = normalized(&server);
    if probe.id.is_empty() {
        probe.id = format!("test-{}", uuid::Uuid::new_v4());
    }
    let res = state.mcp.test(&probe, &merged).await;
    if server.id.is_empty() {
        state.mcp.disconnect(&probe.id).await;
    }
    res
}

#[tauri::command]
fn set_room_mcp_mode(state: State<'_, AppState>, room_id: String, server_id: String, mode: McpMode, remote: Option<bool>) -> Result<(), String> {
    state.update(|c| {
        c.allow_remote(remote.unwrap_or(false))?;
        c.mcp_modes_by_room.entry(room_id).or_default().insert(server_id, mode);
        Ok(())
    })?
}

/// Picks which messages in `room_id` earn a system notification. `Mentions` (the
/// default) is stored as no entry, so rooms never touched stay out of the config.
#[tauri::command]
fn set_room_notify(state: State<'_, AppState>, room_id: String, mode: NotifyMode) -> Result<(), String> {
    state.update(|c| {
        if mode == NotifyMode::Mentions {
            c.notify_by_room.remove(&room_id);
        } else {
            c.notify_by_room.insert(room_id, mode);
        }
    })
}

/// Drops a left room's notification choice (a rejoin starts from the default,
/// like a room joined for the first time). Other per-room memories — the last
/// profile and tool modes — are deliberately kept on leaving, as before.
#[tauri::command]
fn forget_room_notify(state: State<'_, AppState>, room_id: String) -> Result<(), String> {
    state.update(|c| {
        c.notify_by_room.remove(&room_id);
    })
}

#[tauri::command]
fn resolve_tool_call(state: State<'_, AppState>, id: String, call_id: String, approved: bool, remote: Option<bool>) -> Result<(), String> {
    // Held until answered, so turning remote control off can't land in between.
    let cfg = state.config.lock().map_err(|_| "config lock poisoned")?;
    cfg.allow_remote(remote.unwrap_or(false))?;
    let tx = state.approvals.lock().map_err(|_| "lock poisoned")?.remove(&format!("{id}:{call_id}"));
    match tx {
        Some(tx) => {
            let _ = tx.send(approved);
            Ok(())
        }
        None => Err("That tool call is no longer waiting for approval".into()),
    }
}

// ------------------------------------------------------------------ generation

/// How long the summarizing pre-step (all its requests) may take before the reply falls back to
/// trimming the oldest messages.
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(180);

/// Streams a reply for AI message `id` on `on_event` (see `generate::GenEvent`).
/// When the history won't fit the profile's context, the oldest messages are
/// first summarized by the same model; the summary is shared with the room
/// through the webview, and only on failure does the reply fall back to today's
/// trimming.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn generate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    room_id: String,
    history: Vec<HistoryItem>,
    room_prompt: String,
    summary: Option<String>,
    // Only messages with a smaller seq may be folded into the summary (a reply
    // still streaming, or a gap in the loaded history); None = no limit.
    fold_before: Option<i64>,
    delegated: Option<bool>,
    on_event: Channel<GenEvent>,
) -> Result<(), String> {
    let cfg = state.snapshot()?;
    let delegated = delegated.unwrap_or(false);
    let profile = state.profile(&profile_id)?;
    if !profile.enabled {
        return Err(format!("{} is turned off", profile.label));
    }
    check_not_blocked(&state, &profile)?;
    {
        // Same as resolve_key: pairing takes turns with saves.
        let _saving = state.saving.lock().map_err(|_| "save lock poisoned")?;
        secrets::pair_legacy_key(&profile.id, &profile.base_url);
    }
    let key = secrets::get_key(&profile.id, &profile.base_url)?;
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    // The summarizing pre-step happens inside the spawned task, so the prompt is
    // built there too (with the summary it produced).
    let fold = context::plan_summary(&history, &room_prompt, summary.as_deref().unwrap_or(""), profile.max_context_tokens)
        .map(|n| match fold_before {
            Some(limit) => history[..n].iter().take_while(|h| h.seq < limit).count(),
            None => n,
        })
        .filter(|&n| n > 0);
    let servers = cfg
        .mcp_for_reply(&room_id, delegated)
        .into_iter()
        .map(|(s, m)| {
            let sec = mcp_secrets_for(&s);
            (s, m, sec)
        })
        .collect();

    let (stop_tx, mut stop) = oneshot::channel::<()>();
    state.generations.lock().map_err(|_| "lock poisoned")?.insert(id.clone(), stop_tx);

    let base_url = profile.base_url.clone();
    let scrub =
        move |e: ProviderError| providers::sanitize(&e.0, key.as_deref(), &base_url);
    let mcp = state.mcp.clone();
    let approvals = state.approvals.clone();
    tauri::async_runtime::spawn(async move {
        // The summary the reply is built with: the room's shared one, replaced by
        // a fresh one when this run summarizes, and kept on failure (the reply
        // then falls back to today's trimming).
        let mut summary = summary.unwrap_or_default();
        // Which history the reply is built from: after a successful summary only
        // the messages it doesn't cover; the full history otherwise (it trims).
        let mut kept: &[HistoryItem] = &history;
        if let Some(n) = fold {
            // Fold the oldest `n` messages into a new summary first: as many as fit
            // in one request, or a single message too long for one request in parts
            // (then whatever fits after it). Only fully covered messages count, so
            // the published boundary never passes text the model didn't read. Errors
            // go through the same scrub as replies, so the API key never appears;
            // neither the summary nor any message content is ever logged.
            let max = profile.max_context_tokens;
            let mut next = summary.clone();
            // The summary as of the last fully covered message: what gets published,
            // so part of a message that never finished stays out of it.
            let mut checkpoint = summary.clone();
            let (mut done, mut from) = (0usize, 0usize);
            let mut failed = false;
            let mut stopped = false;
            let started = tokio::time::Instant::now();
            loop {
                if done >= n {
                    break;
                }
                // Items(c): the request covers the next c messages. Part(end): it
                // covers history[done]'s characters up to `end`.
                enum Step {
                    Items(usize),
                    Part(usize),
                }
                let planned = if from == 0 {
                    match context::fold_request(&next, &history[done..], n - done, max) {
                        (s, m, c) if c > 0 => Some((s, m, Step::Items(c))),
                        _ => context::piece_request(&next, &history[done], 0, max).map(|(s, m, e)| (s, m, Step::Part(e))),
                    }
                } else {
                    context::piece_request(&next, &history[done], from, max).map(|(s, m, e)| (s, m, Step::Part(e)))
                };
                let Some((system, messages, step)) = planned else {
                    // Nothing fits next to the current summary: keep what's done.
                    failed = from > 0;
                    break;
                };
                let req = ChatRequest {
                    model: profile.model.clone(),
                    system,
                    messages,
                    // The same reserve the summary request leaves free: thinking models
                    // spend part of it reasoning before the summary text starts.
                    max_output_tokens: context::output_reserve(max),
                    temperature: profile.temperature,
                    show_reasoning: false,
                    reasoning_effort: None,
                    tools: Vec::new(),
                    allow_tool_calls: false,
                    continuation: Vec::new(),
                };
                let summarize = async {
                    let mut stream = provider.stream_chat(&req).await.map_err(&scrub)?;
                    let mut text = String::new();
                    while let Some(ev) = stream.next().await {
                        match ev.map_err(&scrub)? {
                            StreamEvent::Text(t) => text.push_str(&t),
                            StreamEvent::Reasoning(_) | StreamEvent::ToolCalls { .. } => {}
                        }
                    }
                    Ok::<_, String>(text)
                };
                // One time limit for all the requests of this reply.
                let left = SUMMARY_TIMEOUT.saturating_sub(started.elapsed());
                let text = tokio::select! {
                    _ = &mut stop => { stopped = true; None }
                    r = tokio::time::timeout(left, summarize) => match r {
                        Ok(Ok(text)) if !text.trim().is_empty() => Some(text),
                        _ => None,
                    },
                };
                let Some(text) = text else {
                    failed = !stopped;
                    break;
                };
                next = text;
                match step {
                    Step::Items(c) => {
                        done += c;
                        checkpoint = next.clone();
                        // fold_request ends the fold before a human message; that's enough
                        // for this reply.
                        break;
                    }
                    Step::Part(end) if end >= history[done].content.chars().count() => {
                        done += 1;
                        checkpoint = next.clone();
                        from = 0;
                    }
                    Step::Part(end) => from = end,
                }
            }
            if stopped {
                // The user stopped while summarizing: no reply at all.
                let _ = on_event.send(GenEvent::Done { content: String::new(), stopped: true });
                if let Ok(mut g) = app.state::<AppState>().generations.lock() {
                    g.remove(&id);
                }
                return;
            }
            if done > 0 {
                // A message only partly summarized stays out of the boundary, so it's
                // read again from its start next time.
                summary = checkpoint;
                let upto_seq = history[done - 1].seq;
                let _ = on_event.send(GenEvent::Summary { text: summary.clone(), upto_seq });
                // The folded messages leave the prompt; the summary covers them.
                kept = &history[done..];
            } else if failed {
                let _ = on_event.send(GenEvent::Notice {
                    message: "Couldn't summarize earlier messages, so the oldest were left out".into(),
                });
                // Fall back to today's behavior: the old summary and the full
                // history, which trims.
            }
        }
        let prompt = context::build(kept, &room_prompt, &summary, profile.max_context_tokens);
        if prompt.messages.is_empty() {
            let _ = on_event.send(GenEvent::Error { message: "Nothing to reply to".into(), partial: String::new() });
            if let Ok(mut g) = app.state::<AppState>().generations.lock() {
                g.remove(&id);
            }
            return;
        }
        if prompt.trimmed > 0 {
            eprintln!("[context] dropped {} oldest message(s) to fit {} tokens", prompt.trimmed, profile.max_context_tokens);
        }
        let req = ChatRequest {
            model: profile.model.clone(),
            system: prompt.system,
            messages: prompt.messages,
            max_output_tokens: context::output_reserve(profile.max_context_tokens),
            temperature: profile.temperature,
            show_reasoning: profile.show_reasoning,
            reasoning_effort: profile.reasoning_effort.clone(),
            tools: Vec::new(),
            allow_tool_calls: true,
            continuation: Vec::new(),
        };
        let job = generate::Job {
            id: id.clone(),
            provider,
            req,
            servers,
            mcp,
            approvals,
            scrub: Box::new(scrub),
            events: on_event,
            stop,
        };
        generate::run(job).await;
        if let Ok(mut g) = app.state::<AppState>().generations.lock() {
            g.remove(&id);
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_generation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(tx) = state.generations.lock().map_err(|_| "lock poisoned")?.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
async fn host_status(state: State<'_, AppState>) -> Result<host::HostStatus, String> {
    let saved = state.snapshot()?.host_relay_port;
    Ok(state.host.status(saved).await)
}

/// Hosts the relay on `port` (restarting it if it already runs) and remembers it,
/// so hosting resumes on the next launch.
#[tauri::command]
async fn host_start(state: State<'_, AppState>, port: u16) -> Result<host::HostStatus, String> {
    if port < 1024 {
        return Err("Use a port from 1024 to 65535.".into());
    }
    state.host.start(port).await?;
    state.update(|c| c.host_relay_port = Some(port))?;
    Ok(state.host.status(Some(port)).await)
}

#[tauri::command]
async fn host_stop(state: State<'_, AppState>) -> Result<host::HostStatus, String> {
    // Save first: if saving fails the relay keeps running, matching what the next
    // launch would do.
    state.update(|c| c.host_relay_port = None)?;
    state.host.stop().await;
    Ok(state.host.status(None).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        // The frame shell for live HTML in AI replies: a page from its own origin,
        // with its own CSP, so scripts in model HTML can run (see frame.rs).
        .register_uri_scheme_protocol(frame::SCHEME, |_ctx, request| frame::respond(&request))
        .setup(|app| {
            let base = app.path().app_config_dir()?;
            let config_path = config::config_path(&base);
            secrets::init(config_path.with_file_name("secrets.json"));
            let config = config::load(&config_path);
            let host = Arc::new(host::Host::new(config_path.with_file_name("relay.db")));
            if let Some(port) = config.host_relay_port {
                let host = host.clone();
                // A failure (say, the port is taken) shows up in Settings.
                tauri::async_runtime::spawn(async move {
                    let _ = host.start(port).await;
                });
            }
            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(180))
                .build()?;
            // Window titles are a desktop concept (window management APIs don't
            // exist on mobile).
            #[cfg(desktop)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    let instance = config::instance_name();
                    let title = if instance == "default" { "Multichat".to_string() } else { format!("Multichat — {instance}") };
                    let _ = w.set_title(&title);
                }
            }
            app.manage(AppState {
                config_path,
                config: Mutex::new(config),
                http,
                generations: Mutex::new(HashMap::new()),
                approvals: Arc::new(Mutex::new(HashMap::new())),
                mcp: Arc::new(McpManager::default()),
                host,
                saving: Mutex::new(()),
                unsafe_keys: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_identity,
            link_device,
            unlink_device,
            save_profile,
            delete_profile,
            set_last_profile,
            set_profile_enabled,
            set_remote_control,
            test_profile,
            list_models,
            save_mcp_server,
            delete_mcp_server,
            test_mcp_server,
            set_room_mcp_mode,
            set_room_notify,
            forget_room_notify,
            resolve_tool_call,
            generate,
            stop_generation,
            host_status,
            host_start,
            host_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
