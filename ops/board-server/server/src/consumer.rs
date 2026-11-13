//! Moves events off the queue and onto the board. Port of Berry Fast's `server/src/consumer.rs`
//! with three fixes:
//!
//! 1. At start, an event left in `processing_queue` by a crash goes back to the head of the
//!    queue (Berry Fast leaves it there, so it is never applied).
//! 2. The board write, the catch-up entry, the history log and cover sets
//!    (`common/src/history.rs`), `last_applied_position` and the `LREM` are one
//!    `MULTI`/`EXEC`, and an event at or below `last_applied_position` is dropped unapplied, so a
//!    re-delivered event cannot double-count holders.
//! 3. A failure retries the **same** event with backoff instead of ending the task. Skipping it
//!    would leave a permanent gap; exiting would freeze the mirror while `/api/health` still
//!    answered. `Health` is what lets that endpoint tell the difference.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{keys, QueuedEvent};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use tokio::sync::{broadcast, RwLock};

use crate::board;
use common::BoardState;

/// Wall-clock milliseconds since the epoch, for liveness stamps.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long without a tick before the consumer is called stalled. The loop stamps itself every
/// 50 ms when idle and on every retry, so a minute of silence means the task is gone.
pub const STALL_AFTER_MS: u64 = 60_000;

/// First backoff after a failure; doubles to [`MAX_BACKOFF_MS`].
const FIRST_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;

/// Liveness of the consumer task, read by `/api/health`.
///
/// Without it the endpoint could only report what Valkey held, so a consumer that had exited
/// looked exactly like a healthy one: the queue grew on one side and nothing said so.
#[derive(Clone, Default)]
pub struct Health(Arc<Inner>);

#[derive(Default)]
struct Inner {
    last_tick_ms: AtomicU64,
    failures: AtomicU64,
}

/// `Health` as the endpoint sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub last_tick_ms: u64,
    /// Attempts failing right now; 0 means the last one worked.
    pub failures: u64,
}

impl Health {
    /// The loop is alive: it is about to do, or has just done, something.
    pub fn tick(&self, now_ms: u64) {
        self.0.last_tick_ms.store(now_ms, Ordering::Relaxed);
    }

    /// Valkey answered and the event applied (or the queue was empty): nothing is stuck.
    pub fn note_ok(&self) {
        self.0.failures.store(0, Ordering::Relaxed);
    }

    /// One attempt failed and is being retried.
    pub fn note_failure(&self) {
        self.0.failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> HealthSnapshot {
        HealthSnapshot {
            last_tick_ms: self.0.last_tick_ms.load(Ordering::Relaxed),
            failures: self.0.failures.load(Ordering::Relaxed),
        }
    }
}

/// `ok`, `degraded` (retrying) or `stalled` (no tick within [`STALL_AFTER_MS`]).
///
/// A process that has not ticked yet reads `stalled`, which is the safe answer: a check that
/// arrives before the first loop iteration must not conclude the mirror is being maintained.
pub fn status(now_ms: u64, snapshot: HealthSnapshot) -> &'static str {
    if snapshot.last_tick_ms == 0 || now_ms.saturating_sub(snapshot.last_tick_ms) > STALL_AFTER_MS {
        return "stalled";
    }
    if snapshot.failures > 0 {
        return "degraded";
    }
    "ok"
}

/// Put back events an earlier run left in `processing_queue`, oldest first.
pub async fn recover(con: &mut ConnectionManager) -> redis::RedisResult<usize> {
    let mut moved = 0;
    // `RPOPLPUSH` pushes each consumed event to the *left* of processing, so its right end is
    // the oldest. Each move lands on the consuming (right) end of the queue, and the last one
    // moved — the oldest — ends up rightmost, i.e. first to be consumed.
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

/// Take the oldest queued event, if any. `None` means the queue is empty.
async fn next_event(con: &mut ConnectionManager) -> redis::RedisResult<Option<String>> {
    redis::cmd("LMOVE")
        .arg(keys::DRAW_QUEUE)
        .arg(keys::PROCESSING_QUEUE)
        .arg("RIGHT")
        .arg("LEFT")
        .query_async(con)
        .await
}

pub async fn run(
    mut con: ConnectionManager,
    state: Arc<RwLock<BoardState>>,
    broadcast_tx: broadcast::Sender<String>,
    catchup_retention_ms: u64,
    health: Health,
) {
    match recover(&mut con).await {
        Ok(0) => {}
        Ok(n) => tracing::warn!("re-queued {n} event(s) left in processing by an earlier run"),
        Err(e) => tracing::error!("could not recover the processing queue: {e}"),
    }
    loop {
        health.tick(now_ms());
        let raw = match next_event(&mut con).await {
            Ok(Some(raw)) => {
                health.note_ok();
                raw
            }
            Ok(None) => {
                health.note_ok();
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            Err(e) => {
                tracing::error!("LMOVE failed: {e}");
                health.note_failure();
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        };
        retry_until_applied(
            &mut con,
            &state,
            &broadcast_tx,
            catchup_retention_ms,
            &health,
            &raw,
        )
        .await;
    }
}

/// Apply one already-popped event, retrying it with backoff. Returns on success only.
///
/// Retrying the same event is safe: `handle` drops anything at or below
/// `last_applied_position`, so a failure *after* the transaction committed is a no-op and one
/// *before* it re-applies cleanly. The alternative — skipping it — leaves the board wrong from
/// that block on, and the consumer is the only writer, so nothing else can heal it.
async fn retry_until_applied(
    con: &mut ConnectionManager,
    state: &Arc<RwLock<BoardState>>,
    broadcast_tx: &broadcast::Sender<String>,
    catchup_retention_ms: u64,
    health: &Health,
    raw: &str,
) {
    let mut backoff = Duration::from_millis(FIRST_BACKOFF_MS);
    loop {
        health.tick(now_ms());
        match handle(con, state, broadcast_tx, catchup_retention_ms, raw).await {
            Ok(()) => {
                health.note_ok();
                return;
            }
            Err(e) => {
                health.note_failure();
                tracing::error!("event not applied, retrying in {backoff:?}: {e}");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_millis(MAX_BACKOFF_MS));
            }
        }
    }
}

/// Apply one raw queue entry that is already in `processing_queue`.
pub async fn handle(
    con: &mut ConnectionManager,
    state: &Arc<RwLock<BoardState>>,
    broadcast_tx: &broadcast::Sender<String>,
    catchup_retention_ms: u64,
    raw: &str,
) -> anyhow::Result<()> {
    let event: QueuedEvent = match serde_json::from_str(raw) {
        Ok(e) => e,
        Err(e) => {
            // Not an event we can ever apply: dropping it is the only way forward, and the log
            // is the record.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(last_tick_ms: u64, failures: u64) -> HealthSnapshot {
        HealthSnapshot {
            last_tick_ms,
            failures,
        }
    }

    #[test]
    fn a_fresh_process_is_not_called_healthy() {
        assert_eq!(status(1_000, at(0, 0)), "stalled");
    }

    #[test]
    fn a_recent_tick_is_ok_and_a_retry_is_degraded() {
        let now = 10 * STALL_AFTER_MS;
        assert_eq!(status(now, at(now - 1, 0)), "ok");
        assert_eq!(status(now, at(now - 1, 2)), "degraded");
        // The boundary: exactly one window old is still alive, a millisecond more is not.
        assert_eq!(status(now, at(now - STALL_AFTER_MS, 0)), "ok");
        assert_eq!(status(now, at(now - STALL_AFTER_MS - 1, 0)), "stalled");
    }

    #[test]
    fn clearing_failures_returns_to_ok() {
        let health = Health::default();
        let now = 5_000;
        health.tick(now);
        health.note_failure();
        assert_eq!(status(now, health.snapshot()), "degraded");
        health.note_ok();
        assert_eq!(status(now, health.snapshot()), "ok");
    }
}
