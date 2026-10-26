//! Meta Poo pixel board contract (Open wall).
//!
//! A smart contract is a program that a blockchain runs. People call its
//! change methods with signed transactions. This crate:
//! - describes a 128 by 128 board and an 8-color palette
//! - stores only painted cells (sparse storage)
//! - lets any caller paint any in-range cell (Open wall)
//! - pages every currently painted cell for readers (`get_pixels`)
//!
//! `shared/board.json` must stay in sync with the constants below.
//! Do not deploy until an explicit review. Local `cargo test` is not a
//! testnet or mainnet result.

use near_sdk::store::IterableMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

/// Board width in pixels. Coordinate x must be 0 through 127.
const WIDTH: u32 = 128;
/// Board height in pixels. Coordinate y must be 0 through 127.
const HEIGHT: u32 = 128;
/// (0, 0) is the top-left square. x grows to the right. y grows downward.
const ORIGIN: &str = "top-left";
/// Accepted product rule: any account may paint any cell.
const OVERWRITE_RULE: &str = "open_wall";
/// Schema 2 adds iterable sparse storage and paginated `get_pixels`.
const SCHEMA_VERSION: u32 = 2;
/// Hard cap so one view call cannot try to return the whole wall at once.
const MAX_PIXELS_PAGE: u32 = 256;
/// Hard cap on cells in one `draw_many` call.
///
/// A stroke is a short drag, not a whole canvas. Keeping the call bounded keeps
/// the transaction under the network gas limit and makes the stroke atomic: one
/// transaction stores every cell of the stroke, or none of them.
const MAX_DRAW_BATCH: u32 = 64;

/// One cell inside a batched stroke.
///
/// `draw_many` takes a list of these so a drag costs one wallet approval
/// instead of one approval per pixel, which is the difference between a paint
/// moment and a signing chore.
#[near(serializers = [json, borsh])]
pub struct DrawCell {
    pub x: u32,
    pub y: u32,
    pub color: u32,
}

/// Index 0 is Ink, a real paint color. An unpainted square is not index 0.
/// Names and hex values match `shared/palette.ts`. Change both together.
const PALETTE: [(&str, &str); 8] = [
    ("Ink", "#1c1917"),
    ("Paper", "#f4efe4"),
    ("Brick", "#b23a2f"),
    ("Marigold", "#e0a100"),
    ("Moss", "#3d7a4a"),
    ("River", "#2f6f8f"),
    ("Grape", "#6b4c7a"),
    ("Clay", "#c47b5a"),
];

/// One named paint color returned to the page.
#[near(serializers = [json])]
pub struct PaletteColor {
    pub index: u32,
    pub name: String,
    pub hex: String,
}

/// What `get_board` returns. Field names stay snake_case, matching NEAR's usual JSON.
#[near(serializers = [json])]
pub struct BoardView {
    pub schema_version: u32,
    pub width: u32,
    pub height: u32,
    pub origin: String,
    pub overwrite_rule: String,
    /// Always false here. Sponsorship is a later, separate service.
    pub sponsorship_enabled: bool,
    pub palette: Vec<PaletteColor>,
}

/// What `get_pixel` returns. Null fields mean "nothing has been stored".
#[near(serializers = [json])]
pub struct PixelView {
    pub x: u32,
    pub y: u32,
    pub color: Option<u32>,
    /// Attribution only. Open wall does not treat artist as an access right.
    pub artist: Option<String>,
    /// Nanoseconds, the unit NEAR uses for block time.
    pub written_at_ns: Option<u64>,
}

/// One currently painted cell. Only cells with a stored record appear here.
/// After an overwrite, this is the latest color and artist (still one entry).
#[near(serializers = [json])]
pub struct PaintedPixelView {
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub artist: String,
    pub written_at_ns: u64,
}

/// One page of painted pixels from `get_pixels`.
#[near(serializers = [json])]
pub struct PixelsPage {
    pub pixels: Vec<PaintedPixelView>,
    /// Index into the painted-cell list where this page started.
    pub from_index: u32,
    /// Limit after clamping to `MAX_PIXELS_PAGE`.
    pub limit: u32,
    /// How many painted cells exist right now (not board width×height).
    pub total: u32,
    /// Next `from_index` to request, or `None` when this page finished the list.
    pub next_from_index: Option<u32>,
}

/// One painted cell in contract storage.
#[near(serializers = [borsh])]
pub struct PixelRecord {
    color: u32,
    artist: AccountId,
    written_at_ns: u64,
}

/// On-chain state. NEAR saves this between calls.
///
/// Empty pixels are not saved one by one. Saving all 16,384 squares up front
/// would spend storage before anyone paints.
///
/// `IterableMap` (not `LookupMap`) keeps keys so `get_pixels` can walk every
/// painted cell exactly once.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    schema_version: u32,
    /// Key is `y * WIDTH + x`. Only painted cells appear here.
    pixels: IterableMap<u32, PixelRecord>,
}

#[near]
impl Board {
    /// Create an empty board. Call this once when the contract account is initialized.
    #[init]
    pub fn new() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            pixels: IterableMap::new(b"p"),
        }
    }

    /// Read the board description. A view method does not change state.
    pub fn get_board(&self) -> BoardView {
        BoardView {
            schema_version: self.schema_version,
            width: WIDTH,
            height: HEIGHT,
            origin: ORIGIN.to_string(),
            overwrite_rule: OVERWRITE_RULE.to_string(),
            sponsorship_enabled: false,
            palette: PALETTE
                .iter()
                .enumerate()
                .map(|(index, (name, hex))| PaletteColor {
                    index: index as u32,
                    name: (*name).to_string(),
                    hex: (*hex).to_string(),
                })
                .collect(),
        }
    }

    /// Read one square. Missing storage means the square is unpainted.
    pub fn get_pixel(&self, x: u32, y: u32) -> PixelView {
        if let Err(code) = check_coordinate(x, y) {
            reject(code);
        }
        match self.pixels.get(&pixel_key(x, y)) {
            Some(record) => PixelView {
                x,
                y,
                color: Some(record.color),
                artist: Some(record.artist.to_string()),
                written_at_ns: Some(record.written_at_ns),
            },
            None => PixelView {
                x,
                y,
                color: None,
                artist: None,
                written_at_ns: None,
            },
        }
    }

    /// Page through every currently painted cell exactly once.
    ///
    /// Overwrites replace the same map entry, so a cell never appears twice
    /// and the listed color/artist are always the latest successful write.
    /// Unpainted cells are omitted (they have no storage record).
    ///
    /// Call again with `next_from_index` until it is `null`.
    pub fn get_pixels(&self, from_index: u32, limit: u32) -> PixelsPage {
        let total = self.pixels.len() as u32;
        let limit = limit.min(MAX_PIXELS_PAGE);

        let mut pixels = Vec::new();
        for (key, record) in self
            .pixels
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
        {
            let key = *key;
            let x = key % WIDTH;
            let y = key / WIDTH;
            pixels.push(PaintedPixelView {
                x,
                y,
                color: record.color,
                artist: record.artist.to_string(),
                written_at_ns: record.written_at_ns,
            });
        }

        let consumed = from_index.saturating_add(pixels.len() as u32);
        let next_from_index = if consumed < total {
            Some(consumed)
        } else {
            None
        };

        PixelsPage {
            pixels,
            from_index,
            limit,
            total,
            next_from_index,
        }
    }

    /// Paint one cell. Any predecessor may overwrite any cell (Open wall).
    ///
    /// On NEAR, a panic cancels the whole transaction. A successful return
    /// means the cell was stored for this call.
    pub fn draw(&mut self, x: u32, y: u32, color: u32) {
        if let Err(code) = validate_draw_args(x, y, color) {
            reject(code);
        }

        let artist = env::predecessor_account_id();
        let written_at_ns = env::block_timestamp();
        let key = pixel_key(x, y);
        self.pixels.insert(
            key,
            PixelRecord {
                color,
                artist: artist.clone(),
                written_at_ns,
            },
        );

        // Simple log for indexers / debugging. Not a full NEP event schema yet.
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"1.0.0\",\"event\":\"draw\",\"data\":[{{\"x\":{x},\"y\":{y},\"color\":{color},\"artist\":\"{artist}\",\"written_at_ns\":{written_at_ns}}}]}}"
        ));
    }

    /// Paint many cells in one transaction, so a drag is one wallet approval.
    ///
    /// All-or-nothing: if any cell is out of range or has an unknown color the
    /// whole call panics and nothing is stored, so a painter can never end up
    /// with half a stroke on the wall and half rejected. Cells apply in order;
    /// if the same cell appears twice, the last entry wins.
    ///
    /// The stroke is capped at `MAX_DRAW_BATCH` cells. Longer drags are
    /// split by the client into several calls, each of which is still atomic.
    pub fn draw_many(&mut self, cells: Vec<DrawCell>) {
        if cells.is_empty() {
            reject("EmptyStroke");
        }
        if cells.len() as u32 > MAX_DRAW_BATCH {
            reject("StrokeTooLarge");
        }
        for cell in cells.iter() {
            if let Err(code) = validate_draw_args(cell.x, cell.y, cell.color) {
                reject(code);
            }
        }

        let artist = env::predecessor_account_id();
        let written_at_ns = env::block_timestamp();
        let mut events: Vec<String> = Vec::with_capacity(cells.len());

        for cell in cells.iter() {
            self.pixels.insert(
                pixel_key(cell.x, cell.y),
                PixelRecord {
                    color: cell.color,
                    artist: artist.clone(),
                    written_at_ns,
                },
            );
            events.push(format!(
                "{{\"x\":{},\"y\":{},\"color\":{},\"artist\":\"{artist}\",\"written_at_ns\":{written_at_ns}}}",
                cell.x, cell.y, cell.color
            ));
        }

        // One event per stroke keeps an indexer's work proportional to drags,
        // not to pixels.
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"1.0.0\",\"event\":\"draw_many\",\"data\":[{}]}}",
            events.join(",")
        ));
    }
}

fn pixel_key(x: u32, y: u32) -> u32 {
    y * WIDTH + x
}

fn validate_draw_args(x: u32, y: u32, color: u32) -> Result<(), &'static str> {
    check_coordinate(x, y)?;
    if color >= PALETTE.len() as u32 {
        return Err("ColorOutOfRange");
    }
    Ok(())
}

fn check_coordinate(x: u32, y: u32) -> Result<(), &'static str> {
    if x >= WIDTH || y >= HEIGHT {
        return Err("CoordinateOutOfRange");
    }
    Ok(())
}

/// Stop the call with a stable code first, then a short explanation.
fn reject(code: &str) -> ! {
    env::panic_str(&format!(
        "{code}: draw was rejected and no pixel was stored"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId};
    use std::collections::HashSet;

    fn context(predecessor: AccountId, block_timestamp: u64) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .block_timestamp(block_timestamp)
            .build();
        testing_env!(context);
    }

    fn setup() -> Board {
        context(accounts(0), 1_000);
        Board::new()
    }

    #[test]
    fn board_view_matches_the_shared_description() {
        let board = setup();
        let view = board.get_board();
        assert_eq!(view.schema_version, 2);
        assert_eq!(view.width, 128);
        assert_eq!(view.height, 128);
        assert_eq!(view.origin, "top-left");
        assert_eq!(view.overwrite_rule, "open_wall");
        assert!(!view.sponsorship_enabled);
        assert_eq!(view.palette.len(), 8);
        assert_eq!(view.palette[0].name, "Ink");
    }

    #[test]
    fn shared_json_matches_contract_constants() {
        let raw = include_str!("../../../shared/board.json");
        let shared: serde_json::Value = serde_json::from_str(raw).expect("shared board json");
        assert_eq!(shared["width"], serde_json::json!(WIDTH));
        assert_eq!(shared["height"], serde_json::json!(HEIGHT));
        assert_eq!(shared["origin"], ORIGIN);
        assert_eq!(shared["overwrite_rule"], OVERWRITE_RULE);
        assert_eq!(shared["sponsorship_enabled"], false);
        assert_eq!(shared["schema_version"], SCHEMA_VERSION);
        let palette = shared["palette"].as_array().expect("palette array");
        assert_eq!(palette.len(), PALETTE.len());
        for (entry, (name, hex)) in palette.iter().zip(PALETTE) {
            assert_eq!(entry["name"], *name);
            assert_eq!(entry["hex"], *hex);
        }
    }

    #[test]
    fn in_range_pixel_starts_empty() {
        let board = setup();
        let pixel = board.get_pixel(0, 0);
        assert!(pixel.color.is_none());
        assert!(pixel.artist.is_none());
        assert!(pixel.written_at_ns.is_none());
        let corner = board.get_pixel(127, 127);
        assert!(corner.color.is_none());
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn pixel_outside_the_board_is_rejected() {
        let board = setup();
        let _ = board.get_pixel(128, 0);
    }

    #[test]
    #[should_panic(expected = "ColorOutOfRange")]
    fn invalid_color_is_named() {
        let mut board = setup();
        board.draw(1, 1, 8);
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn draw_outside_the_board_is_rejected() {
        let mut board = setup();
        board.draw(128, 0, 0);
    }

    #[test]
    fn first_paint_stores_color_artist_and_time() {
        let mut board = setup();
        board.draw(3, 4, 2);
        let pixel = board.get_pixel(3, 4);
        assert_eq!(pixel.color, Some(2));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
        assert_eq!(pixel.written_at_ns, Some(1_000));
    }

    #[test]
    fn another_account_may_overwrite_under_open_wall() {
        let mut board = setup();
        board.draw(3, 4, 2);

        context(accounts(1), 2_000);
        board.draw(3, 4, 5);

        let pixel = board.get_pixel(3, 4);
        assert_eq!(pixel.color, Some(5));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(1).as_str()));
        assert_eq!(pixel.written_at_ns, Some(2_000));
    }

    #[test]
    fn same_account_may_recolor() {
        let mut board = setup();
        board.draw(0, 0, 1);
        context(accounts(0), 3_000);
        board.draw(0, 0, 7);
        let pixel = board.get_pixel(0, 0);
        assert_eq!(pixel.color, Some(7));
        assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
        assert_eq!(pixel.written_at_ns, Some(3_000));
    }

    #[test]
    fn painting_one_cell_does_not_create_neighbors() {
        let mut board = setup();
        board.draw(10, 10, 3);
        assert!(board.get_pixel(10, 11).color.is_none());
        assert!(board.get_pixel(11, 10).color.is_none());
    }

    #[test]
    fn get_pixels_is_empty_on_a_fresh_board() {
        let board = setup();
        let page = board.get_pixels(0, 10);
        assert_eq!(page.total, 0);
        assert!(page.pixels.is_empty());
        assert!(page.next_from_index.is_none());
    }

    #[test]
    fn get_pixels_returns_each_painted_cell_exactly_once_after_overwrite() {
        let mut board = setup();
        board.draw(3, 4, 2);
        board.draw(5, 6, 1);
        context(accounts(1), 2_000);
        board.draw(3, 4, 5);

        let page = board.get_pixels(0, 256);
        assert_eq!(page.total, 2);
        assert_eq!(page.pixels.len(), 2);
        assert!(page.next_from_index.is_none());

        let keys: HashSet<(u32, u32)> = page.pixels.iter().map(|p| (p.x, p.y)).collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&(3, 4)));
        assert!(keys.contains(&(5, 6)));

        let overwritten = page
            .pixels
            .iter()
            .find(|p| p.x == 3 && p.y == 4)
            .expect("overwritten cell");
        assert_eq!(overwritten.color, 5);
        assert_eq!(overwritten.artist, accounts(1).as_str());
        assert_eq!(overwritten.written_at_ns, 2_000);
    }

    #[test]
    fn get_pixels_pages_without_duplicates_across_pages() {
        let mut board = setup();
        for i in 0..5 {
            board.draw(i, 0, 2);
        }

        let first = board.get_pixels(0, 2);
        assert_eq!(first.pixels.len(), 2);
        assert_eq!(first.total, 5);
        assert_eq!(first.next_from_index, Some(2));

        let second = board.get_pixels(first.next_from_index.unwrap(), 2);
        assert_eq!(second.pixels.len(), 2);
        assert_eq!(second.next_from_index, Some(4));

        let third = board.get_pixels(second.next_from_index.unwrap(), 2);
        assert_eq!(third.pixels.len(), 1);
        assert!(third.next_from_index.is_none());

        let mut seen = HashSet::new();
        for page in [&first, &second, &third] {
            for pixel in &page.pixels {
                assert!(
                    seen.insert((pixel.x, pixel.y)),
                    "duplicate cell in paging"
                );
            }
        }
        assert_eq!(seen.len(), 5);
    }

    #[test]
    fn second_client_sees_pixel_painted_by_first_via_get_pixels() {
        // Client A (accounts(0)) paints.
        let mut board = setup();
        board.draw(3, 4, 2);

        // Client B is a different account that only reads. Open wall does not
        // require B to have painted; the wall is shared state.
        context(accounts(1), 2_000);
        let page = board.get_pixels(0, 10);
        assert_eq!(page.total, 1);
        assert_eq!(page.pixels.len(), 1);
        assert_eq!(page.pixels[0].x, 3);
        assert_eq!(page.pixels[0].y, 4);
        assert_eq!(page.pixels[0].color, 2);
        assert_eq!(page.pixels[0].artist, accounts(0).as_str());

        let single = board.get_pixel(3, 4);
        assert_eq!(single.color, Some(2));
        assert_eq!(single.artist.as_deref(), Some(accounts(0).as_str()));
    }

    #[test]
    fn get_pixels_clamps_limit_to_max_page() {
        let mut board = setup();
        board.draw(0, 0, 1);
        let page = board.get_pixels(0, 10_000);
        assert_eq!(page.limit, MAX_PIXELS_PAGE);
        assert_eq!(page.pixels.len(), 1);
    }

    fn stroke(cells: &[(u32, u32, u32)]) -> Vec<DrawCell> {
        cells
            .iter()
            .map(|(x, y, color)| DrawCell {
                x: *x,
                y: *y,
                color: *color,
            })
            .collect()
    }

    #[test]
    fn a_stroke_stores_every_cell_with_one_artist_and_one_timestamp() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (2, 1, 2), (3, 1, 3)]));

        for (x, y, color) in [(1, 1, 2), (2, 1, 2), (3, 1, 3)] {
            let pixel = board.get_pixel(x, y);
            assert_eq!(pixel.color, Some(color), "cell {x},{y} color");
            assert_eq!(pixel.artist.as_deref(), Some(accounts(0).as_str()));
            assert_eq!(pixel.written_at_ns, Some(1_000));
        }

        // One stroke, three cells, one page entry each.
        let page = board.get_pixels(0, 256);
        assert_eq!(page.total, 3);
        assert_eq!(page.pixels.len(), 3);
    }

    #[test]
    fn a_stroke_is_one_wallet_action_even_for_a_long_drag() {
        let mut board = setup();
        let cells: Vec<(u32, u32, u32)> = (0..MAX_DRAW_BATCH).map(|i| (i, 7, 4)).collect();
        board.draw_many(stroke(&cells));
        assert_eq!(board.get_pixels(0, 256).total, MAX_DRAW_BATCH);
    }

    #[test]
    fn repeated_cell_inside_one_stroke_keeps_the_last_color() {
        let mut board = setup();
        board.draw_many(stroke(&[(5, 5, 2), (5, 5, 6)]));
        assert_eq!(board.get_pixel(5, 5).color, Some(6));
        assert_eq!(board.get_pixels(0, 256).total, 1);
    }

    #[test]
    #[should_panic(expected = "EmptyStroke")]
    fn an_empty_stroke_is_rejected() {
        let mut board = setup();
        board.draw_many(Vec::new());
    }

    #[test]
    #[should_panic(expected = "StrokeTooLarge")]
    fn a_stroke_over_the_cap_is_rejected() {
        let mut board = setup();
        let cells: Vec<(u32, u32, u32)> = (0..=MAX_DRAW_BATCH).map(|i| (i, 0, 1)).collect();
        board.draw_many(stroke(&cells));
    }

    #[test]
    #[should_panic(expected = "CoordinateOutOfRange")]
    fn one_bad_cell_rejects_the_whole_stroke() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (128, 1, 2)]));
    }

    #[test]
    #[should_panic(expected = "ColorOutOfRange")]
    fn one_unknown_color_rejects_the_whole_stroke() {
        let mut board = setup();
        board.draw_many(stroke(&[(1, 1, 2), (1, 2, 99)]));
    }

    #[test]
    fn draw_and_draw_many_share_the_same_cell_space() {
        let mut board = setup();
        board.draw(9, 9, 1);
        board.draw_many(stroke(&[(9, 9, 5), (10, 9, 5)]));
        assert_eq!(board.get_pixel(9, 9).color, Some(5));
        assert_eq!(board.get_pixels(0, 256).total, 2);
    }
}
