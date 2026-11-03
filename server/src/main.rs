//! Standalone relay server. The desktop app can also host the same relay itself.

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

    multichat_relay::start(&addr, &db_path).await?.wait().await;
    Ok(())
}
