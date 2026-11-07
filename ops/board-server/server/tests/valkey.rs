//! Against a real Valkey/Redis. Skipped unless `TEST_VALKEY_URL` is set, e.g.
//! `redis-server --port 6391 --save ''` then `TEST_VALKEY_URL=redis://127.0.0.1:6391/15 cargo test`.
//! The database is flushed.

use std::collections::HashMap;
use std::sync::Arc;

use common::{keys, BoardEvent, BoardState, DrawEntry, QueuedEvent};
use redis::AsyncCommands;
use tokio::sync::{broadcast, RwLock};

async fn connect() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    // Set but unreachable is a failure, not a skip: a skip here once hid a dead test Valkey
    // behind four green tests.
    let mut con = server::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

fn draw(block_height: u64, seq: u32, artist: &str, cells: &[(u32, u32, u32, bool)]) -> QueuedEvent {
    QueuedEvent {
        block_height,
        block_timestamp_ms: block_height * 1000,
        seq,
        receipt_id: format!("r{block_height}-{seq}"),
        predecessor_id: artist.into(),
        event: BoardEvent::Draw {
            method: "draw_many".into(),
            entries: cells
                .iter()
                .map(|&(x, y, color, free)| DrawEntry {
                    x,
                    y,
                    color,
                    artist: Some(artist.into()),
                    written_at_ns: Some(block_height * 1_000_000_000),
                    credits: u32::from(!free),
                    free,
                })
                .collect(),
        },
    }
}

/// Queue `event` and move it to processing, as the consumer loop does, then apply it.
async fn deliver(
    con: &mut redis::aio::ConnectionManager,
    state: &Arc<RwLock<BoardState>>,
    tx: &broadcast::Sender<String>,
    event: &QueuedEvent,
) {
    let raw = serde_json::to_string(event).unwrap();
    let _: () = con.lpush(keys::PROCESSING_QUEUE, &raw).await.unwrap();
    server::consumer::handle(con, state, tx, 7_200_000, &raw)
        .await
        .unwrap();
}

async fn counts(con: &mut redis::aio::ConnectionManager, key: &str) -> HashMap<String, i64> {
    let by_id: HashMap<u32, i64> = con.hgetall(key).await.unwrap();
    let names: HashMap<u32, String> = con.hgetall(keys::ID_TO_ACCOUNT).await.unwrap();
    by_id
        .into_iter()
        .filter(|(_, n)| *n != 0)
        .map(|(id, n)| (names[&id].clone(), n))
        .collect()
}

#[tokio::test]
async fn a_redelivered_event_is_applied_once_and_state_survives_a_restart() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    let (tx, mut rx) = broadcast::channel(16);

    let first = draw(100, 0, "bob.near", &[(1, 1, 2, false), (2, 2, 3, true)]);
    let second = draw(101, 0, "alice.near", &[(1, 1, 5, false)]);
    deliver(&mut con, &state, &tx, &first).await;
    deliver(&mut con, &state, &tx, &second).await;
    // The indexer re-queues a block after a crash: the same event arrives again.
    deliver(&mut con, &state, &tx, &first).await;

    assert_eq!(
        counts(&mut con, keys::ACCOUNT_PIXEL_COUNT).await,
        HashMap::from([("bob.near".into(), 1), ("alice.near".into(), 1)])
    );
    assert_eq!(
        counts(&mut con, keys::ACCOUNT_EARNING_COUNT).await,
        HashMap::from([("alice.near".into(), 1)])
    );
    let painted: i64 = con.get(keys::PAINTED_TILES).await.unwrap();
    assert_eq!(painted, 2);
    let processing: usize = con.llen(keys::PROCESSING_QUEUE).await.unwrap();
    assert_eq!(processing, 0);

    // Two broadcasts, not three; the second names whose tile was covered.
    let _ = rx.try_recv().unwrap();
    let covered: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
    assert_eq!(covered["pixels"][0]["previous_account_id"], "bob.near");
    assert_eq!(covered["pixels"][0]["account_id"], "alice.near");
    assert!(rx.try_recv().is_err());

    // A restart loads what memory held.
    let reloaded = server::board::load(&mut con, 64).await.unwrap();
    let memory = state.read().await;
    assert_eq!(reloaded.blob, memory.blob);
    assert_eq!(reloaded.free_bits, memory.free_bits);
    assert_eq!(reloaded.written_at, memory.written_at);
    assert_eq!(reloaded.written_at_ns(1, 1), Some(101_000_000_000));
}

/// Two draws in one block: the catch-up history must still replay them in applied order, even
/// though they share a score (block time) and a zset would otherwise order ties by member text.
#[tokio::test]
async fn two_draws_in_one_block_catch_up_in_applied_order() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    let (tx, _rx) = broadcast::channel(16);

    let mut first = draw(300, 0, "alice.near", &[(1, 1, 2, false)]);
    let mut second = draw(300, 1, "bob.near", &[(1, 1, 5, false)]);
    first.block_timestamp_ms = 1_700_000_000_000;
    second.block_timestamp_ms = 1_700_000_000_000;
    deliver(&mut con, &state, &tx, &first).await;
    deliver(&mut con, &state, &tx, &second).await;

    let members: Vec<String> = con
        .zrangebyscore_limit(keys::DRAW_EVENTS_ZSET, 0u64, "+inf", 0, -1)
        .await
        .unwrap();
    let payloads: Vec<String> = members
        .iter()
        .map(|m| common::catchup_payload(m).to_owned())
        .collect();
    assert_eq!(payloads.len(), 2, "both draws are in the catch-up history");
    let first_json: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
    let second_json: serde_json::Value = serde_json::from_str(&payloads[1]).unwrap();
    assert_eq!(first_json["signer"], "alice.near", "seq 0 first");
    assert_eq!(second_json["signer"], "bob.near", "then the cover");
    assert_eq!(
        second_json["pixels"][0]["previous_account_id"],
        "alice.near"
    );
}

#[tokio::test]
async fn board_expanded_grows_the_side() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    let (tx, _rx) = broadcast::channel(16);
    let mut grow = draw(200, 0, "owner.near", &[]);
    grow.event = BoardEvent::BoardExpanded { from: 64, to: 96 };
    deliver(&mut con, &state, &tx, &grow).await;
    deliver(
        &mut con,
        &state,
        &tx,
        &draw(201, 0, "alice.near", &[(90, 90, 1, false)]),
    )
    .await;
    assert_eq!(state.read().await.side, 96);
    assert_eq!(state.read().await.pixel(90, 90).unwrap().owner_id, 1);
    assert_eq!(server::board::load(&mut con, 64).await.unwrap().side, 96);
}

#[tokio::test]
async fn recover_puts_a_stranded_event_next_in_line() {
    let Some(mut con) = connect().await else {
        return;
    };
    let _: () = con.lpush(keys::DRAW_QUEUE, "newer").await.unwrap();
    let _: () = con.lpush(keys::PROCESSING_QUEUE, "stranded").await.unwrap();
    assert_eq!(server::consumer::recover(&mut con).await.unwrap(), 1);
    // The consumer pops from the right.
    let next: String = con.rpop(keys::DRAW_QUEUE, None).await.unwrap();
    assert_eq!(next, "stranded");
}
