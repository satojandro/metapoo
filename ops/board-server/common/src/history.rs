//! The durable draw log (HISTORY, return-and-growth spec §4.2) and per-account cover events
//! (AWAY-A, spec §1.2).
//!
//! **Why a new key.** `draw_events` is the WebSocket catch-up buffer: a sorted set trimmed to
//! `CATCHUP_RETENTION_MS` (2 h by default) on every write. It is not a history, and the spec
//! says not to rely on it as one. The log is a Valkey **stream** with no `MAXLEN`, so nothing
//! ever trims it, and it is written in the consumer's `MULTI`/`EXEC` together with the board:
//! a crash, an RDB rollback or a retry moves both or neither.
//!
//! **One entry per applied tile.** Id `<position>-<index>`: the event's
//! `QueuedEvent::position()` (block × 10⁶ + place in block), then the tile's place in the
//! event. The id is therefore fixed by the chain, not by when the mirror wrote it: a replay
//! from the deploy block produces byte-for-byte the same entries, which is what lets the
//! backfill check itself against what the consumer already wrote, and what lets a timelapse
//! page by block (`XRANGE draw_history <block × 10⁶> +`).
//!
//! **Cover events.** When a draw replaces a tile another account held, the previous holder
//! (the *victim*) gets a member in `covers:<victim>`, scored by `at_ms`. Members are
//! deterministic too, so re-applying a range adds nothing. The set is trimmed to 30 days on
//! each write and expires 30 days after its last write, so an account nobody covers again does
//! not keep a stale set forever.
//!
//! Everything here except the three `async` readers is pure, so the rules are unit-tested.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};

use crate::apply::{AppliedPixel, BoardState};
use crate::event::{BoardEvent, QueuedEvent};
use crate::keys;
use crate::palette;
use crate::region::*;

/// How long cover events are kept (spec §1.2: "trimmed to 30 days").
pub const COVER_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// One applied tile, as the log stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    /// `QueuedEvent::position()` of the event that painted it.
    pub position: u64,
    /// Place of this tile among the event's applied tiles.
    pub index: u32,
    pub block: u64,
    pub at_ms: u64,
    pub x: u32,
    pub y: u32,
    /// Palette index.
    pub color: u32,
    /// The account that now holds the tile.
    pub by: String,
    pub free: bool,
}

impl HistoryEntry {
    pub fn stream_id(&self) -> String {
        format!("{}-{}", self.position, self.index)
    }

    /// Stream fields, in the spec's order: `{block, at_ms, x, y, color, by, free}`.
    pub fn fields(&self) -> [(&'static str, String); 7] {
        [
            ("block", self.block.to_string()),
            ("at_ms", self.at_ms.to_string()),
            ("x", self.x.to_string()),
            ("y", self.y.to_string()),
            ("color", self.color.to_string()),
            ("by", self.by.clone()),
            ("free", u8::from(self.free).to_string()),
        ]
    }

    /// Parse one `XRANGE` row. `None` for anything this module did not write.
    pub fn from_stream(id: &str, fields: &HashMap<String, String>) -> Option<Self> {
        let (position, index) = id.split_once('-')?;
        let num = |name: &str| fields.get(name)?.parse::<u64>().ok();
        Some(Self {
            position: position.parse().ok()?,
            index: index.parse().ok()?,
            block: num("block")?,
            at_ms: num("at_ms")?,
            x: u32::try_from(num("x")?).ok()?,
            y: u32::try_from(num("y")?).ok()?,
            color: u32::try_from(num("color")?).ok()?,
            by: fields.get("by")?.clone(),
            free: fields.get("free")? == "1",
        })
    }

    /// Append this entry to `pipe` (an `XADD` with the fixed id).
    pub fn xadd(&self, pipe: &mut redis::Pipeline, key: &str) {
        let cmd = pipe.cmd("XADD").arg(key).arg(self.stream_id());
        for (field, value) in self.fields() {
            cmd.arg(field).arg(value);
        }
        cmd.ignore();
    }
}

/// One `board_expanded`, as the log stores it (TIMELAPSE, spec §4.3: the wall grows, and a
/// replay needs to know when).
///
/// It is a second **kind** of entry in the same stream, so it sits in applied order with the
/// draws. Id `<position>-0` (an expansion is its own event, so the position is its alone);
/// fields `kind = expand`, `block`, `at_ms`, `from`, `to`. Draw entries carry no `kind` field
/// and are unchanged, so a stream written before this existed reads exactly as before, and a
/// reader that only knows draws ([`HistoryEntry::from_stream`]) skips these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expansion {
    pub position: u64,
    pub block: u64,
    /// Block time: the contract's event carries no time of its own.
    pub at_ms: u64,
    pub from: u32,
    pub to: u32,
}

/// The `kind` field of an [`Expansion`] entry.
pub const KIND_EXPAND: &str = "expand";

impl Expansion {
    pub fn of(event: &QueuedEvent, from: u32, to: u32) -> Self {
        Self {
            position: event.position(),
            block: event.block_height,
            at_ms: event.block_timestamp_ms,
            from,
            to,
        }
    }

    pub fn stream_id(&self) -> String {
        format!("{}-0", self.position)
    }

    pub fn fields(&self) -> [(&'static str, String); 5] {
        [
            ("kind", KIND_EXPAND.to_string()),
            ("block", self.block.to_string()),
            ("at_ms", self.at_ms.to_string()),
            ("from", self.from.to_string()),
            ("to", self.to.to_string()),
        ]
    }

    pub fn from_stream(id: &str, fields: &HashMap<String, String>) -> Option<Self> {
        if fields.get("kind").map(String::as_str) != Some(KIND_EXPAND) {
            return None;
        }
        let (position, _index) = id.split_once('-')?;
        let num = |name: &str| fields.get(name)?.parse::<u64>().ok();
        Some(Self {
            position: position.parse().ok()?,
            block: num("block")?,
            at_ms: num("at_ms")?,
            from: u32::try_from(num("from")?).ok()?,
            to: u32::try_from(num("to")?).ok()?,
        })
    }

    pub fn xadd(&self, pipe: &mut redis::Pipeline, key: &str) {
        let cmd = pipe.cmd("XADD").arg(key).arg(self.stream_id());
        for (field, value) in self.fields() {
            cmd.arg(field).arg(value);
        }
        cmd.ignore();
    }
}

/// Any entry of the log, in stream order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogRow {
    Draw(HistoryEntry),
    Expand(Expansion),
}

impl LogRow {
    /// Parse one `XRANGE` row of either kind. `None` for anything this module did not write.
    pub fn from_stream(id: &str, fields: &HashMap<String, String>) -> Option<Self> {
        if fields.contains_key("kind") {
            return Expansion::from_stream(id, fields).map(Self::Expand);
        }
        HistoryEntry::from_stream(id, fields).map(Self::Draw)
    }

    /// `(position, index)`: the stream id, and the order of the log.
    pub fn key(&self) -> (u64, u32) {
        match self {
            Self::Draw(e) => (e.position, e.index),
            Self::Expand(e) => (e.position, 0),
        }
    }

    pub fn block(&self) -> u64 {
        match self {
            Self::Draw(e) => e.block,
            Self::Expand(e) => e.block,
        }
    }

    pub fn at_ms(&self) -> u64 {
        match self {
            Self::Draw(e) => e.at_ms,
            Self::Expand(e) => e.at_ms,
        }
    }

    pub fn xadd(&self, pipe: &mut redis::Pipeline, key: &str) {
        match self {
            Self::Draw(e) => e.xadd(pipe, key),
            Self::Expand(e) => e.xadd(pipe, key),
        }
    }
}

/// Where the log starts, once the backfill has certified it: the deploy block and the side the
/// board had there (`keys::DRAW_HISTORY_GENESIS`). Absent, the log starts wherever the consumer
/// began writing it, and a reader must not present it as the whole story.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Genesis {
    pub start_block: u64,
    pub initial_side: u32,
}

impl Genesis {
    pub fn from_hash(fields: &HashMap<String, String>) -> Option<Self> {
        Some(Self {
            start_block: fields.get("start_block")?.parse().ok()?,
            initial_side: fields.get("initial_side")?.parse().ok()?,
        })
    }
}

/// One tile of `victim`'s that `by` painted over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cover {
    pub victim: String,
    pub by: String,
    pub x: u32,
    pub y: u32,
    pub at_ms: u64,
    pub position: u64,
    pub index: u32,
}

/// What a `covers:<victim>` member carries after its ordering prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverRecord {
    pub x: u32,
    pub y: u32,
    pub by: String,
    pub at_ms: u64,
}

pub fn cover_key(victim: &str) -> String {
    format!("{}{victim}", keys::COVERS_PREFIX)
}

impl Cover {
    pub fn key(&self) -> String {
        cover_key(&self.victim)
    }

    /// `<position:020>:<index:05>:<json>`. The prefix makes the member unique per tile per
    /// event, so the same cover written twice is one member, and it orders ties on `at_ms`
    /// (several draws in one block) in applied order, as `catchup_member` does.
    pub fn member(&self) -> String {
        let record = CoverRecord {
            x: self.x,
            y: self.y,
            by: self.by.clone(),
            at_ms: self.at_ms,
        };
        format!(
            "{:020}:{:05}:{}",
            self.position,
            self.index,
            serde_json::to_string(&record).expect("a CoverRecord serialises")
        )
    }
}

/// The record inside a `covers:<victim>` member.
pub fn parse_cover_member(member: &str) -> Option<CoverRecord> {
    let mut parts = member.splitn(3, ':');
    let (_position, _index, json) = (parts.next()?, parts.next()?, parts.next()?);
    serde_json::from_str(json).ok()
}

/// When a tile was painted: the contract's `written_at_ns`, else the block time. The same rule
/// as `pixel_ts`.
pub fn pixel_at_ms(pixel: &AppliedPixel, event: &QueuedEvent) -> u64 {
    pixel
        .written_at_ns
        .map_or(event.block_timestamp_ms, |ns| ns / 1_000_000)
}

/// The log entries and cover events for one applied draw. Used by the consumer (with Valkey's
/// owner ids) and by [`Replay`] (with its own), so both write exactly the same thing.
pub fn record<'a>(
    event: &QueuedEvent,
    pixels: &[AppliedPixel],
    name_of: impl Fn(u32) -> Option<&'a str>,
) -> (Vec<HistoryEntry>, Vec<Cover>) {
    let mut entries = Vec::with_capacity(pixels.len());
    let mut covers = Vec::new();
    for (index, p) in pixels.iter().enumerate() {
        let index = index as u32;
        let at_ms = pixel_at_ms(p, event);
        let by = name_of(p.owner_id).unwrap_or_default().to_string();
        if p.previous_owner_id != 0 && p.previous_owner_id != p.owner_id {
            if let Some(victim) = name_of(p.previous_owner_id) {
                covers.push(Cover {
                    victim: victim.to_string(),
                    by: by.clone(),
                    x: p.x,
                    y: p.y,
                    at_ms,
                    position: event.position(),
                    index,
                });
            }
        }
        entries.push(HistoryEntry {
            position: event.position(),
            index,
            block: event.block_height,
            at_ms,
            x: p.x,
            y: p.y,
            color: p.color,
            by,
            free: p.free,
        });
    }
    (entries, covers)
}

/// Append `covers` to `pipe`: `ZADD` each, trim each touched set to [`COVER_RETENTION_MS`]
/// before `trim_at_ms`, and expire the set that long after this write. Covers already older
/// than the window at `now_ms` are not written (a cold rebuild replays months of paint).
pub fn add_covers(pipe: &mut redis::Pipeline, covers: &[Cover], trim_at_ms: u64, now_ms: u64) {
    let floor = now_ms.saturating_sub(COVER_RETENTION_MS);
    let mut by_key: BTreeMap<String, Vec<(f64, String)>> = BTreeMap::new();
    for cover in covers.iter().filter(|c| c.at_ms >= floor) {
        by_key
            .entry(cover.key())
            .or_default()
            .push((cover.at_ms as f64, cover.member()));
    }
    let cutoff = trim_at_ms.max(now_ms).saturating_sub(COVER_RETENTION_MS);
    for (key, members) in by_key {
        pipe.zadd_multiple(&key, &members).ignore();
        // Strictly older than the window.
        pipe.cmd("ZREMRANGEBYSCORE")
            .arg(&key)
            .arg("-inf")
            .arg(format!("({cutoff}"))
            .ignore();
        pipe.pexpire(&key, COVER_RETENTION_MS as i64).ignore();
    }
}

/// `GET /api/account-covers` body: `{count, by: [{account, tiles}], first: {x, y} | null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoverSummary {
    /// Distinct tiles of the account's covered in the window. A tile covered twice counts once.
    pub count: usize,
    /// Per coverer, distinct tiles they covered; most first, ties by account id.
    pub by: Vec<ByAccount>,
    /// The earliest covered tile in the window; `null` when `count` is 0.
    pub first: Option<Tile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ByAccount {
    pub account: String,
    pub tiles: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Tile {
    pub x: u32,
    pub y: u32,
}

/// Summarise cover records **in score order** (oldest first).
pub fn summarize(records: impl IntoIterator<Item = CoverRecord>) -> CoverSummary {
    let mut tiles: BTreeSet<(u32, u32)> = BTreeSet::new();
    let mut per: HashMap<String, BTreeSet<(u32, u32)>> = HashMap::new();
    let mut first = None;
    for r in records {
        first.get_or_insert(Tile { x: r.x, y: r.y });
        tiles.insert((r.x, r.y));
        per.entry(r.by).or_default().insert((r.x, r.y));
    }
    let mut by: Vec<ByAccount> = per
        .into_iter()
        .map(|(account, t)| ByAccount {
            account,
            tiles: t.len(),
        })
        .collect();
    by.sort_by(|a, b| {
        b.tiles
            .cmp(&a.tiles)
            .then_with(|| a.account.cmp(&b.account))
    });
    CoverSummary {
        count: tiles.len(),
        by,
        first,
    }
}

/// The board rebuilt from events alone, with its own owner ids: the backfill's source of log
/// entries. It applies events exactly as `server/src/board.rs` does (same `apply_draw`, same
/// `board_expanded` rule) and records them with the same [`record`].
pub struct Replay {
    pub board: BoardState,
    ids: HashMap<String, u32>,
    names: HashMap<u32, String>,
}

/// What one replayed event produced.
#[derive(Debug, Default)]
pub struct Replayed {
    pub entries: Vec<HistoryEntry>,
    pub covers: Vec<Cover>,
    pub skipped: Vec<String>,
    /// Set when the event was a `board_expanded`.
    pub expansion: Option<Expansion>,
}

impl Replayed {
    /// What this event adds to the log, in stream order.
    pub fn rows(&self) -> Vec<LogRow> {
        self.expansion
            .iter()
            .cloned()
            .map(LogRow::Expand)
            .chain(self.entries.iter().cloned().map(LogRow::Draw))
            .collect()
    }
}

impl Replay {
    pub fn new(initial_side: u32) -> Self {
        Self {
            board: BoardState::empty(initial_side),
            ids: HashMap::new(),
            names: HashMap::new(),
        }
    }

    fn id(&mut self, account: &str) -> u32 {
        if let Some(&id) = self.ids.get(account) {
            return id;
        }
        let id = self.ids.len() as u32 + 1;
        self.ids.insert(account.to_string(), id);
        self.names.insert(id, account.to_string());
        id
    }

    pub fn apply(&mut self, event: &QueuedEvent) -> Replayed {
        match &event.event {
            BoardEvent::Draw { entries, .. } => {
                let artists: Vec<String> = entries
                    .iter()
                    .map(|e| {
                        e.artist
                            .clone()
                            .unwrap_or_else(|| event.predecessor_id.clone())
                    })
                    .chain(std::iter::once(event.predecessor_id.clone()))
                    .collect();
                for artist in &artists {
                    self.id(artist);
                }
                let out = self
                    .board
                    .apply_draw(entries, &event.predecessor_id, &self.ids);
                let (entries, covers) = record(event, &out.pixels, |id| {
                    self.names.get(&id).map(String::as_str)
                });
                Replayed {
                    entries,
                    covers,
                    skipped: out.skipped,
                    expansion: None,
                }
            }
            BoardEvent::BoardExpanded { from, to } => {
                self.board.side = *to;
                Replayed {
                    expansion: Some(Expansion::of(event, *from, *to)),
                    ..Replayed::default()
                }
            }
            BoardEvent::StateMigrated { .. } => Replayed::default(),
        }
    }
}

/// Differences between the log's tile state and the stored board, at most `limit` of them.
/// Empty means they agree: every painted tile's latest log entry has the blob's colour, holder
/// and free bit, and no unpainted tile has an entry.
pub fn compare_tip(
    entries: &[HistoryEntry],
    blob: &[u8],
    free_bits: &[u8],
    names: &HashMap<u32, String>,
    limit: usize,
) -> Vec<String> {
    let mut latest: HashMap<(u32, u32), &HistoryEntry> = HashMap::new();
    for e in entries {
        latest.insert((e.x, e.y), e);
    }
    let mut out = Vec::new();
    if blob.len() != REGION_BLOB_SIZE || free_bits.len() != FREE_BITMAP_SIZE {
        out.push(format!(
            "stored board has {} blob bytes and {} free-bit bytes, expected {REGION_BLOB_SIZE} and {FREE_BITMAP_SIZE}",
            blob.len(),
            free_bits.len()
        ));
        return out;
    }
    for y in 0..REGION_SIZE {
        for x in 0..REGION_SIZE {
            if out.len() >= limit {
                return out;
            }
            let offset = pixel_offset(x, y).expect("inside the region");
            let index = tile_index(x, y).expect("inside the region");
            let pixel = Pixel::decode(&blob[offset..offset + PIXEL_SIZE]);
            let entry = latest.get(&(x, y));
            match (pixel.is_empty(), entry) {
                (true, None) => {}
                (true, Some(e)) => out.push(format!(
                    "({x}, {y}): blank on the board, the log has {} at block {}",
                    e.by, e.block
                )),
                (false, None) => out.push(format!(
                    "({x}, {y}): painted on the board, absent from the log"
                )),
                (false, Some(e)) => {
                    let holder = names.get(&pixel.owner_id).map(String::as_str);
                    let rgb = palette::rgb(e.color);
                    let free = bit_get(free_bits, index);
                    if holder != Some(e.by.as_str())
                        || rgb != Some((pixel.r, pixel.g, pixel.b))
                        || free != e.free
                    {
                        out.push(format!(
                            "({x}, {y}): board {:?} #{:02X}{:02X}{:02X} free={free}, log {} colour {} free={} (block {})",
                            holder, pixel.r, pixel.g, pixel.b, e.by, e.color, e.free, e.block
                        ));
                    }
                }
            }
        }
    }
    out
}

/// Differences between the log's `board_expanded` entries and the stored side, at most `limit`.
///
/// - the entries must chain: each one's `from` is the side the one before it left;
/// - the last one's `to` is the stored side;
/// - with a [`Genesis`] (the backfill ran), the chain starts at its `initial_side`, so a board
///   that grew while an older server was writing the log (which logged no expansions) fails
///   here until the backfill is run again;
/// - no draw lies outside the side in force when it was applied, as far as the log can know
///   it (from the genesis side, else from the first expansion's `from`).
pub fn compare_side(
    rows: &[LogRow],
    stored_side: Option<u32>,
    genesis: Option<Genesis>,
    limit: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let first_from = rows.iter().find_map(|r| match r {
        LogRow::Expand(e) => Some(e.from),
        LogRow::Draw(_) => None,
    });
    let mut side = genesis.map(|g| g.initial_side).or(first_from);
    for row in rows {
        if out.len() >= limit {
            return out;
        }
        match row {
            LogRow::Expand(e) => {
                if side.is_some_and(|s| s != e.from) {
                    out.push(format!(
                        "board_expanded at block {} goes from {} but the log's side was {}",
                        e.block,
                        e.from,
                        side.unwrap_or_default()
                    ));
                }
                side = Some(e.to);
            }
            LogRow::Draw(e) => {
                if side.is_some_and(|s| e.x >= s || e.y >= s) {
                    out.push(format!(
                        "({}, {}) at block {} is outside the log's side {}: a board_expanded is missing from the log",
                        e.x,
                        e.y,
                        e.block,
                        side.unwrap_or_default()
                    ));
                }
            }
        }
    }
    if let (Some(log), Some(stored)) = (side, stored_side) {
        if log != stored && out.len() < limit {
            out.push(format!(
                "the board's side is {stored} but the log's expansions end at {log}"
            ));
        }
    }
    out
}

type StreamRows = Vec<(String, HashMap<String, String>)>;

fn parse_rows(rows: StreamRows) -> Vec<LogRow> {
    rows.iter()
        .filter_map(|(id, fields)| LogRow::from_stream(id, fields))
        .collect()
}

/// The draws among `rows`, in order.
pub fn draws(rows: &[LogRow]) -> Vec<HistoryEntry> {
    rows.iter()
        .filter_map(|r| match r {
            LogRow::Draw(e) => Some(e.clone()),
            LogRow::Expand(_) => None,
        })
        .collect()
}

/// The expansions among `rows`, in order.
pub fn expansions(rows: &[LogRow]) -> Vec<Expansion> {
    rows.iter()
        .filter_map(|r| match r {
            LogRow::Expand(e) => Some(e.clone()),
            LogRow::Draw(_) => None,
        })
        .collect()
}

/// Rows per `XRANGE` page.
const PAGE: usize = 5_000;

/// The whole stream at `key`, both kinds, oldest first, read in pages. Also returns the last
/// id read.
pub async fn read_rows(
    con: &mut ConnectionManager,
    key: &str,
) -> redis::RedisResult<(Vec<LogRow>, Option<String>)> {
    let mut out = Vec::new();
    let mut last: Option<String> = None;
    loop {
        let start = last
            .as_ref()
            .map_or_else(|| "-".to_string(), |id| format!("({id}"));
        let rows: StreamRows = redis::cmd("XRANGE")
            .arg(key)
            .arg(start)
            .arg("+")
            .arg("COUNT")
            .arg(PAGE)
            .query_async(con)
            .await?;
        let n = rows.len();
        if let Some((id, _)) = rows.last() {
            last = Some(id.clone());
        }
        out.extend(parse_rows(rows));
        if n < PAGE {
            return Ok((out, last));
        }
    }
}

/// The draws of the stream at `key`, oldest first (expansions left out). Also returns the last
/// id read.
pub async fn read_log(
    con: &mut ConnectionManager,
    key: &str,
) -> redis::RedisResult<(Vec<HistoryEntry>, Option<String>)> {
    let (rows, last) = read_rows(con, key).await?;
    Ok((draws(&rows), last))
}

/// One page of the log for `GET /api/history`: at most `limit` stream rows after `after`
/// (exclusive; `None` = from the start), or from `from_position` (inclusive) when given
/// instead. One bounded `XRANGE`, read in a `MULTI` with the epoch it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPage {
    pub epoch: u64,
    pub rows: Vec<LogRow>,
    /// Id of the last stream row read (parsed or not): the cursor for the next page.
    pub next: Option<(u64, u32)>,
    /// The page was full, so there may be more after `next`.
    pub more: bool,
}

/// Where a page starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PageStart {
    /// The very first row.
    Beginning,
    /// Exclusive: the row after this stream id.
    After(u64, u32),
    /// Inclusive: the first row at or after this event position.
    FromPosition(u64),
}

impl PageStart {
    fn xrange_arg(self) -> String {
        match self {
            Self::Beginning => "-".to_string(),
            Self::After(position, index) => format!("({position}-{index}"),
            Self::FromPosition(position) => format!("{position}-0"),
        }
    }
}

/// `"<position>-<index>"`, as a cursor.
pub fn parse_stream_id(id: &str) -> Option<(u64, u32)> {
    let (position, index) = id.split_once('-')?;
    Some((position.parse().ok()?, index.parse().ok()?))
}

/// The log's epoch: a number that names this copy of the log and is part of every cacheable
/// page URL. It is the wall-clock ms at which the copy was first read or last rewritten, not a
/// counter, so a mirror that is wiped and rebuilt gets a new one and can never be confused
/// with pages cached from the copy before it. Set on first use (`SET … NX`).
pub async fn read_epoch(con: &mut ConnectionManager, now_ms: u64) -> redis::RedisResult<u64> {
    let (epoch,): (u64,) = redis::pipe()
        .atomic()
        .cmd("SET")
        .arg(keys::DRAW_HISTORY_EPOCH)
        .arg(now_ms)
        .arg("NX")
        .ignore()
        .get(keys::DRAW_HISTORY_EPOCH)
        .query_async(con)
        .await?;
    Ok(epoch)
}

pub async fn read_page(
    con: &mut ConnectionManager,
    start: PageStart,
    limit: usize,
    now_ms: u64,
) -> redis::RedisResult<RawPage> {
    let (epoch, rows): (u64, StreamRows) = redis::pipe()
        .atomic()
        .cmd("SET")
        .arg(keys::DRAW_HISTORY_EPOCH)
        .arg(now_ms)
        .arg("NX")
        .ignore()
        .get(keys::DRAW_HISTORY_EPOCH)
        .cmd("XRANGE")
        .arg(keys::DRAW_HISTORY)
        .arg(start.xrange_arg())
        .arg("+")
        .arg("COUNT")
        .arg(limit)
        .query_async(con)
        .await?;
    let next = rows.last().and_then(|(id, _)| parse_stream_id(id));
    let more = rows.len() >= limit;
    Ok(RawPage {
        epoch,
        rows: parse_rows(rows),
        next,
        more,
    })
}

/// `GET /api/history/head`: what the log holds, without reading it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Head {
    /// Names this copy of the log ([`read_epoch`]); changes whenever the backfill rewrites it.
    /// Part of every cacheable page URL.
    pub epoch: u64,
    /// True once the backfill has certified that the log starts at the deploy block.
    pub complete: bool,
    pub start_block: Option<u64>,
    pub initial_side: Option<u32>,
    /// Stream rows (tiles painted plus expansions).
    pub entries: u64,
    pub first: Option<Moment>,
    pub last: Option<Moment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Moment {
    pub block: u64,
    pub at_ms: u64,
}

fn moment(rows: StreamRows) -> Option<Moment> {
    parse_rows(rows).first().map(|r| Moment {
        block: r.block(),
        at_ms: r.at_ms(),
    })
}

/// Five O(1) reads (and the epoch's first-use `SET … NX`) in one `MULTI`.
pub async fn read_head(con: &mut ConnectionManager, now_ms: u64) -> redis::RedisResult<Head> {
    type Snapshot = (u64, HashMap<String, String>, u64, StreamRows, StreamRows);
    let (epoch, genesis, entries, first, last): Snapshot = redis::pipe()
        .atomic()
        .cmd("SET")
        .arg(keys::DRAW_HISTORY_EPOCH)
        .arg(now_ms)
        .arg("NX")
        .ignore()
        .get(keys::DRAW_HISTORY_EPOCH)
        .hgetall(keys::DRAW_HISTORY_GENESIS)
        .cmd("XLEN")
        .arg(keys::DRAW_HISTORY)
        .cmd("XRANGE")
        .arg(keys::DRAW_HISTORY)
        .arg("-")
        .arg("+")
        .arg("COUNT")
        .arg(1)
        .cmd("XREVRANGE")
        .arg(keys::DRAW_HISTORY)
        .arg("+")
        .arg("-")
        .arg("COUNT")
        .arg(1)
        .query_async(con)
        .await?;
    let genesis = Genesis::from_hash(&genesis);
    Ok(Head {
        epoch,
        complete: genesis.is_some(),
        start_block: genesis.map(|g| g.start_block),
        initial_side: genesis.map(|g| g.initial_side),
        entries,
        first: moment(first),
        last: moment(last),
    })
}

/// The result of the tip check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TipReport {
    /// Draw entries (tiles painted).
    pub entries: usize,
    /// `board_expanded` entries.
    pub expansions: usize,
    /// Block of the log's first and last entries.
    pub first_block: Option<u64>,
    pub last_block: Option<u64>,
    pub last_applied_position: Option<u64>,
    /// Set once the backfill has certified the log from the deploy block.
    pub genesis: Option<Genesis>,
    /// Empty when the log's tile state equals the stored blob and its expansions end at the
    /// stored side.
    pub differences: Vec<String>,
}

impl TipReport {
    pub fn matches(&self) -> bool {
        self.differences.is_empty()
    }
}

/// Spec §4.2: the log's tile state at the tip must equal the live blob; and (TIMELAPSE) its
/// expansions must end at the stored side.
///
/// Reads the log in pages, then reads the board, the names and the log's newest entries in
/// one `MULTI`, so a draw the consumer applies meanwhile is either in both or in neither.
pub async fn tip_check(con: &mut ConnectionManager, limit: usize) -> redis::RedisResult<TipReport> {
    let (mut rows, last) = read_rows(con, keys::DRAW_HISTORY).await?;
    let start = last.map_or_else(|| "-".to_string(), |id| format!("({id}"));
    type Snapshot = (
        Vec<u8>,
        Vec<u8>,
        HashMap<u32, String>,
        Option<u64>,
        Option<u32>,
        HashMap<String, String>,
        StreamRows,
    );
    let (blob, free_bits, names, applied, side, genesis, tail): Snapshot = redis::pipe()
        .atomic()
        .get(keys::REGION_KEY)
        .get(keys::FREE_BITS_KEY)
        .hgetall(keys::ID_TO_ACCOUNT)
        .get(keys::LAST_APPLIED_POSITION)
        .get(keys::BOARD_SIDE)
        .hgetall(keys::DRAW_HISTORY_GENESIS)
        .cmd("XRANGE")
        .arg(keys::DRAW_HISTORY)
        .arg(start)
        .arg("+")
        .query_async(con)
        .await?;
    rows.extend(parse_rows(tail));
    let entries = draws(&rows);
    let genesis = Genesis::from_hash(&genesis);
    // A board nothing has painted yet has no blob; compare it as all blank.
    let blob = if blob.is_empty() {
        vec![0; REGION_BLOB_SIZE]
    } else {
        blob
    };
    let free_bits = if free_bits.is_empty() {
        vec![0; FREE_BITMAP_SIZE]
    } else {
        free_bits
    };
    let mut differences = compare_tip(&entries, &blob, &free_bits, &names, limit);
    differences.extend(compare_side(
        &rows,
        side,
        genesis,
        limit.saturating_sub(differences.len()),
    ));
    Ok(TipReport {
        entries: entries.len(),
        expansions: rows.len() - entries.len(),
        first_block: rows.first().map(LogRow::block),
        last_block: rows.last().map(LogRow::block),
        last_applied_position: applied,
        genesis,
        differences,
    })
}

/// Cover records for `victim` with `at_ms >= since_ms`, oldest first.
pub async fn read_covers(
    con: &mut ConnectionManager,
    victim: &str,
    since_ms: u64,
) -> redis::RedisResult<Vec<CoverRecord>> {
    let members: Vec<String> = con
        .zrangebyscore(cover_key(victim), since_ms, "+inf")
        .await?;
    Ok(members
        .iter()
        .filter_map(|m| parse_cover_member(m))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::DrawEntry;

    fn draw(block: u64, seq: u32, artist: &str, cells: &[(u32, u32, u32, bool)]) -> QueuedEvent {
        QueuedEvent {
            block_height: block,
            block_timestamp_ms: block * 1000,
            seq,
            receipt_id: format!("r{block}-{seq}"),
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
                        written_at_ns: Some(block * 1_000_000_000 + 5_000_000),
                        credits: u32::from(!free),
                        free,
                    })
                    .collect(),
            },
        }
    }

    #[test]
    fn an_entry_round_trips_through_its_stream_fields() {
        let e = HistoryEntry {
            position: 223_113_576_000_003,
            index: 7,
            block: 223_113_576,
            at_ms: 1_762_000_000_123,
            x: 12,
            y: 34,
            color: 5,
            by: "alice.near".into(),
            free: true,
        };
        assert_eq!(e.stream_id(), "223113576000003-7");
        let fields: HashMap<String, String> = e
            .fields()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        assert_eq!(fields["free"], "1");
        assert_eq!(HistoryEntry::from_stream(&e.stream_id(), &fields), Some(e));
        assert_eq!(HistoryEntry::from_stream("junk", &fields), None);
    }

    #[test]
    fn replay_logs_every_applied_tile_and_covers_only_other_accounts() {
        let mut replay = Replay::new(64);
        let first = replay.apply(&draw(
            10,
            0,
            "bob.near",
            &[(1, 1, 2, false), (2, 2, 3, true)],
        ));
        assert_eq!(first.entries.len(), 2);
        assert!(
            first.covers.is_empty(),
            "painting blank tiles covers nobody"
        );
        assert_eq!(
            first.entries[0].at_ms, 10_005,
            "written_at_ns, not block time"
        );
        assert_eq!(first.entries[1].stream_id(), "10000000-1");

        // alice covers one of bob's, repaints it herself in the same stroke, and paints a
        // blank tile; bob repaints his own other tile.
        let second = replay.apply(&draw(
            11,
            0,
            "alice.near",
            &[(1, 1, 5, false), (1, 1, 6, false), (3, 3, 1, false)],
        ));
        assert_eq!(second.entries.len(), 3);
        assert_eq!(second.covers.len(), 1, "the repaint in the stroke is hers");
        let c = &second.covers[0];
        assert_eq!(
            (c.victim.as_str(), c.by.as_str(), c.x, c.y),
            ("bob.near", "alice.near", 1, 1)
        );
        let own = replay.apply(&draw(12, 0, "bob.near", &[(2, 2, 4, false)]));
        assert!(
            own.covers.is_empty(),
            "repainting your own tile is not a cover"
        );
    }

    #[test]
    fn replay_skips_what_the_contract_would_reject_and_follows_board_expanded() {
        let mut replay = Replay::new(64);
        let off = replay.apply(&draw(1, 0, "a.near", &[(100, 100, 1, false)]));
        assert!(off.entries.is_empty());
        assert_eq!(off.skipped.len(), 1);
        let mut grow = draw(2, 0, "owner.near", &[]);
        grow.event = BoardEvent::BoardExpanded { from: 64, to: 128 };
        let grown = replay.apply(&grow);
        assert!(grown.entries.is_empty());
        assert_eq!(
            grown.rows(),
            vec![LogRow::Expand(Expansion {
                position: 2_000_000,
                block: 2,
                at_ms: 2_000,
                from: 64,
                to: 128
            })]
        );
        assert_eq!(
            replay
                .apply(&draw(3, 0, "a.near", &[(100, 100, 1, false)]))
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn the_same_cover_has_the_same_member_and_members_order_by_position() {
        let mut a = Replay::new(64);
        let mut b = Replay::new(64);
        let events = [
            draw(10, 0, "bob.near", &[(1, 1, 2, false)]),
            draw(11, 0, "alice.near", &[(1, 1, 5, false)]),
        ];
        let covers = |r: &mut Replay| -> Vec<String> {
            events
                .iter()
                .flat_map(|e| r.apply(e).covers)
                .map(|c| c.member())
                .collect()
        };
        assert_eq!(covers(&mut a), covers(&mut b));
        let member = covers(&mut Replay::new(64)).remove(0);
        assert_eq!(
            parse_cover_member(&member),
            Some(CoverRecord {
                x: 1,
                y: 1,
                by: "alice.near".into(),
                at_ms: 11_005
            })
        );
        let early = Cover {
            victim: "v".into(),
            by: "b".into(),
            x: 0,
            y: 0,
            at_ms: 1,
            position: 5,
            index: 10,
        };
        let later = Cover {
            index: 2,
            position: 6,
            ..early.clone()
        };
        assert!(early.member() < later.member());
    }

    fn record_at(x: u32, y: u32, by: &str, at_ms: u64) -> CoverRecord {
        CoverRecord {
            x,
            y,
            by: by.into(),
            at_ms,
        }
    }

    #[test]
    fn the_summary_counts_distinct_tiles_and_ranks_coverers() {
        let summary = summarize([
            record_at(4, 4, "carol.near", 1),
            record_at(1, 1, "bob.near", 2),
            record_at(2, 2, "bob.near", 3),
            // The same tile covered again (won back in between): one tile, not two.
            record_at(4, 4, "bob.near", 4),
            record_at(1, 1, "bob.near", 5),
        ]);
        assert_eq!(summary.count, 3);
        assert_eq!(
            summary.by,
            vec![
                ByAccount {
                    account: "bob.near".into(),
                    tiles: 3
                },
                ByAccount {
                    account: "carol.near".into(),
                    tiles: 1
                },
            ]
        );
        assert_eq!(summary.first, Some(Tile { x: 4, y: 4 }));
        assert_eq!(
            serde_json::to_value(&summary).unwrap(),
            serde_json::json!({
                "count": 3,
                "by": [{"account": "bob.near", "tiles": 3}, {"account": "carol.near", "tiles": 1}],
                "first": {"x": 4, "y": 4},
            })
        );
    }

    #[test]
    fn an_empty_summary_has_a_null_first() {
        assert_eq!(
            serde_json::to_value(summarize([])).unwrap(),
            serde_json::json!({"count": 0, "by": [], "first": null})
        );
        // Ties rank by account id, so the order is stable.
        let tie = summarize([record_at(1, 1, "z.near", 1), record_at(2, 2, "a.near", 2)]);
        assert_eq!(tie.by[0].account, "a.near");
    }

    #[test]
    fn the_tip_check_agrees_with_the_board_it_was_built_beside() {
        let mut replay = Replay::new(64);
        let mut log = Vec::new();
        for e in [
            draw(10, 0, "bob.near", &[(1, 1, 2, false), (2, 2, 3, true)]),
            draw(11, 0, "alice.near", &[(1, 1, 5, false)]),
        ] {
            log.extend(replay.apply(&e).entries);
        }
        let names = replay.names.clone();
        let board = &replay.board;
        assert!(compare_tip(&log, &board.blob, &board.free_bits, &names, 10).is_empty());

        // A missing entry, a wrong holder and a blank tile the log thinks is painted all show.
        let mut short = log.clone();
        short.remove(1); // (2, 2)
        let diffs = compare_tip(&short, &board.blob, &board.free_bits, &names, 10);
        assert_eq!(diffs.len(), 1, "{diffs:?}");
        assert!(diffs[0].starts_with("(2, 2): painted on the board"));

        let mut wrong = log.clone();
        wrong[2].by = "mallory.near".into();
        wrong.push(HistoryEntry {
            x: 9,
            y: 9,
            ..log[0].clone()
        });
        assert_eq!(
            compare_tip(&wrong, &board.blob, &board.free_bits, &names, 10).len(),
            2
        );
        assert_eq!(
            compare_tip(&wrong, &board.blob, &board.free_bits, &names, 1).len(),
            1,
            "capped"
        );
    }

    fn fields_of<const N: usize>(fields: [(&'static str, String); N]) -> HashMap<String, String> {
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn an_expansion_round_trips_and_a_draw_only_reader_skips_it() {
        let e = Expansion {
            position: 223_200_000_000_001,
            block: 223_200_000,
            at_ms: 1_762_000_500_000,
            from: 64,
            to: 96,
        };
        assert_eq!(e.stream_id(), "223200000000001-0");
        let fields = fields_of(e.fields());
        assert_eq!(fields["kind"], "expand");
        assert_eq!(
            LogRow::from_stream(&e.stream_id(), &fields),
            Some(LogRow::Expand(e.clone()))
        );
        // The reader that shipped with HISTORY: an expansion is not a draw, so it is skipped
        // rather than misread.
        assert_eq!(HistoryEntry::from_stream(&e.stream_id(), &fields), None);
        // An unknown kind from some later version is skipped too, not read as a draw.
        let mut other = fields.clone();
        other.insert("kind".into(), "something-new".into());
        assert_eq!(LogRow::from_stream(&e.stream_id(), &other), None);
    }

    #[test]
    fn an_entry_written_before_expansions_existed_still_parses_as_a_draw() {
        // Exactly the seven fields the HISTORY consumer wrote: no `kind`.
        let fields: HashMap<String, String> = [
            ("block", "100"),
            ("at_ms", "5000"),
            ("x", "1"),
            ("y", "2"),
            ("color", "3"),
            ("by", "bob.near"),
            ("free", "0"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let Some(LogRow::Draw(e)) = LogRow::from_stream("100000000-4", &fields) else {
            panic!("an old draw entry must still parse")
        };
        assert_eq!(
            (e.position, e.index, e.x, e.y, e.color),
            (100_000_000, 4, 1, 2, 3)
        );
    }

    fn paint_at(block: u64, x: u32, y: u32) -> LogRow {
        LogRow::Draw(HistoryEntry {
            position: block * 1_000_000,
            index: 0,
            block,
            at_ms: block * 1000,
            x,
            y,
            color: 1,
            by: "a.near".into(),
            free: false,
        })
    }

    fn grow_at(block: u64, from: u32, to: u32) -> LogRow {
        LogRow::Expand(Expansion {
            position: block * 1_000_000,
            block,
            at_ms: block * 1000,
            from,
            to,
        })
    }

    #[test]
    fn the_side_check_follows_the_expansions_to_the_stored_side() {
        let genesis = Some(Genesis {
            start_block: 1,
            initial_side: 64,
        });
        let log = [
            paint_at(1, 3, 3),
            grow_at(2, 64, 96),
            paint_at(3, 90, 90),
            grow_at(4, 96, 128),
            paint_at(5, 120, 5),
        ];
        assert!(compare_side(&log, Some(128), genesis, 10).is_empty());
        // No genesis (the backfill has not run): the chain is still checked from its first link.
        assert!(compare_side(&log, Some(128), None, 10).is_empty());

        // The board grew but the log never heard (an older server wrote it).
        let stale = compare_side(&log[..3], Some(128), genesis, 10);
        assert_eq!(stale.len(), 1, "{stale:?}");
        assert!(stale[0].contains("side is 128"));

        // A draw beyond the side in force, and a link that does not chain.
        let missing = [paint_at(1, 3, 3), paint_at(3, 90, 90)];
        let d = compare_side(&missing, Some(96), genesis, 10);
        assert_eq!(d.len(), 2, "{d:?}");
        assert!(d[0].starts_with("(90, 90)"));
        let unchained = [grow_at(2, 64, 96), grow_at(4, 64, 128)];
        assert_eq!(compare_side(&unchained, Some(128), genesis, 10).len(), 1);
        // A log with no expansions and no genesis claims nothing about the side.
        assert!(compare_side(&missing, Some(96), None, 10).is_empty());
        assert_eq!(
            compare_side(&missing, Some(96), genesis, 1).len(),
            1,
            "capped"
        );
    }

    #[test]
    fn page_starts_and_cursors() {
        assert_eq!(PageStart::Beginning.xrange_arg(), "-");
        assert_eq!(
            PageStart::After(100_000_000, 7).xrange_arg(),
            "(100000000-7"
        );
        assert_eq!(
            PageStart::FromPosition(100_000_000).xrange_arg(),
            "100000000-0"
        );
        assert_eq!(parse_stream_id("100000000-7"), Some((100_000_000, 7)));
        assert_eq!(parse_stream_id("100000000"), None);
        assert_eq!(parse_stream_id("a-b"), None);
    }

    #[test]
    fn covers_outside_the_window_are_not_written() {
        let now = 100 * COVER_RETENTION_MS;
        let cover = |at_ms| Cover {
            victim: "bob.near".into(),
            by: "alice.near".into(),
            x: 1,
            y: 1,
            at_ms,
            position: at_ms,
            index: 0,
        };
        let mut pipe = redis::pipe();
        add_covers(&mut pipe, &[cover(now - COVER_RETENTION_MS - 1)], now, now);
        assert_eq!(pipe.cmd_iter().count(), 0);
        add_covers(&mut pipe, &[cover(now - 5)], now, now);
        // ZADD, ZREMRANGEBYSCORE, PEXPIRE.
        assert_eq!(pipe.cmd_iter().count(), 3);
    }
}
