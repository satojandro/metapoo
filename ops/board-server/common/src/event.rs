//! What the indexer pulls out of a block, and what it queues for the server.
//!
//! Berry Fast reads the `draw` call's **arguments**. Meta Poo reads the board's `EVENT_JSON` log
//! instead (`contracts/paid-board/src/lib.rs`, `paint()`): our `draw` can be rejected (price rose,
//! not enough credits, paused, bad cell), so the arguments say what was asked and the log says
//! what the contract stored. The indexer only takes a log from a **successful** outcome whose
//! **executor is the board**, because any contract can log text that looks like this event.

use serde::{Deserialize, Serialize};

pub const EVENT_PREFIX: &str = "EVENT_JSON:";
pub const BOARD_STANDARD: &str = "mpoo_board";

/// One entry of a `draw` / `draw_many` event, in the order the contract applied it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrawEntry {
    pub x: u32,
    pub y: u32,
    /// Palette index, as stored on chain.
    pub color: u32,
    /// The painter the contract recorded. Optional so a future event that drops the per-cell
    /// `artist` (traps.md: the 16 KB log budget) still parses; the receipt's predecessor is then
    /// used, which is what the contract records today.
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub written_at_ns: Option<u64>,
    #[serde(default)]
    pub credits: u32,
    /// The entry was a free paint (F1/F2): the tile is held but does not earn.
    #[serde(default)]
    pub free: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BoardEvent {
    /// `draw` or `draw_many`; `method` is the event name.
    Draw {
        method: String,
        entries: Vec<DrawEntry>,
    },
    /// `expand_board`: the side grew; new tiles start blank.
    BoardExpanded { from: u32, to: u32 },
    /// An upgrade's migration. Logged, changes nothing.
    StateMigrated { from: u32, to: u32 },
}

/// A board event with where it happened. This is what sits on the Valkey queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedEvent {
    pub block_height: u64,
    pub block_timestamp_ms: u64,
    /// Position within the block: shard order, then outcome order, then log order.
    pub seq: u32,
    pub receipt_id: String,
    pub predecessor_id: String,
    pub event: BoardEvent,
}

/// Room for a million board events per block, which no block can hold.
pub const SEQ_PER_BLOCK: u64 = 1_000_000;

impl QueuedEvent {
    /// A strictly increasing position across the whole chain. The server stores the last one it
    /// applied in the same transaction as the board write, so a replayed event is skipped.
    pub fn position(&self) -> u64 {
        self.block_height * SEQ_PER_BLOCK + u64::from(self.seq)
    }
}

#[derive(Deserialize)]
struct Envelope {
    standard: String,
    event: String,
    #[serde(default)]
    data: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct FromTo {
    from: u32,
    to: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseOutcome {
    /// Not an `mpoo_board` event (another standard, plain text, or an event we do not mirror).
    Skip,
    Event(BoardEvent),
    /// Claims to be `mpoo_board` but does not parse. Worth a warning: the mirror may diverge.
    Malformed(String),
}

/// Parse one log line from a board receipt.
pub fn parse_log(line: &str) -> ParseOutcome {
    let Some(json) = line.strip_prefix(EVENT_PREFIX) else {
        return ParseOutcome::Skip;
    };
    let envelope: Envelope = match serde_json::from_str(json) {
        Ok(e) => e,
        Err(_) => return ParseOutcome::Skip,
    };
    if envelope.standard != BOARD_STANDARD {
        return ParseOutcome::Skip;
    }
    let malformed =
        |e: serde_json::Error| ParseOutcome::Malformed(format!("{}: {e}", envelope.event));
    match envelope.event.as_str() {
        "draw" | "draw_many" => {
            let entries: Result<Vec<DrawEntry>, _> = envelope
                .data
                .into_iter()
                .map(serde_json::from_value)
                .collect();
            match entries {
                Ok(entries) => ParseOutcome::Event(BoardEvent::Draw {
                    method: envelope.event,
                    entries,
                }),
                Err(e) => malformed(e),
            }
        }
        "board_expanded" | "state_migrated" => {
            let Some(first) = envelope.data.into_iter().next() else {
                return ParseOutcome::Malformed(format!("{}: no data", envelope.event));
            };
            match serde_json::from_value::<FromTo>(first) {
                Ok(FromTo { from, to }) if envelope.event == "board_expanded" => {
                    ParseOutcome::Event(BoardEvent::BoardExpanded { from, to })
                }
                Ok(FromTo { from, to }) => {
                    ParseOutcome::Event(BoardEvent::StateMigrated { from, to })
                }
                Err(e) => malformed(e),
            }
        }
        _ => ParseOutcome::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape `paint()` logs (lib.rs), two entries for the same tile.
    const DRAW_MANY: &str = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"draw_many","data":[{"x":3,"y":4,"color":2,"artist":"alice.near","written_at_ns":1793851557646142246,"credits":0,"free":true},{"x":3,"y":4,"color":5,"artist":"alice.near","written_at_ns":1793851557646142246,"credits":2,"free":false}]}"#;

    #[test]
    fn parses_a_draw_many_in_applied_order() {
        let ParseOutcome::Event(BoardEvent::Draw { method, entries }) = parse_log(DRAW_MANY) else {
            panic!("expected a draw event");
        };
        assert_eq!(method, "draw_many");
        assert_eq!(entries.len(), 2);
        assert_eq!((entries[0].color, entries[0].free), (2, true));
        assert_eq!(
            (entries[1].color, entries[1].credits, entries[1].free),
            (5, 2, false)
        );
        assert_eq!(entries[1].artist.as_deref(), Some("alice.near"));
    }

    #[test]
    fn parses_board_expanded_and_state_migrated() {
        let expanded = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"board_expanded","data":[{"from":64,"to":96}]}"#;
        assert_eq!(
            parse_log(expanded),
            ParseOutcome::Event(BoardEvent::BoardExpanded { from: 64, to: 96 })
        );
        let migrated = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"state_migrated","data":[{"from":1,"to":2}]}"#;
        assert_eq!(
            parse_log(migrated),
            ParseOutcome::Event(BoardEvent::StateMigrated { from: 1, to: 2 })
        );
    }

    #[test]
    fn skips_other_standards_unknown_events_and_plain_logs() {
        let payments = r#"EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"credits_purchased","data":[{}]}"#;
        assert_eq!(parse_log(payments), ParseOutcome::Skip);
        let tunables = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"tunables_changed","data":[{}]}"#;
        assert_eq!(parse_log(tunables), ParseOutcome::Skip);
        assert_eq!(parse_log("plain text"), ParseOutcome::Skip);
    }

    #[test]
    fn a_draw_without_artist_still_parses() {
        let line = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"draw","data":[{"x":1,"y":2,"color":3}]}"#;
        let ParseOutcome::Event(BoardEvent::Draw { entries, .. }) = parse_log(line) else {
            panic!()
        };
        assert_eq!(entries[0].artist, None);
        assert!(!entries[0].free);
    }

    #[test]
    fn a_broken_board_draw_is_malformed_not_skipped() {
        let line = r#"EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"draw","data":[{"x":"one"}]}"#;
        assert!(matches!(parse_log(line), ParseOutcome::Malformed(_)));
    }

    #[test]
    fn position_orders_by_block_then_seq() {
        let at = |block_height, seq| QueuedEvent {
            block_height,
            block_timestamp_ms: 0,
            seq,
            receipt_id: String::new(),
            predecessor_id: String::new(),
            event: BoardEvent::StateMigrated { from: 1, to: 2 },
        };
        assert!(at(10, 999).position() < at(11, 0).position());
        assert!(at(10, 0).position() < at(10, 1).position());
    }
}
