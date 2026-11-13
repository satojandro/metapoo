//! `GET /api/history/head` and `GET /api/history` (TIMELAPSE, return-and-growth spec §4.3):
//! the durable draw log, read-only, for a page that replays the wall.
//!
//! **The data path, and why.** Spec §4.3 warns against a page that makes hundreds of
//! requests. Two shapes were on the table: a compact file per day, or pages of the log.
//! Per-day files cost one request per day the board has existed whether or not anyone
//! painted, so a year-old wall is 365 requests on a first visit. Pages cost one request per
//! [`PAGE_LIMIT`] tiles painted, which is what the reader actually needs to download:
//!
//! | tiles painted | requests (head + pages) | bytes (≈3.3 a tile) |
//! |---|---|---|
//! | 2,000 (the testing board today, order of magnitude) | 2 | ~7 KB |
//! | 100,000 | 7 | ~330 KB |
//! | 1,000,000 | 52 | ~3.3 MB |
//!
//! and a page keeps what made the per-day file attractive: **a full page never changes**.
//! The log is append-only above its last id, ids are fixed by the chain, and a page that came
//! back full ends below that last id, so `(epoch, after, limit)` names the same bytes forever
//! and is served `Cache-Control: immutable`. Only the last, partial page is live
//! (`no-cache`). The one thing that rewrites history is the backfill, which replaces the epoch
//! (a wipe and rebuild of the mirror gets a new one too: it is a timestamp, not a counter); a
//! request for another epoch is answered 409 and the reader starts again from the head.
//!
//! **Valkey work per request is bounded**: the head is six O(1) commands; a page is one
//! `XRANGE … COUNT limit` (limit ≤ [`PAGE_LIMIT`]), and a full default-size page is packed
//! once per process and then served from memory ([`MAX_CACHED_PAGES`] of them, ~66 KB each).
//!
//! The body is the compact binary of `common/src/history_wire.rs`, about 3 bytes a tile
//! against ~150 for the stream entry. There is no compression middleware on this server; the
//! format does not lean on one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use common::history::{self, PageStart};
use common::{history_wire, SEQ_PER_BLOCK};
use serde::Deserialize;

use crate::api::AppState;

/// Stream rows in a page, and the most a request may ask for.
pub const PAGE_LIMIT: usize = 20_000;
/// Full pages kept packed in memory. 512 × 20,000 tiles is ten million paints.
pub const MAX_CACHED_PAGES: usize = 512;
/// How long a history read waits for Valkey before answering 503.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

const LIVE: &str = "no-cache, must-revalidate";
const FOREVER: &str = "public, max-age=31536000, immutable";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/history/head", get(get_head))
        .route("/api/history", get(get_page))
}

type PageCache = Mutex<HashMap<(u64, PageStart), Arc<Vec<u8>>>>;

/// Process-wide, not in `AppState`: the cache is an implementation detail of these two
/// routes, and keyed by epoch, so a second router in the same process (tests) is harmless.
fn cache() -> &'static PageCache {
    static CACHE: OnceLock<PageCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn unavailable() -> Response {
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

/// `{epoch, complete, start_block, initial_side, entries, first, last, side, page_limit}`.
///
/// `complete` is true only once `board-history backfill` has certified that the log starts at
/// the deploy block (`start_block`, with the board `initial_side` a side). Until then the log
/// starts at `first`, wherever the consumer began writing it, and a page showing it must say
/// so. `side` is the board's side now. `first` / `last` are `{block, at_ms}` or `null`.
async fn get_head(State(state): State<AppState>) -> Response {
    let mut con = state.valkey.clone();
    let Ok(Ok(head)) = tokio::time::timeout(
        READ_TIMEOUT,
        history::read_head(&mut con, crate::consumer::now_ms()),
    )
    .await
    else {
        return unavailable();
    };
    let side = state.board.read().await.side;
    let mut body = serde_json::to_value(&head).expect("a Head serialises");
    body["side"] = side.into();
    body["page_limit"] = PAGE_LIMIT.into();
    ([(header::CACHE_CONTROL, LIVE)], axum::Json(body)).into_response()
}

#[derive(Deserialize)]
pub struct PageQuery {
    epoch: Option<String>,
    after: Option<String>,
    from_block: Option<String>,
    limit: Option<String>,
}

/// What a page request asks for, or why it is refused. Pure, so the rules are unit-tested.
pub fn parse_page_query(
    epoch: Option<&str>,
    after: Option<&str>,
    from_block: Option<&str>,
    limit: Option<&str>,
) -> Result<(Option<u64>, PageStart, usize), &'static str> {
    let epoch = match epoch {
        None => None,
        Some(e) => Some(
            e.parse::<u64>()
                .map_err(|_| "epoch must be a whole number")?,
        ),
    };
    let start = match (after, from_block) {
        (Some(_), Some(_)) => return Err("give after or from_block, not both"),
        (Some(id), None) => {
            let (position, index) = history::parse_stream_id(id)
                .ok_or("after must be a cursor a page returned: <position>-<index>")?;
            PageStart::After(position, index)
        }
        (None, Some(block)) => {
            let block = block
                .parse::<u64>()
                .ok()
                .and_then(|b| b.checked_mul(SEQ_PER_BLOCK))
                .ok_or("from_block must be a block height")?;
            PageStart::FromPosition(block)
        }
        (None, None) => PageStart::Beginning,
    };
    let limit = match limit {
        None => PAGE_LIMIT,
        Some(l) => match l.parse::<usize>() {
            Ok(n) if (1..=PAGE_LIMIT).contains(&n) => n,
            _ => return Err("limit must be between 1 and 20000"),
        },
    };
    Ok((epoch, start, limit))
}

fn page_response(bytes: Vec<u8>, epoch: u64, immutable: bool) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CACHE_CONTROL,
                if immutable { FOREVER } else { LIVE }.to_string(),
            ),
            (
                axum::http::HeaderName::from_static("x-history-epoch"),
                epoch.to_string(),
            ),
            (
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "x-history-epoch".to_string(),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// `GET /api/history?epoch=<n>&after=<cursor>&limit=<n>` (or `from_block=<height>` in place of
/// `after`): one page of the log in the `MPH1` format, oldest first.
///
/// - `after` is the cursor the previous page returned (exclusive); without it the page starts
///   at the first entry. `from_block` starts at the first entry at or after that block.
/// - `limit` defaults to, and is capped at, [`PAGE_LIMIT`] stream rows.
/// - With `epoch`, a full page is `immutable`; a mismatch is **409** (the backfill rewrote
///   the log: read the head again). Without it nothing is cached.
/// - 400 for a parameter that does not parse; 503 if Valkey does not answer in 5 s.
async fn get_page(State(state): State<AppState>, Query(query): Query<PageQuery>) -> Response {
    let (asked_epoch, start, limit) = match parse_page_query(
        query.epoch.as_deref(),
        query.after.as_deref(),
        query.from_block.as_deref(),
        query.limit.as_deref(),
    ) {
        Ok(parsed) => parsed,
        Err(why) => return (StatusCode::BAD_REQUEST, why).into_response(),
    };
    let stale = || {
        (
            StatusCode::CONFLICT,
            [(header::CACHE_CONTROL, "no-store")],
            "the log was rewritten; read /api/history/head again",
        )
            .into_response()
    };
    let mut con = state.valkey.clone();

    // A full default-size page is packed once. The epoch is still read every time (one GET),
    // so a page packed before a backfill is never served after it.
    if limit == PAGE_LIMIT {
        let Ok(Ok(epoch)) = tokio::time::timeout(
            READ_TIMEOUT,
            history::read_epoch(&mut con, crate::consumer::now_ms()),
        )
        .await
        else {
            return unavailable();
        };
        if asked_epoch.is_some_and(|e| e != epoch) {
            return stale();
        }
        let hit = cache()
            .lock()
            .ok()
            .and_then(|c| c.get(&(epoch, start)).cloned());
        if let Some(bytes) = hit {
            return page_response(bytes.to_vec(), epoch, asked_epoch.is_some());
        }
    }

    let Ok(Ok(page)) = tokio::time::timeout(
        READ_TIMEOUT,
        history::read_page(&mut con, start, limit, crate::consumer::now_ms()),
    )
    .await
    else {
        return unavailable();
    };
    if asked_epoch.is_some_and(|e| e != page.epoch) {
        return stale();
    }
    let bytes = history_wire::encode_page(&page.rows, page.next, page.more);
    if page.more && limit == PAGE_LIMIT {
        if let Ok(mut c) = cache().lock() {
            if c.len() >= MAX_CACHED_PAGES {
                c.clear();
            }
            c.insert((page.epoch, start), Arc::new(bytes.clone()));
        }
    }
    page_response(bytes, page.epoch, asked_epoch.is_some() && page.more)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_request_defaults_to_the_start_and_the_full_page() {
        assert_eq!(
            parse_page_query(None, None, None, None),
            Ok((None, PageStart::Beginning, PAGE_LIMIT))
        );
        assert_eq!(
            parse_page_query(Some("3"), Some("223113576000002-7"), None, Some("500")),
            Ok((Some(3), PageStart::After(223_113_576_000_002, 7), 500))
        );
        assert_eq!(
            parse_page_query(None, None, Some("223113576"), None),
            Ok((
                None,
                PageStart::FromPosition(223_113_576_000_000),
                PAGE_LIMIT
            ))
        );
    }

    #[test]
    fn a_page_request_that_does_not_parse_is_refused_not_guessed() {
        for (epoch, after, from_block, limit) in [
            (Some("one"), None, None, None),
            (None, Some("12"), None, None),
            (None, Some("(1-1"), None, None),
            (None, Some("1-1"), Some("1"), None),
            (None, None, Some("-4"), None),
            // block × 10⁶ would overflow a u64
            (None, None, Some("18446744073709551615"), None),
            (None, None, None, Some("0")),
            (None, None, None, Some("20001")),
            (None, None, None, Some("lots")),
        ] {
            assert!(
                parse_page_query(epoch, after, from_block, limit).is_err(),
                "{epoch:?} {after:?} {from_block:?} {limit:?}"
            );
        }
    }
}
