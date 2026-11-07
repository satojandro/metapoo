//! HTTP routes. Same paths and shapes as Berry Fast's `API.md` where the meaning is the same;
//! the only region is `(0,0)`. Additions: `x-board-side` / `x-last-block` headers, the
//! `written-at` blob, `earning_count` in account stats, and `last_applied_block` in health.

use std::sync::Arc;

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{header, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use common::{keys, BoardState};
use redis::AsyncCommands;
use serde::Deserialize;
use tokio::sync::{broadcast, RwLock};

use crate::ws;

#[derive(Clone)]
pub struct AppState {
    pub board: Arc<RwLock<BoardState>>,
    pub valkey: redis::aio::MultiplexedConnection,
    pub broadcast_tx: broadcast::Sender<String>,
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
        .route("/api/health", get(health))
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

async fn health(State(state): State<AppState>) -> Response {
    let mut con = state.valkey.clone();
    let processed: Option<u64> = con.get(keys::LAST_PROCESSED_BLOCK).await.unwrap_or(None);
    let applied: Option<u64> = con.get(keys::LAST_APPLIED_BLOCK).await.unwrap_or(None);
    let queue: u64 = con.llen(keys::DRAW_QUEUE).await.unwrap_or(0);
    let painted: Option<i64> = con.get(keys::PAINTED_TILES).await.unwrap_or(None);
    let side = state.board.read().await.side;
    axum::Json(serde_json::json!({
        "status": "ok",
        "last_processed_block": processed,
        "last_applied_block": applied,
        "queue_length": queue,
        "side": side,
        "painted_tiles": painted.unwrap_or(0),
    }))
    .into_response()
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws::handle_socket(socket, state))
}
