//! Moves events off the queue and onto the board. Port of Berry Fast's `server/src/consumer.rs`
//! with two fixes for exactly-once delivery:
//!
//! 1. At start, an event left in `processing_queue` by a crash goes back to the head of the
//!    queue (Berry Fast leaves it there, so it is never applied).
//! 2. The board write, the catch-up entry, `last_applied_position` and the `LREM` are one
//!    `MULTI`/`EXEC`, and an event at or below `last_applied_position` is dropped unapplied, so a
//!    re-delivered event cannot double-count holders.

use std::sync::Arc;
use std::time::Duration;

use common::{keys, QueuedEvent};
use redis::aio::MultiplexedConnection;
use redis::AsyncCommands;
use tokio::sync::{broadcast, RwLock};

use crate::board;
use common::BoardState;

pub async fn recover(con: &mut MultiplexedConnection) -> redis::RedisResult<usize> {
    let mut moved = 0;
    // Oldest first: the processing item predates everything still queued, so it goes to the
    // consuming (right) end of the queue.
    while let Some(_item) = redis::cmd("LMOVE")
        .arg(keys::PROCESSING_QUEUE)
        .arg(keys::DRAW_QUEUE)
        .arg("LEFT")
        .arg("RIGHT")
        .query_async::<Option<String>>(con)
        .await?
    {
        moved += 1;
    }
    Ok(moved)
}

pub async fn run(
    mut con: MultiplexedConnection,
    state: Arc<RwLock<BoardState>>,
    broadcast_tx: broadcast::Sender<String>,
    catchup_retention_ms: u64,
) {
    match recover(&mut con).await {
        Ok(0) => {}
        Ok(n) => tracing::warn!("re-queued {n} event(s) left in processing by an earlier run"),
        Err(e) => tracing::error!("could not recover the processing queue: {e}"),
    }
    loop {
        let raw: Option<String> = match redis::cmd("LMOVE")
            .arg(keys::DRAW_QUEUE)
            .arg(keys::PROCESSING_QUEUE)
            .arg("RIGHT")
            .arg("LEFT")
            .query_async(&mut con)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("LMOVE failed: {e}");
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        let Some(raw) = raw else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        if let Err(e) = handle(&mut con, &state, &broadcast_tx, catchup_retention_ms, &raw).await {
            // Leave it in processing_queue; the next start re-queues it. Stop here rather than
            // apply later events over a gap.
            tracing::error!("event not applied, consumer stops until restart: {e}");
            return;
        }
    }
}

/// Apply one raw queue entry that is already in `processing_queue`.
pub async fn handle(
    con: &mut MultiplexedConnection,
    state: &Arc<RwLock<BoardState>>,
    broadcast_tx: &broadcast::Sender<String>,
    catchup_retention_ms: u64,
    raw: &str,
) -> anyhow::Result<()> {
    let event: QueuedEvent = match serde_json::from_str(raw) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("dropping an unparseable queue entry: {e}");
            let _: () = con.lrem(keys::PROCESSING_QUEUE, 1, raw).await?;
            return Ok(());
        }
    };
    let applied_position: Option<u64> = con.get(keys::LAST_APPLIED_POSITION).await?;
    if applied_position.is_some_and(|p| event.position() <= p) {
        let _: () = con.lrem(keys::PROCESSING_QUEUE, 1, raw).await?;
        return Ok(());
    }

    let mut guard = state.write().await;
    let (applied, mut pipe) = board::apply(con, &guard, &event, catchup_retention_ms).await?;
    pipe.lrem(keys::PROCESSING_QUEUE, 1, raw).ignore();
    pipe.query_async::<()>(con).await?;
    *guard = applied.state;
    drop(guard);

    for why in &applied.skipped {
        tracing::warn!(
            "block {} receipt {}: mirror diverges: {why}",
            event.block_height,
            event.receipt_id
        );
    }
    if let Some(message) = applied.message {
        let _ = broadcast_tx.send(message.to_string());
    }
    Ok(())
}
