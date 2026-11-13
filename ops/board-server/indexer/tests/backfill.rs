//! The HISTORY backfill (spec §4.2) with a scripted transaction index in place of FastNEAR,
//! the real consumer (`server::consumer::handle`) writing the live log, and a real
//! Valkey/Redis. Skipped unless `TEST_VALKEY_URL` is set; the database is flushed.

use std::sync::Arc;
use std::time::Duration;

use common::history::{self, HistoryEntry};
use common::{keys, BoardState, QueuedEvent};
use indexer::backfill::{backfill, fetch_events};
use indexer::txindex::{AccountPage, AccountRow, TxIndex};
use redis::AsyncCommands;
use serde_json::{json, Value};
use tokio::sync::{broadcast, RwLock};

const BOARD: &str = "board.near";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

async fn connect() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    let mut con = common::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

fn now_ms() -> u64 {
    server::consumer::now_ms()
}

/// One index item: a final transaction whose single board receipt logged one `draw_many`.
fn tx(hash: &str, block: u64, at_ms: u64, artist: &str, cells: &[(u32, u32, u32)]) -> Value {
    let data: Vec<Value> = cells
        .iter()
        .map(|&(x, y, color)| {
            json!({"x": x, "y": y, "color": color, "artist": artist,
                   "written_at_ns": at_ms * 1_000_000, "credits": 1, "free": false})
        })
        .collect();
    let log = format!(
        "EVENT_JSON:{}",
        json!({"standard": "mpoo_board", "version": "1.0.0", "event": "draw_many", "data": data})
    );
    json!({
        "transaction": {"hash": hash},
        "execution_outcome": {"id": format!("tx-{hash}"), "outcome": {"receipt_ids": [format!("rc-{hash}")]}},
        "receipts": [{
            "receipt": {"receiver_id": BOARD, "predecessor_id": artist},
            "execution_outcome": {
                "id": format!("rc-{hash}"),
                "block_height": block,
                "block_timestamp": at_ms * 1_000_000,
                "index": 0,
                "outcome": {"executor_id": BOARD, "status": {"SuccessValue": ""},
                            "logs": [log], "receipt_ids": []},
            },
        }],
    })
}

/// A fixed index: everything final, `head` past the last transaction.
struct Fake {
    head: u64,
    items: Vec<Value>,
}

impl TxIndex for Fake {
    async fn head(&self) -> anyhow::Result<u64> {
        Ok(self.head)
    }
    async fn account(&self, limit: usize, _resume: Option<&str>) -> anyhow::Result<AccountPage> {
        let mut rows: Vec<AccountRow> = self
            .items
            .iter()
            .map(|t| AccountRow {
                hash: t["transaction"]["hash"].as_str().unwrap().into(),
                tx_block_height: t["receipts"][0]["execution_outcome"]["block_height"]
                    .as_u64()
                    .unwrap()
                    - 1,
            })
            .collect();
        rows.reverse(); // newest first
        Ok(AccountPage {
            txs_count: Some(rows.len() as u64),
            rows: rows.into_iter().take(limit).collect(),
            resume_token: None,
        })
    }
    async fn transactions(&self, hashes: &[String]) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .items
            .iter()
            .filter(|t| {
                hashes
                    .iter()
                    .any(|h| t["transaction"]["hash"] == h.as_str())
            })
            .cloned()
            .collect())
    }
}

/// A short history: bob paints, carol paints, alice covers two of bob's and one of carol's,
/// bob wins one back. The first two are older than the 30-day cover window.
fn chain(now: u64) -> Fake {
    Fake {
        head: 2_000,
        items: vec![
            tx(
                "t1",
                1_001,
                now - 40 * DAY_MS,
                "bob.near",
                &[(1, 1, 2), (2, 2, 2), (3, 3, 2)],
            ),
            tx("t2", 1_002, now - 35 * DAY_MS, "carol.near", &[(9, 9, 4)]),
            tx(
                "t3",
                1_003,
                now - 2 * DAY_MS,
                "alice.near",
                &[(1, 1, 5), (2, 2, 5), (9, 9, 5)],
            ),
            tx("t4", 1_004, now - DAY_MS, "bob.near", &[(1, 1, 7)]),
        ],
    }
}

async fn fetch_all(index: &Fake) -> Vec<QueuedEvent> {
    fetch_events(
        index,
        BOARD,
        1_000,
        index.head * 1_000_000,
        1,
        Duration::ZERO,
    )
    .await
    .unwrap()
}

/// Apply `events` with the real consumer, as the running server would have.
async fn apply_live(
    con: &mut redis::aio::ConnectionManager,
    state: &Arc<RwLock<BoardState>>,
    events: &[QueuedEvent],
) {
    let (tx, _rx) = broadcast::channel(64);
    for event in events {
        let raw = serde_json::to_string(event).unwrap();
        let _: () = con.lpush(keys::PROCESSING_QUEUE, &raw).await.unwrap();
        server::consumer::handle(con, state, &tx, 7_200_000, &raw)
            .await
            .unwrap();
    }
}

async fn log(con: &mut redis::aio::ConnectionManager) -> Vec<HistoryEntry> {
    history::read_log(con, keys::DRAW_HISTORY).await.unwrap().0
}

#[tokio::test]
async fn fetch_stops_at_the_mirrors_tip_and_fails_if_the_index_is_behind_it() {
    let index = chain(now_ms());
    let all = fetch_all(&index).await;
    assert_eq!(all.len(), 4);
    let blocks: Vec<u64> = all.iter().map(|e| e.block_height).collect();
    assert_eq!(blocks, [1_001, 1_002, 1_003, 1_004]);

    let to_tip = fetch_events(&index, BOARD, 1_000, all[2].position(), 1, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(to_tip, all[..3]);

    let behind = Fake {
        head: 1_002,
        items: index.items.clone(),
    };
    let err = fetch_events(&behind, BOARD, 1_000, all[3].position(), 2, Duration::ZERO)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("mirror's tip"), "{err}");
}

/// The case the backfill exists for: the consumer began logging after the board already had
/// history, and kept logging while the backfill ran.
#[tokio::test]
async fn backfill_fills_the_log_from_the_deploy_block_and_keeps_newer_live_entries() {
    let Some(mut con) = connect().await else {
        return;
    };
    let now = now_ms();
    let events = fetch_all(&chain(now)).await;

    // What a log written from the very first paint looks like, and its covers.
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    apply_live(&mut con, &state, &events).await;
    let complete = log(&mut con).await;
    assert_eq!(complete.len(), 8);
    let bob_covers: Vec<String> = con
        .zrange(history::cover_key("bob.near"), 0, -1)
        .await
        .unwrap();
    assert_eq!(bob_covers.len(), 2);

    // Now pretend logging only began at t3: drop the earlier entries and every cover set.
    let first_logged = complete
        .iter()
        .find(|e| e.block == 1_003)
        .unwrap()
        .stream_id();
    let _: () = redis::cmd("XTRIM")
        .arg(keys::DRAW_HISTORY)
        .arg("MINID")
        .arg(&first_logged)
        .query_async(&mut con)
        .await
        .unwrap();
    let _: () = con
        .del(&[
            history::cover_key("bob.near"),
            history::cover_key("carol.near"),
            history::cover_key("alice.near"),
        ])
        .await
        .unwrap();
    assert!(!history::tip_check(&mut con, 10).await.unwrap().matches());

    // The backfill read the tip when the mirror was at t3; t4 was applied (and logged) since.
    let tip = events[2].position();
    let to_tip = fetch_events(&chain(now), BOARD, 1_000, tip, 1, Duration::ZERO)
        .await
        .unwrap();
    let report = backfill(&mut con, &to_tip, tip, 64, now).await.unwrap();
    assert_eq!(report.events, 3);
    assert_eq!(report.replayed_entries, 7);
    assert_eq!(report.overlap_entries, 3, "t3's three entries, checked");
    assert_eq!(report.newer_entries, 1, "t4, kept");
    assert!(report.skipped.is_empty());
    assert!(report.tip.matches(), "{:?}", report.tip.differences);
    assert_eq!(
        log(&mut con).await,
        complete,
        "as if it had logged from the start"
    );
    let backfill_left: bool = con.exists(keys::DRAW_HISTORY_BACKFILL).await.unwrap();
    assert!(!backfill_left);

    // Covers inside the 30-day window are back exactly (t1/t2 covered nobody): alice's three
    // at t3. t4 is past the tip the backfill read, so its cover is the consumer's to write.
    let bob_after: Vec<String> = con
        .zrange(history::cover_key("bob.near"), 0, -1)
        .await
        .unwrap();
    assert_eq!(bob_after, bob_covers);
    assert_eq!(report.covers, 3);

    // The consumer keeps appending after the rename.
    apply_live(
        &mut con,
        &state,
        &[QueuedEvent {
            block_height: 1_005,
            ..events[3].clone()
        }],
    )
    .await;
    assert_eq!(log(&mut con).await.len(), 9);
    assert!(history::tip_check(&mut con, 10).await.unwrap().matches());

    // A second run changes nothing.
    let again = backfill(&mut con, &to_tip, tip, 64, now).await.unwrap();
    assert!(again.tip.matches());
    assert_eq!(log(&mut con).await.len(), 9);
}

#[tokio::test]
async fn backfill_into_an_empty_log_and_refuses_a_replay_that_disagrees() {
    let Some(mut con) = connect().await else {
        return;
    };
    let now = now_ms();
    let events = fetch_all(&chain(now)).await;
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    apply_live(&mut con, &state, &events).await;
    let complete = log(&mut con).await;

    // No log at all (a mirror that predates HISTORY).
    let _: () = con.del(keys::DRAW_HISTORY).await.unwrap();
    let tip = events[3].position();
    let report = backfill(&mut con, &events, tip, 64, now).await.unwrap();
    assert_eq!(report.overlap_entries, 0);
    assert!(report.tip.matches(), "{:?}", report.tip.differences);
    assert_eq!(log(&mut con).await, complete);

    // A replay that leaves out a paint the consumer logged must not overwrite the log.
    let missing_t3: Vec<QueuedEvent> = events
        .iter()
        .filter(|e| e.block_height != 1_003)
        .cloned()
        .collect();
    let err = backfill(&mut con, &missing_t3, tip, 64, now)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("disagrees"), "{err}");
    assert_eq!(log(&mut con).await, complete, "untouched");
}
