//! Tauri backend: local profiles, keychain access, MCP servers and every LLM call.
//! The webview only ever sees model text, never keys, endpoints or MCP secrets.

mod config;
mod context;
mod generate;
mod host;
mod mcp;
mod net;
mod providers;
mod secrets;

use config::{Config, McpMode, McpServer, McpTransport, Profile};
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
    let has_key = secrets::get_key(&p.id).ok().flatten().is_some();
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
    server_url: String,
    platform: &'static str,
    last_profile_by_room: HashMap<String, String>,
    profiles: Vec<ProfileView>,
    mcp_servers: Vec<McpServerView>,
    mcp_modes_by_room: HashMap<String, HashMap<String, McpMode>>,
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

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> Result<ClientState, String> {
    let cfg = state.snapshot()?;
    Ok(ClientState {
        instance: config::instance_name(),
        user_id: cfg.user_id,
        display_name: cfg.display_name,
        server_url: cfg.server_url,
        platform: platform(),
        last_profile_by_room: cfg.last_profile_by_room,
        profiles: cfg.profiles.into_iter().map(view).collect(),
        mcp_servers: cfg.mcp_servers.into_iter().map(mcp_view).collect(),
        mcp_modes_by_room: cfg.mcp_modes_by_room,
    })
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
fn resolve_key(profile: &Profile, api_key: Option<String>) -> Result<Option<String>, String> {
    match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Ok(Some(k)),
        None if !profile.id.is_empty() => secrets::get_key(&profile.id),
        None => Ok(None),
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
    let previous_key = if changing_key { secrets::get_key(&profile.id)? } else { None };
    match api_key.as_deref().map(str::trim) {
        Some("") => secrets::delete_key(&profile.id)?,
        Some(k) => secrets::set_key(&profile.id, k)?,
        None => {}
    }
    let saved = profile.clone();
    let id = profile.id.clone();
    let updated = state.update(move |c| match c.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => c.profiles.push(profile),
    });
    if let Err(e) = updated {
        // The old endpoint is still in effect, so put its key back: the new key must
        // never be sent to the endpoint it wasn't meant for.
        if changing_key {
            let restored = match &previous_key {
                Some(k) => secrets::set_key(&id, k),
                None => secrets::delete_key(&id),
            };
            // If the old key can't come back, remove the key entirely rather than leave
            // the new one paired with the old endpoint.
            if restored.is_err() {
                return Err(match secrets::delete_key(&id) {
                    Ok(()) => format!("{e}. The API key for this profile was removed; enter it again."),
                    Err(_) => {
                        if let Ok(mut blocked) = state.unsafe_keys.lock() {
                            blocked.insert(id.clone());
                        }
                        format!("{e}. The API key for this profile couldn't be restored, so the profile is disabled until you save it again.")
                    }
                });
            }
        }
        return Err(e);
    }
    // Only a new or removed key, saved together with the settings, repairs the pairing.
    if changing_key && let Ok(mut blocked) = state.unsafe_keys.lock() {
        blocked.remove(&saved.id);
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

/// Sends a tiny request with the (possibly unsaved) profile and reports the outcome.
#[tauri::command]
async fn test_profile(state: State<'_, AppState>, profile: Profile, api_key: Option<String>) -> Result<String, String> {
    validate(&profile)?;
    let key = resolve_key(&profile, api_key)?;
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
    let key = resolve_key(&profile, api_key)?;
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

fn merge_secrets(server_id: &str, edits: Option<Vec<SecretEdit>>) -> Result<McpSecrets, String> {
    let old = if server_id.is_empty() { McpSecrets::default() } else { secrets::get_mcp(server_id)? };
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
            None => previous.get(&name).cloned().unwrap_or_default(),
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
        let merged = merge_secrets(&server.id, secrets)?;
        if server.id.is_empty() {
            server.id = uuid::Uuid::new_v4().to_string();
        }
        server.name = server.name.trim().to_string();
        server.command = server.command.trim().to_string();
        server.url = server.url.trim().to_string();
        server.args.retain(|a| !a.is_empty());
        let saved = server.clone();
        let previous = secrets::get_mcp(&server.id)?;
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
    let merged = merge_secrets(&server.id, secrets)?;
    let mut probe = server.clone();
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
fn set_room_mcp_mode(state: State<'_, AppState>, room_id: String, server_id: String, mode: McpMode) -> Result<(), String> {
    state.update(|c| {
        c.mcp_modes_by_room.entry(room_id).or_default().insert(server_id, mode);
    })
}

#[tauri::command]
fn resolve_tool_call(state: State<'_, AppState>, id: String, call_id: String, approved: bool) -> Result<(), String> {
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

/// Streams a reply for AI message `id` on `on_event` (see `generate::GenEvent`).
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
    on_event: Channel<GenEvent>,
) -> Result<(), String> {
    let cfg = state.snapshot()?;
    let profile = state.profile(&profile_id)?;
    if state.unsafe_keys.lock().map_err(|_| "lock poisoned")?.contains(&profile.id) {
        return Err(format!("{} is disabled after a failed save. Save it again in Settings to use it.", profile.label));
    }
    let key = secrets::get_key(&profile.id)?;
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    let prompt = context::build(&history, &room_prompt, profile.max_context_tokens);
    if prompt.messages.is_empty() {
        return Err("Nothing to reply to".into());
    }
    if prompt.trimmed > 0 {
        eprintln!("[context] dropped {} oldest message(s) to fit {} tokens", prompt.trimmed, profile.max_context_tokens);
    }
    let servers = cfg
        .active_mcp(&room_id)
        .into_iter()
        .map(|(s, m)| {
            let sec = secrets::get_mcp(&s.id).unwrap_or_default();
            (s, m, sec)
        })
        .collect();
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

    let (stop_tx, stop) = oneshot::channel::<()>();
    state.generations.lock().map_err(|_| "lock poisoned")?.insert(id.clone(), stop_tx);

    let base_url = profile.base_url.clone();
    let job = generate::Job {
        id: id.clone(),
        provider,
        req,
        servers,
        mcp: state.mcp.clone(),
        approvals: state.approvals.clone(),
        scrub: Box::new(move |e: ProviderError| providers::sanitize(&e.0, key.as_deref(), &base_url)),
        events: on_event,
        stop,
    };
    tauri::async_runtime::spawn(async move {
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
        .setup(|app| {
            let base = app.path().app_config_dir()?;
            let config_path = config::config_path(&base);
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
            save_profile,
            delete_profile,
            set_last_profile,
            test_profile,
            list_models,
            save_mcp_server,
            delete_mcp_server,
            test_mcp_server,
            set_room_mcp_mode,
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
