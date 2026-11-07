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
