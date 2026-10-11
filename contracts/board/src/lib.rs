//! Holding contract for the Meta Poo pixel board.
//!
//! A smart contract is a program that a blockchain runs. People call its
//! methods with signed transactions. This build is intentionally incomplete:
//! it can describe the board, and it rejects every draw.
//!
//! Why reject draws? The product owner has not decided who may paint over an
//! existing pixel. Encoding that rule here before the decision would force
//! the frontend to copy a guess. `shared/board.json` is the shared description
//! of size, palette, and the "undecided" marker. A unit test checks that this
//! file and those constants still match.
//!
//! Do not deploy this crate. Schema version 0 means "holding build".

use near_sdk::near;

/// Board width in pixels. Coordinate x must be 0 through 127.
const WIDTH: u32 = 128;
/// Board height in pixels. Coordinate y must be 0 through 127.
const HEIGHT: u32 = 128;
/// (0, 0) is the top-left square. x grows to the right. y grows downward.
const ORIGIN: &str = "top-left";
/// No overwrite policy has been accepted. The page calls this "unresolved".
const OVERWRITE_RULE: &str = "unresolved";

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
    /// 0 means this build only describes the board. It cannot paint.
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
    /// Attribution only. This build does not treat the artist as an access right.
    pub artist: Option<String>,
    /// Nanoseconds, the unit NEAR uses for block time. Unused while draws are rejected.
    pub written_at_ns: Option<u64>,
}

/// On-chain state. NEAR saves this between calls.
///
/// The only field is a version number. Empty pixels are not saved one by one.
/// Saving all 16,384 squares up front would spend storage before anyone paints.
#[near(contract_state)]
#[derive(Default)]
pub struct Board {
    schema_version: u32,
}

#[near]
impl Board {
    /// Read the board description. A view method does not change state and is not a transaction.
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

    /// Read one square. In-range squares are empty because this build stores none.
    pub fn get_pixel(&self, x: u32, y: u32) -> PixelView {
        // Same bound check the draw path uses, so the page and the contract agree.
        if let Err(code) = check_coordinate(x, y) {
            reject(code);
        }
        PixelView {
            x,
            y,
            color: None,
            artist: None,
            written_at_ns: None,
        }
    }

    /// The future painting method. It is a change method (`&mut self`) so a wallet
    /// would submit it as a transaction, but every path panics before writing.
    ///
    /// On NEAR, a panic cancels the whole transaction. State from that call is discarded.
    /// The caller can still pay a little gas. This page does not send the call.
    pub fn draw(&mut self, x: u32, y: u32, color: u32) {
        if let Err(code) = reject_draw(x, y, color) {
            reject(code);
        }
    }
}

/// Pure checks used by the contract method and by unit tests.
/// `Ok(())` would mean "the numbers are legal and a rule allowed the write".
/// This function never returns `Ok`, because no rule has been chosen.
fn reject_draw(x: u32, y: u32, color: u32) -> Result<(), &'static str> {
    check_coordinate(x, y)?;
    if color >= PALETTE.len() as u32 {
        return Err("ColorOutOfRange");
    }
    Err("OverwriteRuleNotChosen")
}

fn check_coordinate(x: u32, y: u32) -> Result<(), &'static str> {
    if x >= WIDTH || y >= HEIGHT {
        return Err("CoordinateOutOfRange");
    }
    Ok(())
}

/// Stop the call with a stable code first, then a short explanation.
fn reject(code: &str) -> ! {
    near_sdk::env::panic_str(&format!(
        "{code}: draw was rejected and no pixel was stored"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn setup() -> Board {
        // Unit tests are not a blockchain. This builds a pretend call environment
        // so `env::panic_str` has somewhere to run.
        let context = VMContextBuilder::new().build();
        testing_env!(context);
        Board::default()
    }

    #[test]
    fn board_view_matches_the_shared_description() {
        let board = setup();
        let view = board.get_board();
        assert_eq!(view.schema_version, 0);
        assert_eq!(view.width, 128);
        assert_eq!(view.height, 128);
        assert_eq!(view.origin, "top-left");
        assert_eq!(view.overwrite_rule, "unresolved");
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
        assert_eq!(shared["schema_version"], 0);
        let palette = shared["palette"].as_array().expect("palette array");
        assert_eq!(palette.len(), PALETTE.len());
        for (entry, (name, hex)) in palette.iter().zip(PALETTE) {
            assert_eq!(entry["name"], *name);
            assert_eq!(entry["hex"], *hex);
        }
    }

    #[test]
    fn in_range_pixel_is_empty() {
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
    fn every_draw_is_rejected_and_ok_is_unreachable() {
        // Includes the last valid square, the first invalid square, and bad colors.
        let samples = [(0, 0, 0), (127, 127, 7), (128, 0, 0), (0, 0, 8)];
        for (x, y, color) in samples {
            assert!(reject_draw(x, y, color).is_err());
        }
    }

    #[test]
    #[should_panic(expected = "ColorOutOfRange")]
    fn invalid_color_is_named() {
        let mut board = setup();
        board.draw(1, 1, 8);
    }

    #[test]
    #[should_panic(expected = "OverwriteRuleNotChosen")]
    fn a_legal_color_still_does_not_draw() {
        let mut board = setup();
        board.draw(3, 4, 2);
    }

    #[test]
    fn a_rejected_draw_leaves_the_pixel_empty() {
        let mut board = setup();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            board.draw(3, 4, 2);
        }));
        assert!(caught.is_err());
        let pixel = board.get_pixel(3, 4);
        assert!(pixel.color.is_none());
        assert!(pixel.artist.is_none());
    }
}
