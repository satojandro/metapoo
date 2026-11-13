//! The compact body of `GET /api/history` (TIMELAPSE, return-and-growth spec §4.3).
//!
//! The log's stream entries cost ~150 bytes each as text. A timelapse needs only where, what
//! colour and when, so a page is packed to about **3 bytes a tile**: paints that share a block
//! and a time (one stroke is up to 64 of them) share one header.
//!
//! ```text
//! "MPH1"                     4 bytes
//! flags                      u8      bit 0: the page was full, ask again after `next`
//! rows                       varint  stream rows packed below (tiles + expansions)
//! next_position, next_index  varint  cursor: the last stream row read (0, 0 on an empty page)
//! records …
//!   0x01 paints:    block Δ (varint), at_ms Δ (zigzag varint), n (varint), n × [x, y, colour]
//!   0x02 expansion: block Δ (varint), at_ms Δ (zigzag varint), from (varint), to (varint)
//! ```
//!
//! Deltas are from the previous record in the page; the first record's are from zero, so every
//! page decodes on its own. Varints are unsigned LEB128. Painters and the free bit are left
//! out on purpose: the page does not show them, and an account id per tile would be most of
//! the bytes. A reader must stop at a record tag it does not know (a later `MPH1` may add
//! one); a different layout gets a different magic.
//!
//! The web decoder is `web/src/timelapse/history-wire.ts`; both are pinned to
//! `common/fixtures/history-page.json`.

use crate::history::LogRow;

pub const MAGIC: &[u8; 4] = b"MPH1";
pub const FLAG_MORE: u8 = 1;
pub const TAG_PAINTS: u8 = 1;
pub const TAG_EXPAND: u8 = 2;

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn zigzag(out: &mut Vec<u8>, value: i64) {
    varint(out, ((value << 1) ^ (value >> 63)) as u64);
}

/// Pack `rows` (in stream order). `next` is the cursor of the last stream row read, which may
/// be past the last row packed if that one did not parse.
pub fn encode_page(rows: &[LogRow], next: Option<(u64, u32)>, more: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + rows.len() * 4);
    out.extend_from_slice(MAGIC);
    out.push(if more { FLAG_MORE } else { 0 });
    let header_rows = out.len();
    let mut packed: u64 = 0;
    let mut body = Vec::with_capacity(rows.len() * 4);
    let (mut block, mut at_ms) = (0u64, 0u64);
    let mut i = 0;
    while i < rows.len() {
        let row = &rows[i];
        let head = |body: &mut Vec<u8>, tag: u8, block: &mut u64, at_ms: &mut u64| {
            body.push(tag);
            varint(body, row.block().saturating_sub(*block));
            zigzag(body, row.at_ms() as i64 - *at_ms as i64);
            // A block below the previous one cannot happen (ids are ordered by block); if it
            // did, the delta saturates at 0 and the decoder stays monotonic.
            *block = row.block().max(*block);
            *at_ms = row.at_ms();
        };
        match row {
            LogRow::Expand(e) => {
                head(&mut body, TAG_EXPAND, &mut block, &mut at_ms);
                varint(&mut body, u64::from(e.from));
                varint(&mut body, u64::from(e.to));
                packed += 1;
                i += 1;
            }
            LogRow::Draw(first) => {
                let mut tiles = Vec::new();
                let mut j = i;
                while let Some(LogRow::Draw(e)) = rows.get(j) {
                    if e.block != first.block || e.at_ms != first.at_ms {
                        break;
                    }
                    // Three bytes a tile: anything that does not fit is not a tile of this
                    // wall (128 a side, 16 colours) and is left out rather than truncated.
                    if let (Ok(x), Ok(y), Ok(color)) = (
                        u8::try_from(e.x),
                        u8::try_from(e.y),
                        u8::try_from(e.color),
                    ) {
                        tiles.extend_from_slice(&[x, y, color]);
                    }
                    j += 1;
                }
                if !tiles.is_empty() {
                    head(&mut body, TAG_PAINTS, &mut block, &mut at_ms);
                    varint(&mut body, (tiles.len() / 3) as u64);
                    packed += (tiles.len() / 3) as u64;
                    body.extend_from_slice(&tiles);
                }
                i = j;
            }
        }
    }
    let mut header = Vec::new();
    varint(&mut header, packed);
    let (position, index) = next.unwrap_or((0, 0));
    varint(&mut header, position);
    varint(&mut header, u64::from(index));
    out.splice(header_rows..header_rows, header);
    out.extend_from_slice(&body);
    out
}

/// Lowercase hex, for the fixture.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{Expansion, HistoryEntry};

    const FIXTURE: &str = include_str!("../fixtures/history-page.json");

    fn rows_of(fixture: &serde_json::Value) -> Vec<LogRow> {
        let n = |v: &serde_json::Value, k: &str| v[k].as_u64().unwrap();
        fixture["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let id = r["id"].as_str().unwrap();
                let (position, index) = crate::history::parse_stream_id(id).unwrap();
                if r["kind"] == "expand" {
                    LogRow::Expand(Expansion {
                        position,
                        block: n(r, "block"),
                        at_ms: n(r, "at_ms"),
                        from: n(r, "from") as u32,
                        to: n(r, "to") as u32,
                    })
                } else {
                    LogRow::Draw(HistoryEntry {
                        position,
                        index,
                        block: n(r, "block"),
                        at_ms: n(r, "at_ms"),
                        x: n(r, "x") as u32,
                        y: n(r, "y") as u32,
                        color: n(r, "color") as u32,
                        by: r["by"].as_str().unwrap().into(),
                        free: r["free"].as_bool().unwrap(),
                    })
                }
            })
            .collect()
    }

    /// The same file the web decoder's test reads. Regenerate the hex only on purpose:
    /// `UPDATE_HISTORY_FIXTURE=1 cargo test -p common the_encoder_matches`.
    #[test]
    fn the_encoder_matches_the_fixture_the_web_decoder_is_tested_against() {
        let mut fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let rows = rows_of(&fixture);
        let (position, index) = rows.last().unwrap().key();
        let hex = to_hex(&encode_page(&rows, Some((position, index)), true));
        if std::env::var("UPDATE_HISTORY_FIXTURE").is_ok() {
            fixture["hex"] = hex.clone().into();
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/history-page.json");
            std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
        }
        assert_eq!(fixture["hex"].as_str().unwrap(), hex);
    }

    #[test]
    fn a_stroke_costs_three_bytes_a_tile_plus_one_small_header() {
        let stroke: Vec<LogRow> = (0..64)
            .map(|i| {
                LogRow::Draw(HistoryEntry {
                    position: 223_113_576_000_002,
                    index: i,
                    block: 223_113_576,
                    at_ms: 1_762_000_000_123,
                    x: i,
                    y: 7,
                    color: 3,
                    by: "a-sixty-four-character-implicit-account-would-go-here.near".into(),
                    free: false,
                })
            })
            .collect();
        let one = encode_page(&stroke, Some((223_113_576_000_002, 63)), false);
        // magic 4 + flags 1 + rows 1 + cursor 7 + 1, then tag 1 + block 4 + time 6 + n 1.
        assert_eq!(one.len(), 14 + 12 + 64 * 3);
        // A second stroke 40 blocks and 24 s later: its header is 6 bytes.
        let mut two = stroke.clone();
        two.extend(stroke.iter().map(|r| {
            let LogRow::Draw(e) = r else { unreachable!() };
            LogRow::Draw(HistoryEntry {
                position: e.position + 40_000_000,
                block: e.block + 40,
                at_ms: e.at_ms + 24_000,
                ..e.clone()
            })
        }));
        let both = encode_page(&two, Some((223_113_616_000_002, 63)), false);
        assert_eq!(both.len(), one.len() + 1 + 1 + 3 + 1 + 64 * 3);
        assert_eq!(&both[..4], MAGIC);
    }

    #[test]
    fn an_empty_page_is_a_header_and_time_may_step_backwards() {
        assert_eq!(encode_page(&[], None, false), b"MPH1\x00\x00\x00\x00");
        let mut out = Vec::new();
        zigzag(&mut out, -1);
        zigzag(&mut out, 1);
        assert_eq!(out, [1, 2]);
        let mut big = Vec::new();
        varint(&mut big, 300);
        assert_eq!(big, [0xac, 0x02]);
    }
}
