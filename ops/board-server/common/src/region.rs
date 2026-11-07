//! Board storage, as Berry Fast stores a region: one binary blob, 6 bytes a pixel.
//!
//! Meta Poo has exactly one region, `(0,0)`: the contract's `MAX_SIDE` is 128, the same as
//! Berry Fast's region size, so the whole wall (any side up to 128) is one 98,304-byte blob.
//! Pixel `(x, y)` lives at byte `(y * 128 + x) * 6`: RGB, then the owner id as u24 little-endian.
//! Owner id 0 means the tile was never painted.

/// Region size in pixels. Equal to the paid board's `MAX_SIDE`.
pub const REGION_SIZE: u32 = 128;

/// Per-pixel size: 3 bytes RGB + 3 bytes owner id (u24 LE).
pub const PIXEL_SIZE: usize = 6;

/// 128 * 128 * 6 = 98,304 bytes.
pub const REGION_BLOB_SIZE: usize = (REGION_SIZE as usize) * (REGION_SIZE as usize) * PIXEL_SIZE;

/// Largest owner id the u24 field can carry.
pub const MAX_OWNER_ID: u32 = 0x00FF_FFFF;

/// One stored pixel. `owner_id == 0` means undrawn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pixel {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub owner_id: u32,
}

impl Pixel {
    pub fn encode(&self, buf: &mut [u8]) {
        let ob = self.owner_id.to_le_bytes();
        buf[..PIXEL_SIZE].copy_from_slice(&[self.r, self.g, self.b, ob[0], ob[1], ob[2]]);
    }

    pub fn decode(buf: &[u8]) -> Self {
        Self {
            r: buf[0],
            g: buf[1],
            b: buf[2],
            owner_id: u32::from_le_bytes([buf[3], buf[4], buf[5], 0]),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.owner_id == 0
    }
}

/// Byte offset of `(x, y)` in the blob, or `None` outside the 128 × 128 region.
pub fn pixel_offset(x: u32, y: u32) -> Option<usize> {
    if x >= REGION_SIZE || y >= REGION_SIZE {
        return None;
    }
    Some((y as usize * REGION_SIZE as usize + x as usize) * PIXEL_SIZE)
}

/// Bit index of `(x, y)` in the earning bitmap (one bit per tile, same order as the blob).
pub fn tile_index(x: u32, y: u32) -> Option<usize> {
    pixel_offset(x, y).map(|o| o / PIXEL_SIZE)
}

/// One bit per tile: set while the tile's latest paint was free (the contract's `free_cells`).
pub const FREE_BITMAP_SIZE: usize = (REGION_SIZE as usize * REGION_SIZE as usize) / 8;

pub fn bit_get(bits: &[u8], index: usize) -> bool {
    bits[index / 8] & (1 << (index % 8)) != 0
}

pub fn bit_set(bits: &mut [u8], index: usize, value: bool) {
    if value {
        bits[index / 8] |= 1 << (index % 8);
    } else {
        bits[index / 8] &= !(1 << (index % 8));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_is_berry_fast_size() {
        assert_eq!(REGION_BLOB_SIZE, 98_304);
    }

    #[test]
    fn pixel_round_trips_with_a_u24_owner() {
        let p = Pixel {
            r: 1,
            g: 2,
            b: 3,
            owner_id: 0x00AB_CDEF,
        };
        let mut buf = [0u8; PIXEL_SIZE];
        p.encode(&mut buf);
        assert_eq!(buf, [1, 2, 3, 0xEF, 0xCD, 0xAB]);
        assert_eq!(Pixel::decode(&buf), p);
    }

    #[test]
    fn offsets_follow_row_major_order_and_reject_off_board() {
        assert_eq!(pixel_offset(0, 0), Some(0));
        assert_eq!(pixel_offset(1, 0), Some(6));
        assert_eq!(pixel_offset(0, 1), Some(128 * 6));
        assert_eq!(pixel_offset(127, 127), Some(REGION_BLOB_SIZE - 6));
        assert_eq!(pixel_offset(128, 0), None);
        assert_eq!(pixel_offset(0, 128), None);
    }
}
