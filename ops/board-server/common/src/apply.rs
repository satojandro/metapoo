//! Applying a board event to the mirror. Pure: no Valkey, so every rule is unit-tested.
//!
//! Berry Fast's server enforces ownership rules (the 1-hour lock). Ours enforces **none**: the
//! contract already decided, and its event says what it stored. A second copy of the rules could
//! only disagree. What we do copy from the contract is its holder bookkeeping (`paint()`, the
//! `charged` / `deltas` loop), so `pixel_count` and `earning_count` match `get_holder` and
//! `get_earning_cells`:
//!
//! - counts move once per **distinct** tile in a stroke, from whoever held it before the stroke;
//! - the tile's **final** entry decides whether it now earns (a tile earns while its latest paint
//!   was not free);
//! - even a same-artist repaint can move the earning count (free → paid).

use std::collections::HashMap;

use crate::event::DrawEntry;
use crate::palette;
use crate::region::*;

/// The mirrored board: the Berry Fast blob plus the one bit Meta Poo adds per tile.
#[derive(Debug, Clone)]
pub struct BoardState {
    pub blob: Vec<u8>,
    /// Set while the tile's latest paint was free (the contract's `free_cells`).
    pub free_bits: Vec<u8>,
    /// Per tile, the contract's `written_at_ns` of its latest paint (u64 LE, 0 = never).
    /// Not in Berry Fast's blob; the wall prices wet/drying tiles from it.
    pub written_at: Vec<u8>,
    /// Current side. Tiles at or beyond it cannot be painted.
    pub side: u32,
}

/// 128 * 128 * 8 bytes.
pub const WRITTEN_AT_SIZE: usize = (REGION_SIZE as usize) * (REGION_SIZE as usize) * 8;

/// One written tile, as broadcast. `previous_owner_id` is the §4 addition: Berry Fast already
/// reads it to keep its counts right, but does not send it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedPixel {
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub rgb: (u8, u8, u8),
    pub owner_id: u32,
    pub previous_owner_id: u32,
    pub free: bool,
    pub credits: u32,
    pub written_at_ns: Option<u64>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ApplyOutcome {
    pub pixels: Vec<AppliedPixel>,
    /// owner id → change in tiles held.
    pub pixel_delta: HashMap<u32, i64>,
    /// owner id → change in earning tiles held.
    pub earning_delta: HashMap<u32, i64>,
    /// Tiles that went from never painted to painted.
    pub newly_painted: i64,
    /// Entries the mirror could not apply (off the board, unknown colour, unknown artist).
    /// The contract rejects these, so any count above zero means the mirror has diverged.
    pub skipped: Vec<String>,
}

impl BoardState {
    pub fn empty(side: u32) -> Self {
        Self {
            blob: vec![0; REGION_BLOB_SIZE],
            free_bits: vec![0; FREE_BITMAP_SIZE],
            written_at: vec![0; WRITTEN_AT_SIZE],
            side,
        }
    }

    pub fn pixel(&self, x: u32, y: u32) -> Option<Pixel> {
        pixel_offset(x, y).map(|o| Pixel::decode(&self.blob[o..o + PIXEL_SIZE]))
    }

    pub fn written_at_ns(&self, x: u32, y: u32) -> Option<u64> {
        let i = tile_index(x, y)?;
        let ns = u64::from_le_bytes(self.written_at[i * 8..i * 8 + 8].try_into().ok()?);
        (ns != 0).then_some(ns)
    }

    pub fn is_free(&self, x: u32, y: u32) -> bool {
        tile_index(x, y).is_some_and(|i| bit_get(&self.free_bits, i))
    }

    /// Apply one `draw` / `draw_many` event. `owner_ids` must hold an id for every artist in the
    /// entries (and for `fallback_artist`); the caller resolves them first because that needs Valkey.
    pub fn apply_draw(
        &mut self,
        entries: &[DrawEntry],
        fallback_artist: &str,
        owner_ids: &HashMap<String, u32>,
    ) -> ApplyOutcome {
        let mut out = ApplyOutcome::default();
        // Distinct tiles, with who held them and whether they earned before this stroke.
        let mut before: Vec<(usize, u32, bool)> = Vec::new();
        // Distinct tiles and the artist of their final entry.
        let mut final_artist: HashMap<usize, u32> = HashMap::new();

        for entry in entries {
            let artist = entry.artist.as_deref().unwrap_or(fallback_artist);
            let (Some(offset), Some(index)) =
                (pixel_offset(entry.x, entry.y), tile_index(entry.x, entry.y))
            else {
                out.skipped.push(format!(
                    "({}, {}) is off the 128 x 128 region",
                    entry.x, entry.y
                ));
                continue;
            };
            if entry.x >= self.side || entry.y >= self.side {
                out.skipped.push(format!(
                    "({}, {}) is outside the {} x {} board",
                    entry.x, entry.y, self.side, self.side
                ));
                continue;
            }
            let Some(rgb) = palette::rgb(entry.color) else {
                out.skipped
                    .push(format!("colour {} is not in the palette", entry.color));
                continue;
            };
            let Some(&owner_id) = owner_ids.get(artist) else {
                out.skipped.push(format!("no owner id for {artist}"));
                continue;
            };

            let existing = Pixel::decode(&self.blob[offset..offset + PIXEL_SIZE]);
            if !before.iter().any(|(i, ..)| *i == index) {
                let was_earning = !existing.is_empty() && !bit_get(&self.free_bits, index);
                before.push((index, existing.owner_id, was_earning));
            }

            Pixel {
                r: rgb.0,
                g: rgb.1,
                b: rgb.2,
                owner_id,
            }
            .encode(&mut self.blob[offset..offset + PIXEL_SIZE]);
            bit_set(&mut self.free_bits, index, entry.free);
            if let Some(ns) = entry.written_at_ns {
                self.written_at[index * 8..index * 8 + 8].copy_from_slice(&ns.to_le_bytes());
            }
            final_artist.insert(index, owner_id);

            out.pixels.push(AppliedPixel {
                x: entry.x,
                y: entry.y,
                color: entry.color,
                rgb,
                owner_id,
                previous_owner_id: existing.owner_id,
                free: entry.free,
                credits: entry.credits,
                written_at_ns: entry.written_at_ns,
            });
        }

        let add = |map: &mut HashMap<u32, i64>, id: u32, delta: i64| {
            if id != 0 && delta != 0 {
                *map.entry(id).or_insert(0) += delta;
            }
        };
        for (index, previous, was_earning) in before {
            let artist = final_artist[&index];
            let now_earning = !bit_get(&self.free_bits, index);
            let moved = previous != artist;
            if previous == 0 {
                out.newly_painted += 1;
            }
            add(&mut out.pixel_delta, previous, -i64::from(moved));
            add(&mut out.earning_delta, previous, -i64::from(was_earning));
            add(&mut out.pixel_delta, artist, i64::from(moved));
            add(&mut out.earning_delta, artist, i64::from(now_earning));
        }
        out.pixel_delta.retain(|_, d| *d != 0);
        out.earning_delta.retain(|_, d| *d != 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(x: u32, y: u32, color: u32, artist: &str, free: bool) -> DrawEntry {
        DrawEntry {
            x,
            y,
            color,
            artist: Some(artist.into()),
            written_at_ns: Some(1),
            credits: u32::from(!free),
            free,
        }
    }

    fn ids() -> HashMap<String, u32> {
        [("alice".to_string(), 1), ("bob".to_string(), 2)]
            .into_iter()
            .collect()
    }

    #[test]
    fn a_tile_listed_twice_ends_with_the_last_entry_and_counts_once() {
        let mut board = BoardState::empty(64);
        let out = board.apply_draw(
            &[
                entry(3, 4, 2, "alice", true),
                entry(3, 4, 5, "alice", false),
            ],
            "alice",
            &ids(),
        );
        let p = board.pixel(3, 4).unwrap();
        assert_eq!((p.r, p.g, p.b, p.owner_id), (0x2f, 0x6f, 0x8f, 1)); // River, index 5
        assert!(!board.is_free(3, 4));
        assert_eq!(board.written_at_ns(3, 4), Some(1));
        assert_eq!(board.written_at_ns(0, 0), None);
        assert_eq!(out.pixels.len(), 2);
        assert_eq!(out.newly_painted, 1);
        assert_eq!(out.pixel_delta, [(1, 1)].into_iter().collect());
        assert_eq!(out.earning_delta, [(1, 1)].into_iter().collect());
    }

    #[test]
    fn covering_moves_the_tile_and_its_earning_from_the_previous_holder() {
        let mut board = BoardState::empty(64);
        board.apply_draw(&[entry(0, 0, 1, "bob", false)], "bob", &ids());
        let out = board.apply_draw(&[entry(0, 0, 3, "alice", false)], "alice", &ids());
        assert_eq!(out.pixels[0].previous_owner_id, 2);
        assert_eq!(out.newly_painted, 0);
        assert_eq!(out.pixel_delta, [(1, 1), (2, -1)].into_iter().collect());
        assert_eq!(out.earning_delta, [(1, 1), (2, -1)].into_iter().collect());
    }

    #[test]
    fn a_free_paint_holds_the_tile_without_earning() {
        let mut board = BoardState::empty(64);
        let out = board.apply_draw(&[entry(1, 1, 1, "alice", true)], "alice", &ids());
        assert_eq!(out.pixel_delta, [(1, 1)].into_iter().collect());
        assert!(out.earning_delta.is_empty());
        assert!(board.is_free(1, 1));
    }

    #[test]
    fn a_same_artist_paid_repaint_of_a_free_tile_starts_it_earning() {
        let mut board = BoardState::empty(64);
        board.apply_draw(&[entry(1, 1, 1, "alice", true)], "alice", &ids());
        let out = board.apply_draw(&[entry(1, 1, 2, "alice", false)], "alice", &ids());
        assert!(out.pixel_delta.is_empty());
        assert_eq!(out.earning_delta, [(1, 1)].into_iter().collect());
    }

    #[test]
    fn entries_the_contract_would_reject_are_skipped_and_reported() {
        let mut board = BoardState::empty(64);
        let out = board.apply_draw(
            &[
                entry(64, 0, 1, "alice", false),
                entry(0, 0, 99, "alice", false),
                entry(0, 0, 1, "carol", false),
            ],
            "alice",
            &ids(),
        );
        assert!(out.pixels.is_empty());
        assert_eq!(out.skipped.len(), 3);
        assert_eq!(board.blob, vec![0; REGION_BLOB_SIZE]);
    }

    #[test]
    fn a_missing_artist_falls_back_to_the_predecessor() {
        let mut board = BoardState::empty(64);
        let mut e = entry(2, 2, 1, "", false);
        e.artist = None;
        board.apply_draw(&[e], "bob", &ids());
        assert_eq!(board.pixel(2, 2).unwrap().owner_id, 2);
    }

    #[test]
    fn growing_the_side_opens_the_new_tiles() {
        let mut board = BoardState::empty(64);
        assert_eq!(
            board
                .apply_draw(&[entry(100, 100, 1, "alice", false)], "alice", &ids())
                .skipped
                .len(),
            1
        );
        board.side = 128;
        assert!(board
            .apply_draw(&[entry(100, 100, 1, "alice", false)], "alice", &ids())
            .skipped
            .is_empty());
    }
}
