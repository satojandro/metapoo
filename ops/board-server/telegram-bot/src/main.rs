//! The Telegram alerts bot (AWAY-B). See `lib.rs` and the board server README.
//!
//! Env: `TELEGRAM_BOT_TOKEN` (from BotFather; empty = do nothing), `VALKEY_URL`, `WALL_URL`
//! (the wall's public address, for the "Open the wall" button), `ALERT_MIN_GAP_MS` (default
//! one hour), `ALERT_SETTLE_MS` (default two minutes), `ALERT_TICK_MS` (default 15 s).

use std::time::Duration;

use telegram_bot::alerts::{self, AlertConfig, Pacer};
use telegram_bot::bot;
use telegram_bot::tg::{HttpTelegram, TgError};

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term.recv() => {},
    }
}

async fn poll_loop(mut con: redis::aio::ConnectionManager, tg: &HttpTelegram, wall: Option<&str>) {
    loop {
        let wait = match bot::poll_once(&mut con, tg, wall, now_ms).await {
            Ok(_) => 0,
            Err(TgError::RetryAfter(seconds)) => seconds.max(1),
            Err(TgError::Conflict) => {
                tracing::error!(
                    "409 from getUpdates: a webhook is set for this bot, or a second copy is \
                     polling with the same token. Retrying in 30 s."
                );
                30
            }
            Err(TgError::Unauthorized) => {
                tracing::error!("Telegram refuses TELEGRAM_BOT_TOKEN. Retrying in 5 min.");
                300
            }
            Err(e) => {
                tracing::warn!("getUpdates: {e:?}");
                5
            }
        };
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

async fn alert_loop(
    mut con: redis::aio::ConnectionManager,
    tg: &HttpTelegram,
    config: AlertConfig,
    tick_ms: u64,
) {
    let mut pacer = Pacer::default();
    loop {
        if let Err(e) = bot::drain_notices(&mut con, tg).await {
            tracing::warn!("notices: {e}");
        }
        match alerts::tick(&mut con, tg, &config, &mut pacer, now_ms()).await {
            Ok(report) if report != alerts::TickReport::default() => {
                tracing::info!(
                    "alerts: {} sent, {} unlinked (blocked), {} failed",
                    report.sent,
                    report.unlinked,
                    report.failed
                );
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("alerts: {e}"),
        }
        tokio::time::sleep(Duration::from_millis(tick_ms)).await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("telegram_bot=info".parse()?),
        )
        .init();

    let token = std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        // Exiting would make `restart: unless-stopped` start it again, for ever. Stay up,
        // do nothing, and say why once.
        tracing::warn!(
            "TELEGRAM_BOT_TOKEN is not set: the bot is idle. Set it in .env and restart."
        );
        shutdown_signal().await;
        return Ok(());
    }
    let wall_url = std::env::var("WALL_URL")
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());
    if wall_url.is_none() {
        tracing::warn!("WALL_URL is not set: alerts will have no \"Open the wall\" button.");
    }
    let config = AlertConfig {
        wall_url: wall_url.clone(),
        min_gap_ms: env_or("ALERT_MIN_GAP_MS", AlertConfig::default().min_gap_ms),
        settle_ms: env_or("ALERT_SETTLE_MS", AlertConfig::default().settle_ms),
        ..AlertConfig::default()
    };
    let tick_ms: u64 = env_or("ALERT_TICK_MS", 15_000);
    let valkey_url: String = env_or("VALKEY_URL", "redis://127.0.0.1:6379".to_string());

    let tg = HttpTelegram::new(token.trim())?;
    match tg.get_me().await {
        Ok(username) => tracing::info!("signed in to Telegram as @{username}"),
        // Not fatal: the loops below keep trying and say what is wrong.
        Err(e) => tracing::error!("getMe failed: {e:?}"),
    }
    let con = common::valkey::connect(&valkey_url).await?;

    tokio::select! {
        _ = poll_loop(con.clone(), &tg, wall_url.as_deref()) => {},
        _ = alert_loop(con, &tg, config, tick_ms.max(1_000)) => {},
        _ = shutdown_signal() => tracing::info!("shutting down"),
    }
    Ok(())
}
