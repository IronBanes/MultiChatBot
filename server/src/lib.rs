//! Multichat relay: syncs rooms and messages between clients over WebSockets.
//! It never sees API keys or model endpoints — clients call their own models.
//!
//! Runs standalone (`main.rs`) or embedded in the desktop app, which hosts it for
//! friends without a separate process.

mod db;
mod hub;
mod protocol;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxumState;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use hub::State;
use protocol::{ClientMsg, ServerMsg};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// A running relay. Dropping it leaves the relay running; call `stop`.
pub struct Relay {
    addr: SocketAddr,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct AppState {
    hub: State,
    stop: watch::Receiver<bool>,
}

/// Opens (or creates) the database at `db_path` and starts serving on `addr`.
/// Returns once the port is bound, so a busy port is reported here.
pub async fn start(addr: &str, db_path: &str) -> anyhow::Result<Relay> {
    let hub = State::new(db::connect(db_path).await?);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let addr = listener.local_addr()?;
    let (stop, stopped) = watch::channel(false);
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .with_state(AppState { hub, stop: stopped.clone() });

    let mut shutdown = stopped;
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|s| *s).await;
        });
        if let Err(e) = serve.await {
            tracing::error!("relay stopped: {e}");
        }
    });
    tracing::info!("relay listening on ws://{addr}/ws (db: {db_path})");
    Ok(Relay { addr, stop, task })
}

impl Relay {
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// True until the server task ends (after `stop`, or if serving failed).
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    /// Closes every client connection and the listening socket, so the port can be
    /// bound again right away.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(3), &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }

    /// Serves until the process exits (the standalone binary).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

async fn ws_handler(ws: WebSocketUpgrade, AxumState(state): AxumState<AppState>) -> impl IntoResponse {
    ws.max_message_size(8 << 20).on_upgrade(move |socket| client_loop(socket, state))
}

async fn client_loop(socket: WebSocket, AppState { hub: state, mut stop }: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let conn = state.register(tx);
    tracing::debug!("conn {conn} opened");

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    loop {
        let frame = tokio::select! {
            frame = stream.next() => frame,
            _ = stop.wait_for(|s| *s) => break,
        };
        let Some(Ok(frame)) = frame else { break };
        match frame {
            WsMessage::Text(text) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(msg) => state.handle(conn, msg).await,
                Err(e) => {
                    let msg = ServerMsg::Error { request_id: None, message: format!("Bad frame: {e}") };
                    state.send(conn, msg);
                }
            },
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    state.disconnect(conn).await;
    writer.abort();
    tracing::debug!("conn {conn} closed");
}
