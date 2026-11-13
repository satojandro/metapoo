//! TIMELAPSE (spec §4.3) against a real Valkey/Redis: the consumer logging `board_expanded` in
//! order with the draws, and `GET /api/history/head` / `GET /api/history` through the real
//! router. Skipped unless `TEST_VALKEY_URL` is set (see `tests/valkey.rs`). The database is
//! flushed.

use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::history::{self, LogRow};
use common::history_wire::{decode_page, Record};
use common::{keys, BoardEvent, BoardState, DrawEntry, QueuedEvent};
use redis::AsyncCommands;
use tokio::sync::{broadcast, RwLock};
use tower::ServiceExt;

async fn connect() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("TEST_VALKEY_URL").ok()?;
    let mut con = server::valkey::connect(&url)
        .await
        .unwrap_or_else(|e| panic!("TEST_VALKEY_URL={url} is set but unreachable: {e}"));
    let _: () = redis::cmd("FLUSHDB").query_async(&mut con).await.unwrap();
    Some(con)
}

fn event(block_height: u64, event: BoardEvent) -> QueuedEvent {
    QueuedEvent {
        block_height,
        block_timestamp_ms: block_height * 1_000,
        seq: 0,
        receipt_id: format!("r{block_height}"),
        predecessor_id: "alice.near".into(),
        event,
    }
}

fn draw(block_height: u64, cells: &[(u32, u32, u32)]) -> QueuedEvent {
    event(
        block_height,
        BoardEvent::Draw {
            method: "draw_many".into(),
            entries: cells
                .iter()
                .map(|&(x, y, color)| DrawEntry {
                    x,
                    y,
                    color,
                    artist: Some("alice.near".into()),
                    written_at_ns: Some(block_height * 1_000_000_000),
                    credits: 1,
                    free: false,
                })
                .collect(),
        },
    )
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

fn app(con: redis::aio::ConnectionManager, board: Arc<RwLock<BoardState>>) -> axum::Router {
    let (broadcast_tx, _) = broadcast::channel(16);
    server::api::router(server::api::AppState {
        board,
        valkey: con,
        broadcast_tx,
        consumer: server::consumer::Health::default(),
        viewers: Arc::new(AtomicUsize::new(0)),
        last_hint_ms: Arc::new(AtomicU64::new(0)),
    })
}

async fn get(app: &axum::Router, uri: &str) -> (StatusCode, String, Vec<u8>) {
    let response = app
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cache = response
        .headers()
        .get(header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = axum::body::to_bytes(response.into_body(), 1 << 22)
        .await
        .unwrap();
    (status, cache, body.to_vec())
}

fn epoch_of(head: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(head).unwrap()["epoch"]
        .as_u64()
        .unwrap()
}

async fn epoch(app: &axum::Router) -> u64 {
    epoch_of(&get(app, "/api/history/head").await.2)
}

/// Six draws around one expansion: 64 → 96 at block 103.
async fn seed(con: &mut redis::aio::ConnectionManager) -> Arc<RwLock<BoardState>> {
    let state = Arc::new(RwLock::new(BoardState::empty(64)));
    for e in [
        draw(100, &[(1, 1, 2), (2, 2, 3)]),
        draw(101, &[(1, 1, 5)]),
        // Off the 64-wide board: rejected, so it is not in the log.
        draw(102, &[(90, 90, 1)]),
        event(103, BoardEvent::BoardExpanded { from: 64, to: 96 }),
        draw(104, &[(90, 90, 1), (95, 0, 4)]),
        draw(105, &[(0, 0, 7)]),
    ] {
        deliver(con, &state, &e).await;
    }
    state
}

#[tokio::test]
async fn the_consumer_logs_board_expanded_in_order_and_the_check_covers_the_side() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = seed(&mut con).await;
    assert_eq!(state.read().await.side, 96);

    let (rows, _) = history::read_rows(&mut con, keys::DRAW_HISTORY)
        .await
        .unwrap();
    let ids: Vec<String> = rows
        .iter()
        .map(|r| format!("{}-{}", r.key().0, r.key().1))
        .collect();
    assert_eq!(
        ids,
        [
            "100000000-0",
            "100000000-1",
            "101000000-0",
            "103000000-0",
            "104000000-0",
            "104000000-1",
            "105000000-0"
        ]
    );
    let LogRow::Expand(grow) = &rows[3] else {
        panic!("row 3 is the expansion, got {:?}", rows[3])
    };
    assert_eq!(
        (grow.block, grow.at_ms, grow.from, grow.to),
        (103, 103_000, 64, 96)
    );
    // The draws-only reader HISTORY shipped with still reads the same stream.
    let (draws, _) = history::read_log(&mut con, keys::DRAW_HISTORY)
        .await
        .unwrap();
    assert_eq!(draws.len(), 6);

    let report = history::tip_check(&mut con, 20).await.unwrap();
    assert!(report.matches(), "{:?}", report.differences);
    assert_eq!((report.entries, report.expansions), (6, 1));

    // Re-delivered: the position guard drops it, so the expansion is logged once.
    deliver(
        &mut con,
        &state,
        &event(103, BoardEvent::BoardExpanded { from: 64, to: 96 }),
    )
    .await;
    let len: usize = redis::cmd("XLEN")
        .arg(keys::DRAW_HISTORY)
        .query_async(&mut con)
        .await
        .unwrap();
    assert_eq!(len, 7);

    // The log without its expansion no longer explains the board: the check says so.
    let _: () = redis::cmd("XDEL")
        .arg(keys::DRAW_HISTORY)
        .arg("103000000-0")
        .query_async(&mut con)
        .await
        .unwrap();
    let _: () = redis::cmd("HSET")
        .arg(keys::DRAW_HISTORY_GENESIS)
        .arg("start_block")
        .arg(100)
        .arg("initial_side")
        .arg(64)
        .query_async(&mut con)
        .await
        .unwrap();
    let broken = history::tip_check(&mut con, 20).await.unwrap();
    assert!(!broken.matches());
    assert!(
        broken.differences.iter().any(|d| d.contains("(90, 90)")),
        "{:?}",
        broken.differences
    );
}

#[tokio::test]
async fn history_head_says_where_the_log_starts_and_whether_that_is_the_beginning() {
    let Some(mut con) = connect().await else {
        return;
    };
    let empty_board = Arc::new(RwLock::new(BoardState::empty(64)));
    let (status, cache, body) = get(&app(con.clone(), empty_board), "/api/history/head").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache, "no-cache, must-revalidate");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "epoch": epoch_of(&body), "complete": false, "start_block": null,
            "initial_side": null, "entries": 0, "first": null, "last": null, "side": 64,
            "page_limit": 20000,
        })
    );
    // The epoch names this copy of the log: set on first read, and stable after.
    assert!(epoch_of(&body) > 1_700_000_000_000);
    let (_, _, again) = get(
        &app(con.clone(), Arc::new(RwLock::new(BoardState::empty(64)))),
        "/api/history/head",
    )
    .await;
    assert_eq!(epoch_of(&again), epoch_of(&body));

    let state = seed(&mut con).await;
    let app = app(con.clone(), state);
    let (_, _, body) = get(&app, "/api/history/head").await;
    let head: serde_json::Value = serde_json::from_slice(&body).unwrap();
    // Not certified: the log starts where this consumer started, and says so.
    assert_eq!(head["complete"], false);
    assert_eq!(head["entries"], 7);
    assert_eq!(
        head["first"],
        serde_json::json!({"block": 100, "at_ms": 100_000})
    );
    assert_eq!(
        head["last"],
        serde_json::json!({"block": 105, "at_ms": 105_000})
    );
    assert_eq!(head["side"], 96);

    // What the backfill writes when it has certified the start.
    let _: () = redis::cmd("HSET")
        .arg(keys::DRAW_HISTORY_GENESIS)
        .arg("start_block")
        .arg(90)
        .arg("initial_side")
        .arg(64)
        .query_async(&mut con)
        .await
        .unwrap();
    let _: () = con
        .set(keys::DRAW_HISTORY_EPOCH, 4_000_000_000_000u64)
        .await
        .unwrap();
    let (_, _, body) = get(&app, "/api/history/head").await;
    let head: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (
            &head["complete"],
            &head["start_block"],
            &head["initial_side"],
            &head["epoch"]
        ),
        (
            &serde_json::json!(true),
            &serde_json::json!(90),
            &serde_json::json!(64),
            &serde_json::json!(4_000_000_000_000u64)
        )
    );
}

#[tokio::test]
async fn history_pages_chain_to_the_whole_log_and_only_full_pages_are_immutable() {
    let Some(mut con) = connect().await else {
        return;
    };
    let state = seed(&mut con).await;
    let app = app(con.clone(), state.clone());
    let e = epoch(&app).await;

    // The whole log in one request.
    let (status, cache, body) = get(&app, "/api/history").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache, "no-cache, must-revalidate", "a partial page is live");
    let whole = decode_page(&body).unwrap();
    assert!(!whole.more);
    assert_eq!(whole.rows, 7);
    assert_eq!(whole.next, Some((105_000_000, 0)));
    assert_eq!(
        whole.records,
        vec![
            Record::Paints {
                block: 100,
                at_ms: 100_000,
                tiles: vec![(1, 1, 2), (2, 2, 3)]
            },
            Record::Paints {
                block: 101,
                at_ms: 101_000,
                tiles: vec![(1, 1, 5)]
            },
            Record::Expand {
                block: 103,
                at_ms: 103_000,
                from: 64,
                to: 96
            },
            Record::Paints {
                block: 104,
                at_ms: 104_000,
                tiles: vec![(90, 90, 1), (95, 0, 4)]
            },
            Record::Paints {
                block: 105,
                at_ms: 105_000,
                tiles: vec![(0, 0, 7)]
            },
        ]
    );
    // 7 rows in 55 bytes, header included.
    assert!(body.len() < 60, "{} bytes", body.len());

    // The same log three rows at a time, following each page's cursor.
    let mut tiles = Vec::new();
    let mut grown = Vec::new();
    let mut uri = format!("/api/history?epoch={e}&limit=3");
    let mut requests = 0;
    loop {
        let (status, cache, body) = get(&app, &uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        requests += 1;
        let page = decode_page(&body).unwrap();
        assert_eq!(
            cache,
            if page.more {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache, must-revalidate"
            },
            "{uri}"
        );
        for r in page.records {
            match r {
                Record::Paints { tiles: t, .. } => tiles.extend(t),
                Record::Expand { to, .. } => grown.push((tiles.len(), to)),
            }
        }
        if !page.more {
            break;
        }
        let (position, index) = page.next.unwrap();
        uri = format!("/api/history?epoch={e}&limit=3&after={position}-{index}");
    }
    assert_eq!(requests, 3);
    assert_eq!(
        tiles,
        [
            (1, 1, 2),
            (2, 2, 3),
            (1, 1, 5),
            (90, 90, 1),
            (95, 0, 4),
            (0, 0, 7)
        ]
    );
    assert_eq!(grown, [(3, 96)], "the wall grows after the third tile");

    // A full page fetched again is byte-for-byte the same, also after more paint arrives.
    let (_, _, first) = get(&app, &format!("/api/history?epoch={e}&limit=3")).await;
    deliver(&mut con, &state, &draw(106, &[(5, 5, 5)])).await;
    let (_, _, again) = get(&app, &format!("/api/history?epoch={e}&limit=3")).await;
    assert_eq!(first, again);
    // And the live tail picks the new paint up from the old cursor.
    let (_, _, tail) = get(&app, &format!("/api/history?epoch={e}&after=105000000-0")).await;
    assert_eq!(decode_page(&tail).unwrap().rows, 1);
    // Nothing after the end: an empty page, not an error.
    let (status, _, none) = get(&app, &format!("/api/history?epoch={e}&after=106000000-0")).await;
    assert_eq!(status, StatusCode::OK);
    let none = decode_page(&none).unwrap();
    assert_eq!((none.rows, none.more, none.next), (0, false, None));

    // from_block starts at the first entry at or after the block.
    let (_, _, late) = get(&app, "/api/history?from_block=104").await;
    assert_eq!(decode_page(&late).unwrap().rows, 4);

    // Without an epoch nothing is immutable, even a full page.
    let (_, cache, _) = get(&app, "/api/history?limit=3").await;
    assert_eq!(cache, "no-cache, must-revalidate");

    // The backfill rewrote the log: the old epoch's URLs answer 409 and are not cached.
    let _: () = con.set(keys::DRAW_HISTORY_EPOCH, e + 1).await.unwrap();
    let (status, cache, _) = get(&app, &format!("/api/history?epoch={e}&limit=3")).await;
    assert_eq!((status, cache.as_str()), (StatusCode::CONFLICT, "no-store"));
    let (status, _, _) = get(&app, &format!("/api/history?epoch={}&limit=3", e + 1)).await;
    assert_eq!(status, StatusCode::OK);

    for bad in [
        "/api/history?epoch=x",
        "/api/history?after=12",
        "/api/history?after=1-1&from_block=1",
        "/api/history?limit=0",
        "/api/history?limit=20001",
    ] {
        assert_eq!(get(&app, bad).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
}

/// The default page size against a log bigger than one page: two requests, and the full page
/// is served from memory the second time (no `XRANGE`), still honouring the epoch.
#[tokio::test]
async fn a_log_longer_than_one_page_takes_one_request_per_twenty_thousand_tiles() {
    let Some(mut con) = connect().await else {
        return;
    };
    // 25,000 tiles written straight to the stream, 50 to a block.
    for chunk in (0..25_000u32).collect::<Vec<_>>().chunks(1_000) {
        let mut pipe = redis::pipe();
        for &i in chunk {
            history::HistoryEntry {
                position: u64::from(1_000 + i / 50) * 1_000_000,
                index: i % 50,
                block: u64::from(1_000 + i / 50),
                at_ms: u64::from(1_000 + i / 50) * 600,
                x: i % 64,
                y: (i / 64) % 64,
                color: i % 16,
                by: "a.near".into(),
                free: false,
            }
            .xadd(&mut pipe, keys::DRAW_HISTORY);
        }
        pipe.query_async::<()>(&mut con).await.unwrap();
    }
    let app = app(con.clone(), Arc::new(RwLock::new(BoardState::empty(64))));
    let e = epoch(&app).await;
    let whole = format!("/api/history?epoch={e}");
    let (_, cache, first) = get(&app, &whole).await;
    assert_eq!(cache, "public, max-age=31536000, immutable");
    let page = decode_page(&first).unwrap();
    assert!(page.more);
    assert_eq!(page.rows, 20_000);
    // 20,000 tiles in 400 blocks: 3 bytes a tile plus 5 a block.
    assert!(
        first.len() < 20_000 * 3 + 400 * 6 + 32,
        "{} bytes",
        first.len()
    );
    let (position, index) = page.next.unwrap();
    let (_, cache, rest) = get(
        &app,
        &format!("/api/history?epoch={e}&after={position}-{index}"),
    )
    .await;
    assert_eq!(cache, "no-cache, must-revalidate");
    let rest = decode_page(&rest).unwrap();
    assert_eq!((rest.rows, rest.more), (5_000, false));

    // Served from memory now: delete the stream and the full page still answers, identically.
    let _: () = con.del(keys::DRAW_HISTORY).await.unwrap();
    let (status, _, cached) = get(&app, &whole).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cached, first);
    // But never across an epoch.
    let _: () = con.set(keys::DRAW_HISTORY_EPOCH, e + 9).await.unwrap();
    assert_eq!(get(&app, &whole).await.0, StatusCode::CONFLICT);
    let (_, _, fresh) = get(&app, &format!("/api/history?epoch={}", e + 9)).await;
    assert_eq!(decode_page(&fresh).unwrap().rows, 0);
}
