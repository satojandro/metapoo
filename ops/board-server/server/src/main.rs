//! Board server: applies queued board events to the mirror and serves it over HTTP and a
//! WebSocket. Port of Berry Fast's `backend/server`.
//!
//! Env: `VALKEY_URL`, `LISTEN_ADDR` (default 0.0.0.0:3000), `INITIAL_SIDE` (the board's side at
//! deploy, default 64 = the paid board's `LAUNCH_SIDE`), `CATCHUP_RETENTION_MS` (default
//! 7,200,000 = Berry Fast's 2 h; spec §4/B2 recommends 30 days, not decided).

use server::{api, board, consumer};

use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::CorsLayer;

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term.recv() => {},
    }
    tracing::info!("shutting down");
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive("server=info".parse()?),
        )
        .init();

    let valkey_url: String = env_or("VALKEY_URL", "redis://127.0.0.1:6379".to_string());
    let listen_addr: String = env_or("LISTEN_ADDR", "0.0.0.0:3000".to_string());
    let initial_side: u32 = env_or("INITIAL_SIDE", 64);
    let retention: u64 = env_or("CATCHUP_RETENTION_MS", 7_200_000);

    // A `ConnectionManager`, not a bare multiplexed connection: it reconnects in the
    // background. A dropped connection otherwise stays dropped, and every later command fails
    // even after Valkey is back — the process would need a restart to heal.
    let mut con = redis::Client::open(valkey_url.as_str())?
        .get_connection_manager()
        .await?;
    let state = Arc::new(RwLock::new(board::load(&mut con, initial_side).await?));
    let (broadcast_tx, _) = broadcast::channel::<String>(4096);
    let consumer_health = consumer::Health::default();

    tokio::spawn(consumer::run(
        con.clone(),
        state.clone(),
        broadcast_tx.clone(),
        retention,
        consumer_health.clone(),
    ));

    let app = api::router(api::AppState {
        board: state,
        valkey: con,
        broadcast_tx,
        consumer: consumer_health,
    })
    .layer(CorsLayer::permissive());
    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    tracing::info!("listening on {listen_addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}
