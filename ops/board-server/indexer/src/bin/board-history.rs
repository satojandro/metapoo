//! `board-history`: the HISTORY log's one-off tools (return-and-growth spec §4.2).
//!
//! - `board-history check`: the tip check. Rebuilds the tile state from `draw_history` and
//!   compares it with the stored board. Exit 0 when they agree, 1 when they do not. Valkey
//!   only, no network.
//! - `board-history backfill`: replays the board's events from `START_BLOCK_HEIGHT` (the deploy
//!   block) through the mirror's tip from FastNEAR's transaction index, merges them into
//!   `draw_history`, re-adds the last 30 days of cover events, then runs the check. Safe to
//!   run with the server and indexer up; safe to run twice. See `indexer/src/backfill.rs`.
//!
//! Env: `VALKEY_URL`; for `backfill` also `CONTRACT_ID`, `START_BLOCK_HEIGHT`, `INITIAL_SIDE`
//! (default 64), `CHAIN_ID` (default mainnet), `TX_INDEX_URL`, `FASTNEAR_API_KEY` (optional).

use std::time::Duration;

use common::history::TipReport;
use common::keys;
use indexer::txindex::{default_base_url, HttpTxIndex};
use redis::AsyncCommands;

fn print_tip(tip: &TipReport) {
    println!(
        "log: {} entries, blocks {:?}..{:?}; mirror tip position {:?}",
        tip.entries, tip.first_block, tip.last_block, tip.last_applied_position
    );
    if tip.matches() {
        println!("tip check: the log's tile state equals the stored board");
    } else {
        println!(
            "tip check: FAILED, {} difference(s) shown (capped):",
            tip.differences.len()
        );
        for d in &tip.differences {
            println!("  {d}");
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn env(name: &str) -> anyhow::Result<String> {
    std::env::var(name).map_err(|_| anyhow::anyhow!("{name} is required"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("indexer=info".parse()?),
        )
        .init();
    let command = std::env::args().nth(1).unwrap_or_default();
    let valkey_url =
        std::env::var("VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
    let mut con = common::valkey::connect(&valkey_url).await?;

    let tip = match command.as_str() {
        "check" => common::history::tip_check(&mut con, 50).await?,
        "backfill" => {
            let board = env("CONTRACT_ID")?;
            let start: u64 = env("START_BLOCK_HEIGHT")?.parse()?;
            let side: u32 = std::env::var("INITIAL_SIDE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(64);
            let chain = std::env::var("CHAIN_ID").unwrap_or_else(|_| "mainnet".into());
            let base = match std::env::var("TX_INDEX_URL") {
                Ok(url) => url,
                Err(_) => default_base_url(&chain)
                    .ok_or_else(|| anyhow::anyhow!("CHAIN_ID must be mainnet or testnet"))?
                    .to_string(),
            };
            let api_key = std::env::var("FASTNEAR_API_KEY")
                .ok()
                .filter(|k| !k.is_empty());
            let Some(through): Option<u64> = con.get(keys::LAST_APPLIED_POSITION).await? else {
                anyhow::bail!("the mirror has applied nothing yet; there is no tip to backfill to")
            };
            let index = HttpTxIndex::new(&base, &board, api_key)?;
            let events = indexer::backfill::fetch_events(
                &index,
                &board,
                start,
                through,
                30,
                Duration::from_secs(2),
            )
            .await?;
            let report =
                indexer::backfill::backfill(&mut con, &events, through, side, now_ms()).await?;
            println!(
                "replayed {} events into {} entries; {} already logged and matching; {} newer kept; {} recent covers",
                report.events,
                report.replayed_entries,
                report.overlap_entries,
                report.newer_entries,
                report.covers
            );
            for why in &report.skipped {
                println!("  not applied (the contract would reject it): {why}");
            }
            report.tip
        }
        _ => {
            eprintln!("usage: board-history check | board-history backfill");
            std::process::exit(2);
        }
    };
    print_tip(&tip);
    if !tip.matches() {
        std::process::exit(1);
    }
    Ok(())
}
