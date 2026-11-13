//! One-off HISTORY backfill (return-and-growth spec §4.2): rebuild `draw_history` from the
//! deploy block by replaying the board's events, so the log starts at the first paint and not
//! at the day the consumer began writing it.
//!
//! 1. [`fetch_events`] reads every board event from the deploy block through the mirror's
//!    tip (`last_applied_position`) from the transaction index, the same source and ordering
//!    as the running indexer (`txindex.rs`).
//! 2. [`backfill`] replays them on an empty board (`common::history::Replay`, the consumer's
//!    rules) and refuses to write anything unless the replay agrees, entry for entry, with
//!    whatever the consumer has already logged up to the tip.
//! 3. It builds the replayed log in `draw_history:backfill`, then one Lua script (atomic, so
//!    the consumer cannot append in between) copies across the live entries newer than the
//!    replay and renames the result over `draw_history`.
//! 4. It re-adds the cover events of the last 30 days (members are deterministic, so the ones
//!    the consumer already wrote are unchanged), then runs the tip check.
//!
//! `board_expanded` events are replayed into the log too (TIMELAPSE, spec §4.3). A log written
//! by a server from before that existed holds draws but no expansions; the replay's are added,
//! never dropped, and a live expansion the replay does not reproduce stops the run like a
//! disagreeing draw does.
//!
//! When it succeeds it writes the **genesis marker** (`draw_history:genesis`: the deploy block
//! and the side there): the log now starts at the first paint, and `GET /api/history/head`
//! says `complete: true`. When it rewrote the stream it also replaces `draw_history:epoch`, which
//! is part of every cacheable history page URL.
//!
//! Re-running it is safe: the second run replays the same entries, finds the log already equal
//! to them and rewrites nothing.

use std::time::Duration;

use common::history::{self, Cover, Expansion, HistoryEntry, LogRow, Replay, TipReport};
use common::{keys, QueuedEvent, SEQ_PER_BLOCK};
use redis::aio::ConnectionManager;

use crate::txindex::{Cursor, TxIndex};

/// Every board event from `start_block` (the deploy block) through `through_position`, in
/// applied order. Polls `index` until its watermark reaches the tip's block, at most
/// `max_polls` times, `wait` apart (an unfinished transaction holds the watermark back).
pub async fn fetch_events(
    index: &impl TxIndex,
    board: &str,
    start_block: u64,
    through_position: u64,
    max_polls: u32,
    wait: Duration,
) -> anyhow::Result<Vec<QueuedEvent>> {
    let through_block = through_position / SEQ_PER_BLOCK;
    let mut cursor = Cursor::new(start_block.saturating_sub(1));
    let mut events = Vec::new();
    for poll in 0..max_polls.max(1) {
        if poll > 0 {
            tokio::time::sleep(wait).await;
        }
        let result = cursor.poll(board, index).await?;
        for w in &result.warnings {
            tracing::warn!(target: "indexer", "{w}");
        }
        events.extend(
            result
                .events
                .into_iter()
                .filter(|e| e.position() <= through_position),
        );
        if cursor.watermark >= through_block {
            return Ok(events);
        }
    }
    anyhow::bail!(
        "the index reached block {} but the mirror's tip is block {through_block}",
        cursor.watermark
    )
}

/// What a backfill did.
#[derive(Debug)]
pub struct BackfillReport {
    pub events: usize,
    /// Entries the replay produced (deploy block through the tip).
    pub replayed_entries: usize,
    /// `board_expanded` entries the replay produced.
    pub replayed_expansions: usize,
    /// True when the stream was rebuilt; false when it already equalled the replay.
    pub rewritten: bool,
    /// Entries the consumer had already logged at or below the tip; all matched the replay.
    pub overlap_entries: usize,
    /// Live entries above the replay, copied across by the merge.
    pub newer_entries: usize,
    /// Cover events of the last 30 days re-added.
    pub covers: usize,
    /// Entries the replay could not apply (the contract would have rejected them).
    pub skipped: Vec<String>,
    pub tip: TipReport,
}

/// Copy the live entries newer than the backfill's last one into it, then rename it over the
/// live key. Atomic: the consumer's next `XADD` lands either before (and is copied) or after
/// (on the renamed stream, whose last id is now the largest). The epoch and the genesis marker
/// move in the same script, so a reader never sees the new log under the old epoch.
const MERGE: &str = r"
local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
if #last == 0 then return -1 end
local rows = redis.call('XRANGE', KEYS[1], '(' .. last[1][1], '+')
for _, row in ipairs(rows) do
  redis.call('XADD', KEYS[2], row[1], unpack(row[2]))
end
redis.call('RENAME', KEYS[2], KEYS[1])
local epoch = tonumber(redis.call('GET', KEYS[3]) or '0')
redis.call('SET', KEYS[3], math.max(epoch + 1, tonumber(ARGV[3])))
redis.call('HSET', KEYS[4], 'start_block', ARGV[1], 'initial_side', ARGV[2])
return #rows
";

/// Entries per write pipeline.
const CHUNK: usize = 1_000;

fn key(e: &HistoryEntry) -> (u64, u32) {
    (e.position, e.index)
}

/// Replay `events` (deploy block through `through_position`) and merge the result into
/// `draw_history`. See the module docs; `start_block` and `initial_side` are the deploy block and
/// the side there (they become the genesis marker); `now_ms` sets the 30-day cover window.
pub async fn backfill(
    con: &mut ConnectionManager,
    events: &[QueuedEvent],
    through_position: u64,
    start_block: u64,
    initial_side: u32,
    now_ms: u64,
) -> anyhow::Result<BackfillReport> {
    let mut ordered: Vec<&QueuedEvent> = events
        .iter()
        .filter(|e| e.position() <= through_position)
        .collect();
    ordered.sort_by_key(|e| e.position());
    ordered.dedup_by_key(|e| e.position());

    let mut replay = Replay::new(initial_side);
    let mut entries: Vec<HistoryEntry> = Vec::new();
    let mut rows: Vec<LogRow> = Vec::new();
    let mut covers: Vec<Cover> = Vec::new();
    let mut skipped = Vec::new();
    for event in &ordered {
        let out = replay.apply(event);
        rows.extend(out.rows());
        entries.extend(out.entries);
        covers.extend(out.covers);
        skipped.extend(
            out.skipped
                .into_iter()
                .map(|why| format!("block {}: {why}", event.block_height)),
        );
    }

    // What the consumer already wrote, up to the tip, must be exactly the replay's tail.
    let (live_rows, _) = history::read_rows(con, keys::DRAW_HISTORY).await?;
    let live = history::draws(&live_rows);
    let live_to_tip: Vec<&HistoryEntry> = live
        .iter()
        .filter(|e| e.position <= through_position)
        .collect();
    let newer_entries = live.len() - live_to_tip.len();
    if let Some(first_live) = live_to_tip.first() {
        let replay_tail: Vec<&HistoryEntry> = entries
            .iter()
            .filter(|e| key(e) >= key(first_live))
            .collect();
        if replay_tail != live_to_tip {
            let at = replay_tail
                .iter()
                .zip(&live_to_tip)
                .position(|(a, b)| a != b)
                .unwrap_or(replay_tail.len().min(live_to_tip.len()));
            anyhow::bail!(
                "the replay disagrees with the live log at its entry {at} (replay {:?}, live {:?}); nothing written",
                replay_tail.get(at),
                live_to_tip.get(at)
            );
        }
    }
    // Expansions: the live log may lack some (a server from before they were logged wrote
    // none), but any it holds must be one the replay produced.
    let replayed_expansions = history::expansions(&rows);
    let live_expansions: Vec<Expansion> = history::expansions(&live_rows)
        .into_iter()
        .filter(|e| e.position <= through_position)
        .collect();
    if let Some(stray) = live_expansions
        .iter()
        .find(|e| !replayed_expansions.contains(e))
    {
        anyhow::bail!(
            "the live log holds {stray:?}, which the replay does not produce; nothing written"
        );
    }

    // Already equal to the replay (a second run): leave the stream and its epoch alone.
    let rewritten = !rows.is_empty()
        && (live_to_tip.len() != entries.len() || live_expansions != replayed_expansions);
    if rewritten {
        let _: () = redis::cmd("DEL")
            .arg(keys::DRAW_HISTORY_BACKFILL)
            .query_async(con)
            .await?;
        for chunk in rows.chunks(CHUNK) {
            let mut pipe = redis::pipe();
            for row in chunk {
                row.xadd(&mut pipe, keys::DRAW_HISTORY_BACKFILL);
            }
            pipe.query_async::<()>(con).await?;
        }
        let copied: i64 = redis::Script::new(MERGE)
            .key(keys::DRAW_HISTORY)
            .key(keys::DRAW_HISTORY_BACKFILL)
            .key(keys::DRAW_HISTORY_EPOCH)
            .key(keys::DRAW_HISTORY_GENESIS)
            .arg(start_block)
            .arg(initial_side)
            .arg(now_ms)
            .invoke_async(con)
            .await?;
        tracing::info!(target: "indexer", "backfilled {} entries and {} expansions, kept {copied} newer live ones", entries.len(), replayed_expansions.len());
    } else {
        // Nothing to rewrite, and the comparison above passed: the log does start at the
        // deploy block. Say so.
        let _: () = redis::cmd("HSET")
            .arg(keys::DRAW_HISTORY_GENESIS)
            .arg("start_block")
            .arg(start_block)
            .arg("initial_side")
            .arg(initial_side)
            .query_async(con)
            .await?;
    }

    let recent: Vec<Cover> = covers
        .into_iter()
        .filter(|c| c.at_ms.saturating_add(history::COVER_RETENTION_MS) >= now_ms)
        .collect();
    for chunk in recent.chunks(CHUNK) {
        let mut pipe = redis::pipe();
        history::add_covers(&mut pipe, chunk, now_ms, now_ms);
        pipe.query_async::<()>(con).await?;
    }

    let tip = history::tip_check(con, 50).await?;
    Ok(BackfillReport {
        events: ordered.len(),
        replayed_entries: entries.len(),
        replayed_expansions: replayed_expansions.len(),
        rewritten,
        overlap_entries: live_to_tip.len(),
        newer_entries,
        covers: recent.len(),
        skipped,
        tip,
    })
}
