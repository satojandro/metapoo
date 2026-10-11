//! Meta Poo pixel board contract (Open wall).
//!
//! A smart contract is a program that a blockchain runs. People call its
//! change methods with signed transactions. This crate:
//! - describes a 128 by 128 board and an 8-color palette
//! - stores only painted cells (sparse storage)
//! - lets any caller paint any in-range cell (Open wall)
//!
//! `shared/board.json` must stay in sync with the constants below.
//! Do not deploy until an explicit review. Local `cargo test` is not a
//! testnet or mainnet result.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

/// Board width in pixels. Coordinate x must be 0 through 127.
const WIDTH: u32 = 128;
/// Board height in pixels. Coordinate y must be 0 through 127.
const HEIGHT: u32 = 128;
/// (0, 0) is the top-left square. x grows to the right. y grows downward.
const ORIGIN: &str = "top-left";
/// Accepted product rule: any account may paint any cell.
const OVERWRITE_RULE: &str = "open_wall";
/// Schema 1 means Open wall storage is live in this crate.
const SCHEMA_VERSION: u32 = 1;

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
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    schema_version: u32,
    /// Key is `y * WIDTH + x`. Only painted cells appear here.
    pixels: LookupMap<u32, PixelRecord>,
}

#[near]
impl Board {
    /// Create an empty board. Call this once when the contract account is initialized.
    #[init]
    pub fn new() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            pixels: LookupMap::new(b"p"),
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
        assert_eq!(view.schema_version, 1);
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
}
