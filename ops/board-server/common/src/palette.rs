//! The board palette, read at compile time from `shared/board.json`, the same file the web and
//! the contract tests are checked against. A colour index is what the contract stores; the
//! blob carries RGB, as Berry Fast's does, so a renderer never needs the palette.

use std::sync::OnceLock;

const BOARD_JSON: &str = include_str!("../../../../shared/board.json");

fn palette() -> &'static [(u8, u8, u8)] {
    static PALETTE: OnceLock<Vec<(u8, u8, u8)>> = OnceLock::new();
    PALETTE.get_or_init(|| {
        let board: serde_json::Value =
            serde_json::from_str(BOARD_JSON).expect("shared/board.json is valid JSON");
        let entries = board["palette"]
            .as_array()
            .expect("shared/board.json has a palette");
        entries
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                assert_eq!(
                    entry["index"].as_u64(),
                    Some(i as u64),
                    "palette indices are 0..n in order"
                );
                let hex = entry["hex"].as_str().expect("palette hex");
                parse_hex(hex).unwrap_or_else(|| panic!("bad palette hex {hex}"))
            })
            .collect()
    })
}

fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
    let hex = hex.strip_prefix('#').unwrap_or(hex);
    if hex.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((byte(0)?, byte(2)?, byte(4)?))
}

/// RGB for a stored colour index, or `None` for an index the palette does not have.
pub fn rgb(index: u32) -> Option<(u8, u8, u8)> {
    palette().get(index as usize).copied()
}

pub fn len() -> usize {
    palette().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_sixteen_shared_colours() {
        assert_eq!(len(), 16);
        assert_eq!(rgb(0), Some((0x1c, 0x19, 0x17)));
        assert_eq!(rgb(15), Some((0xef, 0x7a, 0x2c)));
        assert_eq!(rgb(16), None);
    }
}
