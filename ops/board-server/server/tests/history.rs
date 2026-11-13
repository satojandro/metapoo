//! HISTORY (spec §4.2) and AWAY-A (spec §1.2) against a real Valkey/Redis: the consumer's log
//! append, the cover sets, and `GET /api/account-covers`. Skipped unless `TEST_VALKEY_URL` is
//! set (see `tests/valkey.rs`). The database is flushed.

use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::history::{self, COVER_RETENTION_MS};
use common::{keys, BoardEvent, BoardState, DrawEntry, QueuedEvent};
use redis::AsyncCommands;
use tokio::sync::{broadcast, RwLock};
use tower::ServiceExt;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

async fn connect() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    let mut con = server::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

/// A draw at `at_ms` (block time and every tile's `written_at`).
fn draw(
    block_height: u64,
    seq: u32,
    at_ms: u64,
    artist: &str,
    cells: &[(u32, u32, u32, bool)],
) -> QueuedEvent {
    QueuedEvent {
        block_height,
        block_timestamp_ms: at_ms,
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
                    written_at_ns: Some(at_ms * 1_000_000),
                    credits: u32::from(!free),
                    free,
                })
                .collect(),
        },
    }
}

async fn deliver(
    con: &mut redis::aio::ConnectionManager,
    state: &Arc<RwLock<BoardState>>,
    event: &QueuedEvent,
) {
    let (tx, _rx) = broadcast::channel(16);
    let raw = serde_json::to_string(event).unwrap();
    let _: () = con.lpush(keys::PROCESSING_QUEUE, &raw).await.unwrap();
    server::consumer::handle(con, state, &tx, 7_200_000, &raw)
        .await
        .unwrap();
}

fn now_ms() -> u64 {
    server::consumer::now_ms()
}

#[tokio::test]
async fn the_consumer_appends_every_applied_tile_once_and_the_tip_matches_the_blob() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    let t = now_ms() - DAY_MS;
    let first = draw(100, 0, t, "bob.near", &[(1, 1, 2, false), (2, 2, 3, true)]);
    let second = draw(101, 0, t + 1_000, "alice.near", &[(1, 1, 5, false)]);
    // Off the 64 x 64 board: the contract rejects it, so nothing is logged.
    let rejected = draw(102, 0, t + 2_000, "alice.near", &[(90, 90, 1, false)]);
    deliver(&mut con, &state, &first).await;
    deliver(&mut con, &state, &second).await;
    deliver(&mut con, &state, &rejected).await;
    // Re-delivered after an indexer crash: the position guard drops it, so no second entry.
    deliver(&mut con, &state, &first).await;

    let (log, _) = history::read_log(&mut con, keys::DRAW_HISTORY)
        .await
        .unwrap();
    let ids: Vec<String> = log.iter().map(|e| e.stream_id()).collect();
    assert_eq!(ids, ["100000000-0", "100000000-1", "101000000-0"]);
    let cover = &log[2];
    assert_eq!(
        (
            cover.block,
            cover.at_ms,
            cover.x,
            cover.y,
            cover.color,
            cover.by.as_str(),
            cover.free
        ),
        (101, t + 1_000, 1, 1, 5, "alice.near", false)
    );
    assert!(log[1].free);
    // No MAXLEN anywhere: the stream is as long as what was applied.
    let len: usize = redis::cmd("XLEN")
        .arg(keys::DRAW_HISTORY)
        .query_async(&mut con)
        .await
        .unwrap();
    assert_eq!(len, 3);

    let report = history::tip_check(&mut con, 20).await.unwrap();
    assert!(report.matches(), "{:?}", report.differences);
    assert_eq!(report.entries, 3);
    assert_eq!(
        (report.first_block, report.last_block),
        (Some(100), Some(101))
    );

    // A tile the log never saw makes the check fail and say where.
    let _: () = redis::cmd("XDEL")
        .arg(keys::DRAW_HISTORY)
        .arg("100000000-1")
        .query_async(&mut con)
        .await
        .unwrap();
    let broken = history::tip_check(&mut con, 20).await.unwrap();
    assert_eq!(broken.differences.len(), 1, "{:?}", broken.differences);
    assert!(broken.differences[0].starts_with("(2, 2)"));
}

async fn cover_members(con: &mut redis::aio::ConnectionManager, victim: &str) -> Vec<String> {
    con.zrange(history::cover_key(victim), 0, -1).await.unwrap()
}

#[tokio::test]
async fn covers_are_recorded_per_victim_trimmed_to_thirty_days_and_replay_identically() {
    let Some(mut con) = connect().await else {
        return;
    };
    let now = now_ms();
    let events = [
        draw(
            100,
            0,
            now - 2 * DAY_MS,
            "bob.near",
            &[(1, 1, 2, false), (2, 2, 2, false), (3, 3, 2, false)],
        ),
        draw(100, 1, now - 2 * DAY_MS, "carol.near", &[(9, 9, 2, false)]),
        // alice covers two of bob's and one of carol's; repainting her own tile is not a cover.
        draw(
            101,
            0,
            now - DAY_MS,
            "alice.near",
            &[(1, 1, 5, false), (2, 2, 5, false), (9, 9, 5, false)],
        ),
        draw(102, 0, now - DAY_MS + 1, "alice.near", &[(1, 1, 6, false)]),
    ];

    // An old member a trim must remove: covered 31 days ago.
    let stale = history::Cover {
        victim: "bob.near".into(),
        by: "old.near".into(),
        x: 7,
        y: 7,
        at_ms: now - 31 * DAY_MS,
        position: 1,
        index: 0,
    };
    let _: () = con
        .zadd(stale.key(), stale.member(), stale.at_ms as f64)
        .await
        .unwrap();

    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    for e in &events {
        deliver(&mut con, &state, e).await;
    }
    let bob = cover_members(&mut con, "bob.near").await;
    assert_eq!(bob.len(), 2, "the stale member is trimmed: {bob:?}");
    let records: Vec<_> = bob
        .iter()
        .filter_map(|m| history::parse_cover_member(m))
        .collect();
    assert!(records.iter().all(|r| r.by == "alice.near"));
    assert_eq!(
        records.iter().map(|r| (r.x, r.y)).collect::<Vec<_>>(),
        [(1, 1), (2, 2)]
    );
    assert_eq!(cover_members(&mut con, "carol.near").await.len(), 1);
    assert!(cover_members(&mut con, "alice.near").await.is_empty());
    let ttl: i64 = con.pttl(history::cover_key("bob.near")).await.unwrap();
    assert!(
        ttl > (COVER_RETENTION_MS - 60_000) as i64,
        "expires 30 days after its last write, ttl {ttl}"
    );

    // A cover older than the window is not written at all (a cold rebuild replays months).
    let old_state = Arc::new(RwLock::new(BoardState::empty(64)));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    deliver(
        &mut con,
        &old_state,
        &draw(1, 0, now - 40 * DAY_MS, "bob.near", &[(1, 1, 2, false)]),
    )
    .await;
    deliver(
        &mut con,
        &old_state,
        &draw(2, 0, now - 39 * DAY_MS, "alice.near", &[(1, 1, 3, false)]),
    )
    .await;
    assert!(cover_members(&mut con, "bob.near").await.is_empty());

    // Spec §1.2 "done when": a replay over the same range produces the same cover events.
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    let first_run = Arc::new(RwLock::new(BoardState::empty(64)));
    for e in &events {
        deliver(&mut con, &first_run, e).await;
    }
    let once = cover_members(&mut con, "bob.near").await;
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    let second_run = Arc::new(RwLock::new(BoardState::empty(64)));
    for e in &events {
        deliver(&mut con, &second_run, e).await;
    }
    assert_eq!(cover_members(&mut con, "bob.near").await, once);
}

fn app(con: redis::aio::ConnectionManager) -> axum::Router {
    let (broadcast_tx, _) = broadcast::channel(16);
    server::api::router(server::api::AppState {
        board: Arc::new(RwLock::new(BoardState::empty(64))),
        valkey: con,
        broadcast_tx,
        consumer: server::consumer::Health::default(),
        viewers: Arc::new(AtomicUsize::new(0)),
        last_hint_ms: Arc::new(AtomicU64::new(0)),
    })
}

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, Option<String>, String) {
    let response = app
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap().to_string());
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, cache, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn account_covers_answers_count_by_and_first_and_rejects_bad_params() {
    let Some(mut con) = connect().await else {
        return;
    };
    let now = now_ms();
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    // The spec's "done when": a second account covers three tiles of a first.
    for e in [
        draw(
            100,
            0,
            now - 3 * DAY_MS,
            "first.near",
            &[
                (1, 1, 2, false),
                (2, 2, 2, false),
                (3, 3, 2, false),
                (4, 4, 2, false),
            ],
        ),
        draw(101, 0, now - 2 * DAY_MS, "third.near", &[(4, 4, 7, false)]),
        draw(
            102,
            0,
            now - DAY_MS,
            "second.near",
            &[(3, 3, 5, false), (1, 1, 5, false), (2, 2, 5, false)],
        ),
    ] {
        deliver(&mut con, &state, &e).await;
    }
    let app = app(con);

    // Upper case and spaces normalise to the stored id.
    let since = now - 10 * DAY_MS;
    let (status, cache, body) = get(
        &app,
        &format!("/api/account-covers?account=%20First.NEAR&since_ms={since}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(cache.as_deref(), Some("no-cache, must-revalidate"));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "count": 4,
            "by": [{"account": "second.near", "tiles": 3}, {"account": "third.near", "tiles": 1}],
            "first": {"x": 4, "y": 4},
        })
    );

    // Only since the third's cover: the second's three, first in applied order.
    let (_, _, body) = get(
        &app,
        &format!(
            "/api/account-covers?account=first.near&since_ms={}",
            now - DAY_MS - 1
        ),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "count": 3,
            "by": [{"account": "second.near", "tiles": 3}],
            "first": {"x": 3, "y": 3},
        })
    );

    // Nothing since: count 0 and first null. An account never covered reads the same.
    for uri in [
        format!("/api/account-covers?account=first.near&since_ms={now}"),
        format!("/api/account-covers?account=nobody.near&since_ms={since}"),
    ] {
        let (status, _, body) = get(&app, &uri).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"count": 0, "by": [], "first": null})
        );
    }

    for uri in [
        "/api/account-covers?since_ms=1".to_string(),
        "/api/account-covers?account=first.near".to_string(),
        "/api/account-covers?account=first.near&since_ms=yesterday".to_string(),
        "/api/account-covers?account=first.near&since_ms=-5".to_string(),
        "/api/account-covers?account=not%20an%20account&since_ms=1".to_string(),
        "/api/account-covers?account=covers:first.near&since_ms=1".to_string(),
    ] {
        let (status, _, _) = get(&app, &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
    }
}
