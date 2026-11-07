//! Indexer: streams every final block from NEAR Data and queues the board's events in Valkey.
//! Port of Berry Fast's `backend/indexer/src/main.rs`.
//!
//! Env: `CONTRACT_ID` (the board, required), `CHAIN_ID` (mainnet|testnet, default mainnet),
//! `START_BLOCK_HEIGHT` (first run only: the board's deploy block), `END_BLOCK_HEIGHT` (optional,
//! for a bounded replay), `NUM_THREADS` (fetch parallelism, default 4 as Berry Fast),
//! `AUTH_BEARER_TOKEN` (optional NEAR Data token), `VALKEY_URL`.

use fastnear_neardata_fetcher::{start_fetcher, FetcherConfigBuilder};
use fastnear_primitives::types::ChainId;
use redis::AsyncCommands;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use common::keys;

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
    // Reconnects in the background: the retry loop below must survive a Valkey restart.
    let mut con = redis::Client::open(valkey_url)?
        .get_connection_manager()
        .await?;

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
