//! Legacy schema-2 free board — tests only.
//!
//! Paid schema 3 is the contract init path. Free `draw(x,y,color)` must not
//! remain callable on a paid deployment. This module preserves the old Open
//! wall behavior for regression tests without exporting a second WASM ABI.

#![cfg(test)]

use near_sdk::{env, AccountId};
use std::collections::HashMap;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
const ORIGIN: &str = "top-left";
const OVERWRITE_RULE: &str = "open_wall";
const SCHEMA_VERSION: u32 = 2;
const MAX_PIXELS_PAGE: u32 = 256;

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

pub struct PaletteColor {
    pub index: u32,
    pub name: String,
    pub hex: String,
}

pub struct BoardView {
    pub schema_version: u32,
    pub width: u32,
    pub height: u32,
    pub origin: String,
    pub overwrite_rule: String,
    pub sponsorship_enabled: bool,
    pub palette: Vec<PaletteColor>,
}

pub struct PixelView {
    pub x: u32,
    pub y: u32,
    pub color: Option<u32>,
    pub artist: Option<String>,
    pub written_at_ns: Option<u64>,
}

pub struct PaintedPixelView {
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub artist: String,
    pub written_at_ns: u64,
}

pub struct PixelsPage {
    pub pixels: Vec<PaintedPixelView>,
    pub from_index: u32,
    pub limit: u32,
    pub total: u32,
    pub next_from_index: Option<u32>,
}

struct PixelRecord {
    color: u32,
    artist: AccountId,
    written_at_ns: u64,
}

/// Schema-2 free board used only in unit tests (not the WASM contract state).
pub struct LegacyFreeBoard {
    schema_version: u32,
    /// Plain map so we do not register a second `#[near(contract_state)]`.
    pixels: HashMap<u32, PixelRecord>,
    /// Insertion order for paging (overwrite keeps first-seen key position).
    order: Vec<u32>,
}

impl LegacyFreeBoard {
    pub fn new() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            pixels: HashMap::new(),
            order: Vec::new(),
        }
    }

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

    pub fn get_pixels(&self, from_index: u32, limit: u32) -> PixelsPage {
        let total = self.order.len() as u32;
        let limit = limit.min(MAX_PIXELS_PAGE);

        let mut pixels = Vec::new();
        for key in self
            .order
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
        {
            let key = *key;
            let record = self.pixels.get(&key).expect("order key missing pixel");
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

    /// Free schema draw — any predecessor may overwrite (Open wall).
    pub fn draw(&mut self, x: u32, y: u32, color: u32) {
        if let Err(code) = validate_draw_args(x, y, color) {
            reject(code);
        }

        let artist = env::predecessor_account_id();
        let written_at_ns = env::block_timestamp();
        let key = pixel_key(x, y);
        let is_new = !self.pixels.contains_key(&key);
        self.pixels.insert(
            key,
            PixelRecord {
                color,
                artist: artist.clone(),
                written_at_ns,
            },
        );
        if is_new {
            self.order.push(key);
        }

        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"mpoo_board\",\"version\":\"1.0.0\",\"event\":\"draw\",\"data\":[{{\"x\":{x},\"y\":{y},\"color\":{color},\"artist\":\"{artist}\",\"written_at_ns\":{written_at_ns}}}]}}"
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

fn reject(code: &str) -> ! {
    env::panic_str(&format!(
        "{code}: draw was rejected and no pixel was stored"
    ));
}

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

    fn setup() -> LegacyFreeBoard {
        context(accounts(0), 1_000);
        LegacyFreeBoard::new()
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
    fn shared_json_matches_legacy_constants() {
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
        let mut board = setup();
        board.draw(3, 4, 2);

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
}
