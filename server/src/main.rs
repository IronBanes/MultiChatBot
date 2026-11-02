//! Multichat relay: syncs rooms and messages between clients over WebSockets.
//! It never sees API keys or model endpoints — clients call their own models.

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "multichat_relay=info".into()),
        )
        .init();

    let addr = std::env::var("MULTICHAT_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let db_path = std::env::var("MULTICHAT_DB").unwrap_or_else(|_| "multichat.db".into());

    let state = State::new(db::connect(&db_path).await?);
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("relay listening on ws://{addr}/ws (db: {db_path})");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, AxumState(state): AxumState<State>) -> impl IntoResponse {
    ws.max_message_size(8 << 20).on_upgrade(move |socket| client_loop(socket, state))
}

async fn client_loop(socket: WebSocket, state: State) {
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
    });

    while let Some(Ok(frame)) = stream.next().await {
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
