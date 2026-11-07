//! The mirror's Valkey side: load the board, hand out owner ids, and write one event's effects
//! in one `MULTI`/`EXEC`. Port of Berry Fast's `server/src/board.rs` without the ownership rules
//! (the contract enforces them) and without regions (the wall is one region).

use std::collections::HashMap;

use common::keys;
use common::{
    BoardEvent, BoardState, QueuedEvent, FREE_BITMAP_SIZE, MAX_OWNER_ID, REGION_BLOB_SIZE,
    WRITTEN_AT_SIZE,
};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

/// What applying one event produced: the message to broadcast (if any) and the new state.
pub struct Applied {
    pub message: Option<serde_json::Value>,
    pub state: BoardState,
    pub skipped: Vec<String>,
}

pub async fn load(
    con: &mut ConnectionManager,
    initial_side: u32,
) -> redis::RedisResult<BoardState> {
    let mut state = BoardState::empty(initial_side);
    let blob: Vec<u8> = con.get(keys::REGION_KEY).await?;
    if blob.len() == REGION_BLOB_SIZE {
        state.blob = blob;
    }
    let bits: Vec<u8> = con.get(keys::FREE_BITS_KEY).await?;
    if bits.len() == FREE_BITMAP_SIZE {
        state.free_bits = bits;
    }
    let written: Vec<u8> = con.get(keys::WRITTEN_AT_KEY).await?;
    if written.len() == WRITTEN_AT_SIZE {
        state.written_at = written;
    }
    let side: Option<u32> = con.get(keys::BOARD_SIDE).await?;
    state.side = side.unwrap_or(initial_side);
    Ok(state)
}

/// Owner id for `account`, assigning the next one if it has none. Ids start at 1 (0 = undrawn).
/// Safe to repeat: `HSETNX` keeps the first id if two calls race or a crash repeats one.
pub async fn resolve_owner_id(con: &mut ConnectionManager, account: &str) -> anyhow::Result<u32> {
    if let Some(id) = con
        .hget::<_, _, Option<u32>>(keys::ACCOUNT_TO_ID, account)
        .await?
    {
        return Ok(id);
    }
    let candidate: u32 = con.incr(keys::NEXT_OWNER_ID, 1).await?;
    if candidate > MAX_OWNER_ID {
        anyhow::bail!("owner ids exhausted the u24 field");
    }
    let set: bool = con.hset_nx(keys::ACCOUNT_TO_ID, account, candidate).await?;
    let id = if set {
        candidate
    } else {
        con.hget(keys::ACCOUNT_TO_ID, account).await?
    };
    let _: () = con.hset(keys::ID_TO_ACCOUNT, id, account).await?;
    Ok(id)
}

/// Apply `event` to a copy of `state` and build the transaction that persists it. Nothing in
/// memory changes until the transaction succeeds: the caller swaps in `Applied::state` after.
pub async fn apply(
    con: &mut ConnectionManager,
    state: &BoardState,
    event: &QueuedEvent,
    catchup_retention_ms: u64,
) -> anyhow::Result<(Applied, redis::Pipeline)> {
    let mut next = state.clone();
    let mut pipe = redis::pipe();
    pipe.atomic();
    let mut skipped = Vec::new();

    let message = match &event.event {
        BoardEvent::Draw { method, entries } => {
            let mut owner_ids: HashMap<String, u32> = HashMap::new();
            let mut names: HashMap<u32, String> = HashMap::new();
            let artists = entries
                .iter()
                .map(|e| {
                    e.artist
                        .clone()
                        .unwrap_or_else(|| event.predecessor_id.clone())
                })
                .chain(std::iter::once(event.predecessor_id.clone()));
            for artist in artists {
                if !owner_ids.contains_key(&artist) {
                    let id = resolve_owner_id(con, &artist).await?;
                    owner_ids.insert(artist.clone(), id);
                    names.insert(id, artist);
                }
            }
            let out = next.apply_draw(entries, &event.predecessor_id, &owner_ids);
            skipped = out.skipped;

            // Names of previous holders, so the page can say "covered 9 of sunny.near's".
            for p in &out.pixels {
                if p.previous_owner_id != 0 && !names.contains_key(&p.previous_owner_id) {
                    let name: Option<String> =
                        con.hget(keys::ID_TO_ACCOUNT, p.previous_owner_id).await?;
                    if let Some(name) = name {
                        names.insert(p.previous_owner_id, name);
                    }
                }
            }

            for (id, delta) in &out.pixel_delta {
                pipe.hincr(keys::ACCOUNT_PIXEL_COUNT, *id, *delta).ignore();
            }
            for (id, delta) in &out.earning_delta {
                pipe.hincr(keys::ACCOUNT_EARNING_COUNT, *id, *delta)
                    .ignore();
            }
            if out.newly_painted > 0 {
                pipe.incr(keys::PAINTED_TILES, out.newly_painted).ignore();
            }
            if !out.pixels.is_empty() {
                let ts: Vec<(f64, String)> = out
                    .pixels
                    .iter()
                    .map(|p| {
                        let ms = p
                            .written_at_ns
                            .map_or(event.block_timestamp_ms, |ns| ns / 1_000_000);
                        (ms as f64, format!("{},{}", p.x, p.y))
                    })
                    .collect();
                pipe.zadd_multiple(keys::PIXEL_TS_KEY, &ts).ignore();
                pipe.zrembyscore(
                    keys::PIXEL_TS_KEY,
                    0u64,
                    event.block_timestamp_ms.saturating_sub(3_600_000),
                )
                .ignore();
            }

            (!out.pixels.is_empty()).then(|| {
                serde_json::json!({
                    "type": "draw",
                    "method": method,
                    "signer": event.predecessor_id,
                    "block_height": event.block_height,
                    "block_timestamp_ms": event.block_timestamp_ms,
                    "receipt_id": event.receipt_id,
                    "pixels": out.pixels.iter().map(|p| serde_json::json!({
                        "x": p.x,
                        "y": p.y,
                        "color": p.color,
                        "rgb": format!("{:02X}{:02X}{:02X}", p.rgb.0, p.rgb.1, p.rgb.2),
                        "owner_id": p.owner_id,
                        "account_id": names.get(&p.owner_id),
                        "previous_owner_id": p.previous_owner_id,
                        "previous_account_id": names.get(&p.previous_owner_id),
                        "free": p.free,
                        "credits": p.credits,
                        "written_at_ns": p.written_at_ns,
                    })).collect::<Vec<_>>(),
                })
            })
        }
        BoardEvent::BoardExpanded { from, to } => {
            if *from != state.side {
                skipped.push(format!(
                    "board_expanded from {from}, but the mirror's side is {}",
                    state.side
                ));
            }
            next.side = *to;
            Some(serde_json::json!({
                "type": "board_expanded",
                "from": from,
                "to": to,
                "block_height": event.block_height,
                "block_timestamp_ms": event.block_timestamp_ms,
                "receipt_id": event.receipt_id,
            }))
        }
        BoardEvent::StateMigrated { from, to } => {
            tracing::info!(
                "state_migrated {from} -> {to} at block {}",
                event.block_height
            );
            None
        }
    };

    pipe.set(keys::REGION_KEY, next.blob.as_slice()).ignore();
    pipe.set(keys::FREE_BITS_KEY, next.free_bits.as_slice())
        .ignore();
    pipe.set(keys::WRITTEN_AT_KEY, next.written_at.as_slice())
        .ignore();
    pipe.set(keys::BOARD_SIDE, next.side).ignore();
    if message.is_some() {
        pipe.hset(
            keys::REGION_META_KEY,
            "last_updated",
            event.block_timestamp_ms,
        )
        .ignore();
        pipe.hset(keys::REGION_META_KEY, "last_block", event.block_height)
            .ignore();
    }
    if let Some(message) = &message {
        // Scored by block time, prefixed by position: a client that asks for everything since a
        // timestamp gets it in applied order even when two draws share a millisecond.
        pipe.zadd(
            keys::DRAW_EVENTS_ZSET,
            common::catchup_member(event.position(), &message.to_string()),
            event.block_timestamp_ms as f64,
        )
        .ignore();
        pipe.zrembyscore(
            keys::DRAW_EVENTS_ZSET,
            0u64,
            event
                .block_timestamp_ms
                .saturating_sub(catchup_retention_ms),
        )
        .ignore();
    }
    pipe.set(keys::LAST_APPLIED_POSITION, event.position())
        .ignore();
    pipe.set(keys::LAST_APPLIED_BLOCK, event.block_height)
        .ignore();

    Ok((
        Applied {
            message,
            state: next,
            skipped,
        },
        pipe,
    ))
}
