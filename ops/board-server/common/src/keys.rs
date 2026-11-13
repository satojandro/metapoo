//! Valkey keys. Same names as Berry Fast where the meaning is the same.

/// Indexer `LPUSH`es queued events; the server `RPOPLPUSH`es them to `PROCESSING_QUEUE`.
pub const DRAW_QUEUE: &str = "draw_queue";
pub const PROCESSING_QUEUE: &str = "processing_queue";
/// Last block the indexer has fully queued.
pub const LAST_PROCESSED_BLOCK: &str = "last_processed_block";
/// `QueuedEvent::position` of the last event the server applied. Written in the same
/// transaction as the board, so a re-delivered event is recognised and skipped.
pub const LAST_APPLIED_POSITION: &str = "last_applied_position";
pub const LAST_APPLIED_BLOCK: &str = "last_applied_block";

pub const ACCOUNT_TO_ID: &str = "account_to_id";
pub const ID_TO_ACCOUNT: &str = "id_to_account";
/// Next owner id to hand out (ids start at 1; 0 = undrawn).
pub const NEXT_OWNER_ID: &str = "next_owner_id";

/// Sorted set of broadcast messages, scored by block time, for WebSocket catch-up.
pub const DRAW_EVENTS_ZSET: &str = "draw_events";

/// owner id → tiles held (Berry Fast's `account_pixel_count`).
pub const ACCOUNT_PIXEL_COUNT: &str = "account_pixel_count";
/// owner id → earning tiles held (§4 addition; the contract's `get_earning_cells`).
pub const ACCOUNT_EARNING_COUNT: &str = "account_earning_count";
/// Tiles ever painted.
pub const PAINTED_TILES: &str = "painted_tiles";

/// The whole wall: one region.
pub const REGION_KEY: &str = "region:0:0";
pub const REGION_META_KEY: &str = "region_meta:0:0";
/// One bit per tile, set while its latest paint was free.
pub const FREE_BITS_KEY: &str = "free_bits:0:0";
/// Current board side.
pub const BOARD_SIDE: &str = "board_side";
/// Per-tile write time (ms), Berry Fast's `pixel_ts`, trimmed to an hour.
pub const PIXEL_TS_KEY: &str = "pixel_ts:0:0";
pub const WRITTEN_AT_KEY: &str = "written_at:0:0";

/// Wall-clock ms until which someone is watching. The server refreshes it while it has
/// WebSocket clients; the indexer polls the chain only before it. See `demand.rs`.
pub const VIEWERS_UNTIL_MS: &str = "viewers_until_ms";
/// Wall-clock ms of the last paint hint (`POST /api/hint`): poll now, someone just painted.
pub const HINT_AT_MS: &str = "hint_at_ms";
/// Wall-clock ms when a viewer arrived to a server that had none. The indexer polls at once
/// instead of at its next interval, so the first visitor after a quiet spell sees a current
/// mirror within seconds.
pub const VIEWER_ARRIVED_MS: &str = "viewer_arrived_ms";

/// HISTORY (return-and-growth spec §4.2): every applied draw, one stream entry per tile, in
/// applied order. **Never trimmed** (no `MAXLEN`): `draw_events` above is a catch-up buffer
/// trimmed to `CATCHUP_RETENTION_MS` (2 h by default); this is the record a timelapse replays.
/// Entry id `<position>-<index>` (the event's `QueuedEvent::position()`, then the tile's place
/// in the event); fields `block`, `at_ms`, `x`, `y`, `color`, `by`, `free`. See `history.rs`.
pub const DRAW_HISTORY: &str = "draw_history";
/// Where the backfill builds the replayed log before merging it in and renaming it over
/// [`DRAW_HISTORY`].
pub const DRAW_HISTORY_BACKFILL: &str = "draw_history:backfill";

/// AWAY-A (spec §1.2): prefix of one sorted set per account whose tiles were covered,
/// `covers:<account>`, scored by `at_ms`, trimmed to 30 days. See `history.rs`.
pub const COVERS_PREFIX: &str = "covers:";
