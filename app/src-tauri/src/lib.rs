//! Tauri backend: local profiles, keychain access and every LLM call.
//! The webview only ever sees model text, never keys or endpoints.

mod config;
mod context;
mod providers;
mod secrets;

use config::{Config, Profile};
use context::HistoryItem;
use futures_util::StreamExt;
use providers::{ChatRequest, ProviderError};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
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
}

impl AppState {
    fn update<T>(&self, f: impl FnOnce(&mut Config) -> T) -> Result<T, String> {
        let mut cfg = self.config.lock().map_err(|_| "config lock poisoned")?;
        let out = f(&mut cfg);
        config::save(&self.config_path, &cfg).map_err(|e| format!("Could not save settings: {e}"))?;
        Ok(out)
    }

    fn profile(&self, id: &str) -> Result<Profile, String> {
        let cfg = self.config.lock().map_err(|_| "config lock poisoned")?;
        cfg.profiles.iter().find(|p| p.id == id).cloned().ok_or_else(|| "Profile not found".to_string())
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

#[derive(Serialize)]
struct ClientState {
    instance: String,
    user_id: String,
    display_name: String,
    server_url: String,
    last_profile_by_room: HashMap<String, String>,
    profiles: Vec<ProfileView>,
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> Result<ClientState, String> {
    let cfg = state.config.lock().map_err(|_| "config lock poisoned")?.clone();
    Ok(ClientState {
        instance: config::instance_name(),
        user_id: cfg.user_id,
        display_name: cfg.display_name,
        server_url: cfg.server_url,
        last_profile_by_room: cfg.last_profile_by_room,
        profiles: cfg.profiles.into_iter().map(view).collect(),
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
    state.update(|c| {
        c.display_name = name;
        c.server_url = url.to_string();
    })
}

fn validate(p: &Profile) -> Result<(), String> {
    if p.label.trim().is_empty() || p.model.trim().is_empty() {
        return Err("Label and model are required".into());
    }
    let url = p.base_url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://".into());
    }
    if p.max_context_tokens < 512 {
        return Err("Max context tokens must be at least 512".into());
    }
    Ok(())
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
    match api_key.as_deref().map(str::trim) {
        Some("") => secrets::delete_key(&profile.id)?,
        Some(k) => secrets::set_key(&profile.id, k)?,
        None => {}
    }
    let saved = profile.clone();
    state.update(move |c| match c.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => c.profiles.push(profile),
    })?;
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
    let key = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(k),
        None if !profile.id.is_empty() => secrets::get_key(&profile.id)?,
        None => None,
    };
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    let req = ChatRequest {
        model: profile.model.clone(),
        system: "You are a connection test.".into(),
        messages: vec![context::ChatMessage { role: context::Role::User, content: "Reply with just the word OK.".into() }],
        max_output_tokens: 256,
        temperature: profile.temperature,
    };
    let scrub = |e: ProviderError| providers::sanitize(&e.0, key.as_deref(), &profile.base_url);
    let run = async {
        let mut stream = provider.stream_chat(&req).await.map_err(scrub)?;
        let mut text = String::new();
        while let Some(d) = stream.next().await {
            text.push_str(&d.map_err(scrub)?);
            if text.len() > 40 {
                break;
            }
        }
        Ok::<_, String>(text)
    };
    let text = tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .map_err(|_| "Timed out waiting for the provider".to_string())??;
    let text: String = text.trim().chars().take(40).collect();
    Ok(if text.is_empty() {
        format!("Connected to {} (no text in reply)", profile.model)
    } else {
        format!("Connected to {}. Model replied: \"{}\"", profile.model, text)
    })
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum GenEvent {
    Delta { text: String },
    Done { content: String, stopped: bool },
    Error { message: String, partial: String },
}

const FLUSH_EVERY: Duration = Duration::from_millis(100);

/// Streams a reply for AI message `id`. Deltas are batched (~100ms) and sent on
/// `on_event`; exactly one `done` or `error` event ends the stream.
#[tauri::command]
fn generate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    history: Vec<HistoryItem>,
    room_prompt: String,
    on_event: Channel<GenEvent>,
) -> Result<(), String> {
    let profile = state.profile(&profile_id)?;
    let key = secrets::get_key(&profile.id)?;
    let provider = providers::for_profile(&profile, key.clone(), state.http.clone());
    let prompt = context::build(&history, &room_prompt, profile.max_context_tokens);
    if prompt.messages.is_empty() {
        return Err("Nothing to reply to".into());
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
    };

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    state.generations.lock().map_err(|_| "lock poisoned")?.insert(id.clone(), stop_tx);

    let scrub = move |e: ProviderError| providers::sanitize(&e.0, key.as_deref(), &profile.base_url);
    tauri::async_runtime::spawn(async move {
        let mut full = String::new();
        let mut pending = String::new();
        let outcome: Result<bool, String> = async {
            let mut stream = tokio::select! {
                _ = &mut stop_rx => return Ok(true),
                s = provider.stream_chat(&req) => s.map_err(&scrub)?,
            };
            let mut tick = tokio::time::interval(FLUSH_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = &mut stop_rx => return Ok(true),
                    item = stream.next() => match item {
                        Some(Ok(d)) => { full.push_str(&d); pending.push_str(&d); }
                        Some(Err(e)) => return Err(scrub(e)),
                        None => return Ok(false),
                    },
                    _ = tick.tick() => {
                        if !pending.is_empty() {
                            let _ = on_event.send(GenEvent::Delta { text: std::mem::take(&mut pending) });
                        }
                    }
                }
            }
        }
        .await;
        if !pending.is_empty() {
            let _ = on_event.send(GenEvent::Delta { text: pending });
        }
        let event = match outcome {
            Ok(stopped) if stopped || !full.trim().is_empty() => GenEvent::Done { content: full, stopped },
            Ok(_) => GenEvent::Error { message: "The model returned an empty response".into(), partial: full },
            Err(message) => GenEvent::Error { message, partial: full },
        };
        let _ = on_event.send(event);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let base = app.path().app_config_dir()?;
            let config_path = config::config_path(&base);
            let config = config::load(&config_path);
            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(180))
                .build()?;
            if let Some(w) = app.get_webview_window("main") {
                let instance = config::instance_name();
                let title = if instance == "default" { "Multichat".to_string() } else { format!("Multichat — {instance}") };
                let _ = w.set_title(&title);
            }
            app.manage(AppState {
                config_path,
                config: Mutex::new(config),
                http,
                generations: Mutex::new(HashMap::new()),
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
            generate,
            stop_generation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
