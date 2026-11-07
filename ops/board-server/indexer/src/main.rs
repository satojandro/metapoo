//! Indexer: finds the board's events and queues them in Valkey for the server.
//!
//! Two sources, chosen by `INDEX_MODE`:
//!
//! - **`txindex`** (default): FastNEAR's transaction index, polled only while someone is
//!   watching or right after a paint hint (`common/src/demand.rs`, `indexer/src/txindex.rs`).
//!   It costs nothing with nobody watching, two small requests per poll while watching, and
//!   about one per 20 paint transactions. A cold start reads the board's history in ~20
//!   requests.
//! - **`stream`**: Berry Fast's design, every final block from NEAR Data. It costs one request
//!   per block forever: ~6,200 an hour on mainnet, idle or not (the owner's dashboard, 7 Nov).
//!   Keep it for a bounded replay (`END_BLOCK_HEIGHT`), not for running.
//!
//! Env, both modes: `CONTRACT_ID` (the board, required), `CHAIN_ID` (mainnet|testnet),
//! `START_BLOCK_HEIGHT` (first run only: the board's deploy block), `VALKEY_URL`.
//! `txindex`: `POLL_MS` (default 30,000, while watched), `TX_INDEX_URL` (default by chain),
//! `FASTNEAR_API_KEY` (optional; unset, the index is read anonymously).
//! `stream`: `END_BLOCK_HEIGHT`, `NUM_THREADS` (default 4), `AUTH_BEARER_TOKEN`.

use fastnear_neardata_fetcher::{start_fetcher, FetcherConfigBuilder};
use fastnear_primitives::types::ChainId;
use redis::AsyncCommands;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use common::demand::{should_poll, Signals};
use common::keys;
use indexer::txindex::{Cursor, HttpTxIndex};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("indexer=info".parse()?)
                .add_directive("neardata-fetcher=info".parse()?),
        )
        .init();

    let board = std::env::var("CONTRACT_ID")
        .map_err(|_| anyhow::anyhow!("CONTRACT_ID (the board account) is required"))?;
    let chain_id =
        ChainId::try_from(std::env::var("CHAIN_ID").unwrap_or_else(|_| "mainnet".into()))
            .map_err(|e| anyhow::anyhow!("CHAIN_ID: {e:?}"))?;
    let valkey_url =
        std::env::var("VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    // Reconnects in the background, with bounded waits (common/src/valkey.rs): the retry loop
    // below must survive a Valkey restart.
    let mut con = common::valkey::connect(&valkey_url).await?;

    let mode = std::env::var("INDEX_MODE").unwrap_or_else(|_| "txindex".into());
    if mode == "txindex" {
        return run_txindex(con, board, chain_id).await;
    }
    if mode != "stream" {
        anyhow::bail!("INDEX_MODE must be txindex or stream, not {mode}");
    }

    let resume: Option<u64> = con.get(keys::LAST_PROCESSED_BLOCK).await?;
    let env_u64 = |name: &str| std::env::var(name).ok().and_then(|s| s.parse::<u64>().ok());
    let start_block = resume
        .map(|h| h + 1)
        .or_else(|| env_u64("START_BLOCK_HEIGHT"));
    if start_block.is_none() {
        // Without a start the fetcher begins at the tip, and the wall would miss its history.
        anyhow::bail!("set START_BLOCK_HEIGHT to the board's deploy block for the first run");
    }
    let end_block = env_u64("END_BLOCK_HEIGHT");
    tracing::info!(target: "indexer", "board {board} on {chain_id}: blocks {start_block:?}..{end_block:?}");

    let is_running = Arc::new(AtomicBool::new(true));
    signal_hook::flag::register_conditional_default(
        signal_hook::consts::SIGINT,
        is_running.clone(),
    )?;
    signal_hook::flag::register_conditional_default(
        signal_hook::consts::SIGTERM,
        is_running.clone(),
    )?;

    let threads = env_u64("NUM_THREADS").unwrap_or(4);
    let mut builder = FetcherConfigBuilder::new()
        .num_threads(threads)
        .chain_id(chain_id);
    if let Some(h) = start_block {
        builder = builder.start_block_height(h);
    }
    if let Some(h) = end_block {
        builder = builder.end_block_height(h);
    }
    if let Ok(token) = std::env::var("AUTH_BEARER_TOKEN") {
        builder = builder.auth_bearer_token(token);
    }
    let (blocks_tx, mut blocks_rx) = mpsc::channel(100);
    let fetcher_running = is_running.clone();
    let config = builder.build();
    let fetcher =
        tokio::spawn(async move { start_fetcher(config, blocks_tx, fetcher_running).await });

    let mut processed: u64 = 0;
    while is_running.load(Ordering::SeqCst) {
        let Some(block) = blocks_rx.recv().await else {
            break;
        };
        let height = block.block.header.height;
        let (events, warnings) = indexer::extract_events(&block, &board);
        for w in &warnings {
            tracing::warn!(target: "indexer", "{w}");
        }

        // Events and the resume height move together: a crash re-queues the whole block or
        // none of it. The server also skips anything at or below its last applied position.
        let mut pipe = redis::pipe();
        pipe.atomic();
        for event in &events {
            pipe.lpush(keys::DRAW_QUEUE, serde_json::to_string(event)?)
                .ignore();
        }
        pipe.set(keys::LAST_PROCESSED_BLOCK, height).ignore();
        loop {
            match pipe.query_async::<()>(&mut con).await {
                Ok(()) => break,
                Err(e) => {
                    // Never skip a block: retry until Valkey takes it.
                    tracing::error!(target: "indexer", "block {height}: queue write failed, retrying: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
        if !events.is_empty() {
            tracing::info!(target: "indexer", "block {height}: queued {} board events", events.len());
        }
        processed += 1;
        if processed.is_multiple_of(1000) {
            tracing::info!(target: "indexer", "processed {processed} blocks (latest {height})");
        }
        if end_block.is_some_and(|end| height >= end) {
            tracing::info!(target: "indexer", "reached END_BLOCK_HEIGHT {height}");
            break;
        }
    }
    fetcher.abort();
    tracing::info!(target: "indexer", "stopped");
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Queue `events` and move the watermark in one transaction, retrying until Valkey takes it.
async fn commit(
    con: &mut redis::aio::ConnectionManager,
    events: &[common::QueuedEvent],
    watermark: u64,
) -> anyhow::Result<()> {
    let mut pipe = redis::pipe();
    pipe.atomic();
    for event in events {
        pipe.lpush(keys::DRAW_QUEUE, serde_json::to_string(event)?)
            .ignore();
    }
    pipe.set(keys::LAST_PROCESSED_BLOCK, watermark).ignore();
    loop {
        match pipe.query_async::<()>(con).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::error!(target: "indexer", "queue write failed, retrying: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}

async fn run_txindex(
    mut con: redis::aio::ConnectionManager,
    board: String,
    chain_id: ChainId,
) -> anyhow::Result<()> {
    let base = std::env::var("TX_INDEX_URL").unwrap_or_else(|_| match chain_id {
        ChainId::Mainnet => "https://tx.main.fastnear.com".into(),
        ChainId::Testnet => "https://tx.test.fastnear.com".into(),
    });
    let api_key = std::env::var("FASTNEAR_API_KEY")
        .ok()
        .filter(|k| !k.is_empty());
    let poll_ms: u64 = std::env::var("POLL_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30_000);
    let index = HttpTxIndex::new(&base, &board, api_key)?;

    let resume: Option<u64> = con.get(keys::LAST_PROCESSED_BLOCK).await?;
    let start: Option<u64> = std::env::var("START_BLOCK_HEIGHT")
        .ok()
        .and_then(|s| s.parse().ok());
    let watermark = match (resume, start) {
        (Some(w), _) => w,
        // Everything from the deploy block on is unseen.
        (None, Some(h)) => h.saturating_sub(1),
        (None, None) => {
            anyhow::bail!("set START_BLOCK_HEIGHT to the board's deploy block for the first run")
        }
    };
    tracing::info!(target: "indexer", "board {board}: tx index {base}, from block {watermark}, polling every {poll_ms} ms while watched");

    // Set by SIGINT / SIGTERM; the loop finishes its current poll and exits.
    let stop = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGINT, stop.clone())?;
    signal_hook::flag::register(signal_hook::consts::SIGTERM, stop.clone())?;

    let mut cursor = Cursor::new(watermark);
    let mut last_poll_ms = 0;
    let mut last_event_ms = 0;
    let mut requests_this_hour: u64 = 0;
    let mut hour_started = now_ms();
    while !stop.load(Ordering::SeqCst) {
        let viewers_until_ms: Option<u64> = con.get(keys::VIEWERS_UNTIL_MS).await.unwrap_or(None);
        let hint_at_ms: Option<u64> = con.get(keys::HINT_AT_MS).await.unwrap_or(None);
        let viewer_arrived_ms: Option<u64> = con.get(keys::VIEWER_ARRIVED_MS).await.unwrap_or(None);
        let now = now_ms();
        let signals = Signals {
            now_ms: now,
            viewers_until_ms: viewers_until_ms.unwrap_or(0),
            hint_at_ms: hint_at_ms.unwrap_or(0),
            last_poll_ms,
            last_event_ms,
            viewer_arrived_ms: viewer_arrived_ms.unwrap_or(0),
        };
        if should_poll(signals, poll_ms) {
            last_poll_ms = now;
            match cursor.poll(&board, &index).await {
                Ok(result) => {
                    requests_this_hour += u64::from(result.requests);
                    tracing::info!(target: "indexer", "poll: {} requests, watermark {}", result.requests, result.watermark);
                    for w in &result.warnings {
                        tracing::warn!(target: "indexer", "{w}");
                    }
                    commit(&mut con, &result.events, result.watermark).await?;
                    if !result.events.is_empty() {
                        last_event_ms = now_ms();
                        tracing::info!(target: "indexer", "queued {} board events through block {} ({} requests)", result.events.len(), result.watermark, result.requests);
                    }
                }
                Err(e) => {
                    tracing::warn!(target: "indexer", "tx index poll failed, next at the usual interval: {e}")
                }
            }
        }
        if now.saturating_sub(hour_started) >= 3_600_000 {
            tracing::info!(target: "indexer", "{requests_this_hour} tx index requests in the last hour");
            requests_this_hour = 0;
            hour_started = now;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    tracing::info!(target: "indexer", "stopped");
    Ok(())
}
