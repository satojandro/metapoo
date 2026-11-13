//! HTTP routes. Same paths and shapes as Berry Fast's `API.md` where the meaning is the same;
//! the only region is `(0,0)`. Additions: `x-board-side` / `x-last-block` headers, the
//! `written-at` blob, `earning_count` in account stats, and `last_applied_block` in health.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{header, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use common::account::normalize_account;
use common::history::{self, COVER_RETENTION_MS};
use common::{keys, BoardState};
use redis::AsyncCommands;
use serde::Deserialize;
use tokio::sync::{broadcast, RwLock};

use crate::{consumer, ws};

#[derive(Clone)]
pub struct AppState {
    pub board: Arc<RwLock<BoardState>>,
    pub valkey: redis::aio::ConnectionManager,
    pub broadcast_tx: broadcast::Sender<String>,
    /// Consumer liveness, so `/api/health` can tell a working mirror from a frozen one.
    pub consumer: consumer::Health,
    /// Open WebSocket clients. While above zero the server keeps `VIEWERS_UNTIL_MS` fresh and
    /// the indexer polls; at zero it stops (`common/src/demand.rs`).
    pub viewers: Arc<AtomicUsize>,
    /// When the last hint was accepted (ms), for the rate limit.
    pub last_hint_ms: Arc<AtomicU64>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/region/{rx}/{ry}", get(get_region))
        .route("/api/region/{rx}/{ry}/written-at", get(get_written_at))
        .route("/api/region/{rx}/{ry}/meta", get(get_region_meta))
        .route(
            "/api/region/{rx}/{ry}/timestamps",
            get(get_region_timestamps),
        )
        .route("/api/regions", get(get_regions_batch))
        .route("/api/stats/accounts", get(get_account_stats))
        .route("/api/account/{owner_id}", get(get_account_by_id))
        .route("/api/account-covers", get(get_account_covers))
        .route("/api/health", get(health))
        .route("/api/hint", post(hint))
        .route("/ws", get(ws_upgrade))
        .with_state(state)
}

fn is_wall(rx: i32, ry: i32) -> bool {
    rx == 0 && ry == 0
}

async fn meta(state: &AppState) -> (u64, u64) {
    let mut con = state.valkey.clone();
    let updated: Option<u64> = con
        .hget(keys::REGION_META_KEY, "last_updated")
        .await
        .unwrap_or(None);
    let block: Option<u64> = con
        .hget(keys::REGION_META_KEY, "last_block")
        .await
        .unwrap_or(None);
    (updated.unwrap_or(0), block.unwrap_or(0))
}

async fn binary(state: &AppState, body: Vec<u8>, side: u32) -> Response {
    let (updated, block) = meta(state).await;
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CACHE_CONTROL,
                "no-cache, must-revalidate".to_string(),
            ),
            (
                HeaderName::from_static("x-last-updated"),
                updated.to_string(),
            ),
            (HeaderName::from_static("x-last-block"), block.to_string()),
            (HeaderName::from_static("x-board-side"), side.to_string()),
            (
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "x-last-updated, x-last-block, x-board-side".to_string(),
            ),
        ],
        body,
    )
        .into_response()
}

async fn get_region(State(state): State<AppState>, Path((rx, ry)): Path<(i32, i32)>) -> Response {
    if !is_wall(rx, ry) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (blob, side) = {
        let board = state.board.read().await;
        (board.blob.clone(), board.side)
    };
    binary(&state, blob, side).await
}

async fn get_written_at(
    State(state): State<AppState>,
    Path((rx, ry)): Path<(i32, i32)>,
) -> Response {
    if !is_wall(rx, ry) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (written, side) = {
        let board = state.board.read().await;
        (board.written_at.clone(), board.side)
    };
    binary(&state, written, side).await
}

async fn get_region_meta(
    State(state): State<AppState>,
    Path((rx, ry)): Path<(i32, i32)>,
) -> Response {
    let updated = if is_wall(rx, ry) {
        meta(&state).await.0
    } else {
        0
    };
    axum::Json(serde_json::json!({ "rx": rx, "ry": ry, "last_updated": updated })).into_response()
}

#[derive(Deserialize)]
struct BatchQuery {
    coords: String,
}

async fn get_regions_batch(
    State(state): State<AppState>,
    Query(query): Query<BatchQuery>,
) -> Response {
    let coords: Vec<i32> = query
        .coords
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let updated = meta(&state).await.0;
    let results: Vec<_> = coords
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[rx, ry]| {
            let last_updated = if is_wall(rx, ry) { updated } else { 0 };
            serde_json::json!({ "rx": rx, "ry": ry, "last_updated": last_updated })
        })
        .collect();
    axum::Json(results).into_response()
}

async fn get_region_timestamps(
    State(state): State<AppState>,
    Path((rx, ry)): Path<(i32, i32)>,
) -> Response {
    if !is_wall(rx, ry) {
        return axum::Json(Vec::<[u64; 3]>::new()).into_response();
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entries: Vec<(String, f64)> = state
        .valkey
        .clone()
        .zrangebyscore_withscores(keys::PIXEL_TS_KEY, now_ms.saturating_sub(3_600_000), "+inf")
        .await
        .unwrap_or_default();
    let results: Vec<[u64; 3]> = entries
        .into_iter()
        .filter_map(|(member, score)| {
            let (x, y) = member.split_once(',')?;
            Some([x.parse().ok()?, y.parse().ok()?, score as u64])
        })
        .collect();
    axum::Json(results).into_response()
}

async fn get_account_stats(State(state): State<AppState>) -> Response {
    let mut con = state.valkey.clone();
    let tiles: std::collections::HashMap<u32, i64> = con
        .hgetall(keys::ACCOUNT_PIXEL_COUNT)
        .await
        .unwrap_or_default();
    let earning: std::collections::HashMap<u32, i64> = con
        .hgetall(keys::ACCOUNT_EARNING_COUNT)
        .await
        .unwrap_or_default();
    let names: std::collections::HashMap<u32, String> =
        con.hgetall(keys::ID_TO_ACCOUNT).await.unwrap_or_default();
    let mut rows: Vec<_> = tiles
        .iter()
        .filter(|(_, n)| **n > 0)
        .filter_map(|(id, n)| {
            Some(serde_json::json!({
                "account_id": names.get(id)?,
                "pixel_count": n,
                "earning_count": earning.get(id).copied().unwrap_or(0),
            }))
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r["pixel_count"].as_i64().unwrap_or(0)));
    axum::Json(rows).into_response()
}

async fn get_account_by_id(State(state): State<AppState>, Path(owner_id): Path<u32>) -> Response {
    let account: Option<String> = state
        .valkey
        .clone()
        .hget(keys::ID_TO_ACCOUNT, owner_id)
        .await
        .unwrap_or(None);
    match account {
        Some(id) => (
            [(header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
            id,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
pub struct CoversQuery {
    account: Option<String>,
    since_ms: Option<String>,
}

/// How long `/api/account-covers` waits for Valkey before answering 503.
const COVERS_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The window start actually used: `since_ms`, but never earlier than the 30 days the cover
/// sets keep. Older covers may still be in a set until its next trim; clamping here means the
/// answer does not depend on when that trim last ran.
pub fn covers_since(since_ms: u64, now_ms: u64) -> u64 {
    since_ms.max(now_ms.saturating_sub(COVER_RETENTION_MS))
}

fn bad_request(why: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, why).into_response()
}

/// `GET /api/account-covers?account=<id>&since_ms=<ms>` (AWAY-A, spec §1.2): how many of
/// `account`'s tiles other accounts covered since `since_ms`, by whom, and where the first was.
/// Always `{count, by: [{account, tiles}], first: {x, y} | null}`; see `history::summarize`.
async fn get_account_covers(
    State(state): State<AppState>,
    Query(query): Query<CoversQuery>,
) -> Response {
    let Some(account) = query.account.as_deref().and_then(normalize_account) else {
        return bad_request("account must be a NEAR account id");
    };
    let Some(since_ms) = query
        .since_ms
        .as_deref()
        .and_then(|s| s.trim().parse::<u64>().ok())
    else {
        return bad_request("since_ms must be a whole number of milliseconds since the epoch");
    };
    let since = covers_since(since_ms, consumer::now_ms());
    let mut con = state.valkey.clone();
    match tokio::time::timeout(
        COVERS_READ_TIMEOUT,
        history::read_covers(&mut con, &account, since),
    )
    .await
    {
        Ok(Ok(records)) => (
            [(header::CACHE_CONTROL, "no-cache, must-revalidate")],
            axum::Json(history::summarize(records)),
        )
            .into_response(),
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// The `/api/health` body. Pure, so the status rules are testable without a server.
///
/// `status` is derived, never asserted: `ok` needs a consumer that is still ticking and not
/// retrying. It used to be the literal string "ok", so a mirror whose consumer had exited
/// reported perfect health while every later draw sat in the queue.
pub fn health_body(
    processed: Option<u64>,
    applied: Option<u64>,
    queue_length: u64,
    painted_tiles: i64,
    side: u32,
    now_ms: u64,
    consumer: consumer::HealthSnapshot,
) -> serde_json::Value {
    serde_json::json!({
        "status": consumer::status(now_ms, consumer),
        "last_processed_block": processed,
        "last_applied_block": applied,
        "queue_length": queue_length,
        "side": side,
        "painted_tiles": painted_tiles,
        "consumer_last_tick_ms": consumer.last_tick_ms,
        "consumer_failures": consumer.failures,
    })
}

/// How long `/api/health` waits for Valkey. A `ConnectionManager` *blocks* while it reconnects,
/// so without a bound this endpoint would hang during an outage instead of reporting one — and
/// a hung endpoint looks like a dead server to whatever is watching it.
const HEALTH_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// One health read, or `None` if Valkey does not answer in time.
async fn health_get<T: redis::FromRedisValue>(
    con: redis::aio::ConnectionManager,
    key: &str,
) -> Option<T> {
    let mut con = con;
    tokio::time::timeout(HEALTH_READ_TIMEOUT, con.get(key))
        .await
        .ok()?
        .ok()
}

async fn health_len(con: redis::aio::ConnectionManager, key: &str) -> Option<u64> {
    let mut con = con;
    tokio::time::timeout(HEALTH_READ_TIMEOUT, con.llen(key))
        .await
        .ok()?
        .ok()
}

async fn health(State(state): State<AppState>) -> Response {
    let con = state.valkey.clone();
    let processed: Option<u64> = health_get(con.clone(), keys::LAST_PROCESSED_BLOCK).await;
    let applied: Option<u64> = health_get(con.clone(), keys::LAST_APPLIED_BLOCK).await;
    let queue: u64 = health_len(con.clone(), keys::DRAW_QUEUE).await.unwrap_or(0);
    let processing: u64 = health_len(con.clone(), keys::PROCESSING_QUEUE)
        .await
        .unwrap_or(1);
    let painted: Option<i64> = health_get(con, keys::PAINTED_TILES).await;
    let side = state.board.read().await.side;
    axum::Json(health_body(
        processed,
        checked_through(processed, applied, queue, processing),
        queue,
        painted.unwrap_or(0),
        side,
        consumer::now_ms(),
        state.consumer.snapshot(),
    ))
    .into_response()
}

/// The block every event up to which has been applied: what `last_applied_block` reports.
///
/// The last *applied event* is the wrong number on a quiet board. The wall trusts the server
/// only while this is within 60 blocks of the chain, so ~36 s after the last paint every
/// browser decided the server was behind and went back to polling the chain (seen on the
/// first deploy). With nothing queued and nothing in processing, everything the indexer has
/// checked is applied, so its watermark is the answer.
pub fn checked_through(
    processed: Option<u64>,
    applied: Option<u64>,
    queue: u64,
    processing: u64,
) -> Option<u64> {
    if queue == 0 && processing == 0 {
        match (processed, applied) {
            (Some(p), Some(a)) => Some(p.max(a)),
            (p, a) => p.or(a),
        }
    } else {
        applied
    }
}

/// `POST /api/hint`: a tab just painted; poll the index now instead of at the next interval.
///
/// It carries no data and changes nothing but timing, so anyone may send it. Rate-limited to
/// one per `HINT_MIN_GAP_MS`, so it cannot become a request pump.
async fn hint(State(state): State<AppState>) -> StatusCode {
    let now = consumer::now_ms();
    let last = state.last_hint_ms.load(Ordering::Relaxed);
    if !common::demand::accept_hint(now, last)
        || state
            .last_hint_ms
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return StatusCode::TOO_MANY_REQUESTS;
    }
    let mut con = state.valkey.clone();
    match tokio::time::timeout(
        HEALTH_READ_TIMEOUT,
        con.set::<_, _, ()>(keys::HINT_AT_MS, now),
    )
    .await
    {
        Ok(Ok(())) => StatusCode::ACCEPTED,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws::handle_socket(socket, state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(last_tick_ms: u64, failures: u64) -> consumer::HealthSnapshot {
        consumer::HealthSnapshot {
            last_tick_ms,
            failures,
        }
    }

    #[test]
    fn a_working_consumer_reports_ok_and_the_watermarks() {
        let now = 1_000_000;
        let body = health_body(Some(500), Some(499), 0, 7, 64, now, snapshot(now - 50, 0));
        assert_eq!(body["status"], "ok");
        assert_eq!(body["last_processed_block"], 500);
        assert_eq!(body["last_applied_block"], 499);
        assert_eq!(body["queue_length"], 0);
        assert_eq!(body["painted_tiles"], 7);
    }

    #[test]
    fn a_frozen_consumer_is_not_reported_as_ok() {
        let now = 1_000_000;
        let body = health_body(
            Some(500),
            Some(300),
            42,
            0,
            64,
            now,
            snapshot(now - consumer::STALL_AFTER_MS - 1, 0),
        );
        // The whole point: the backlog is visible AND the status says the mirror is not moving.
        assert_eq!(body["status"], "stalled");
        assert_eq!(body["queue_length"], 42);
        assert_eq!(body["last_applied_block"], 300);
    }

    #[test]
    fn a_quiet_board_reports_the_indexer_watermark_once_the_queue_is_empty() {
        // Last paint at 499, indexer checked through 9,000: nothing pending, so 9,000.
        assert_eq!(checked_through(Some(9_000), Some(499), 0, 0), Some(9_000));
        // Something queued or in flight: only what is applied.
        assert_eq!(checked_through(Some(9_000), Some(499), 1, 0), Some(499));
        assert_eq!(checked_through(Some(9_000), Some(499), 0, 1), Some(499));
        // A fresh mirror with no paint yet.
        assert_eq!(checked_through(Some(9_000), None, 0, 0), Some(9_000));
        assert_eq!(checked_through(None, None, 0, 0), None);
    }

    #[test]
    fn the_covers_window_is_never_older_than_thirty_days() {
        let now = 100 * COVER_RETENTION_MS;
        assert_eq!(covers_since(0, now), now - COVER_RETENTION_MS);
        assert_eq!(covers_since(now - 5, now), now - 5);
        // A clock near the epoch does not underflow.
        assert_eq!(covers_since(7, 1_000), 7);
    }

    #[test]
    fn a_consumer_that_is_retrying_reports_degraded() {
        let now = 1_000_000;
        let body = health_body(Some(500), Some(499), 1, 0, 64, now, snapshot(now - 50, 3));
        assert_eq!(body["status"], "degraded");
        assert_eq!(body["consumer_failures"], 3);
    }
}
