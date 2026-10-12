//! Canonical history identity encoding — must match `shared/history/encode.ts`.
//! Chain genesis and finalized block hashes are **32 raw bytes**, not
//! length-prefixed UTF-8 strings.

pub const STATE_DOMAIN: &[u8] = b"MPOO_STATE_V1\0";
pub const SNAPSHOT_DOMAIN: &[u8] = b"MPOO_SNAPSHOT_V1\0";
pub const PRINT_DOMAIN: &[u8] = b"MPOO_PRINT_V1\0";

pub fn encode_u16_be(value: u16) -> [u8; 2] {
    value.to_be_bytes()
}

pub fn encode_u32_be(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

pub fn encode_u64_be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

pub fn encode_prefixed_string(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&encode_u32_be(bytes.len() as u32));
    out.extend_from_slice(bytes);
    out
}

pub fn hex_to_bytes32(hex: &str) -> Result<[u8; 32], String> {
    let normalized = hex.strip_prefix("0x").unwrap_or(hex);
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("expected 64 hex chars, got {hex}"));
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&normalized[i * 2..i * 2 + 2], 16)
            .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

#[derive(Clone, Debug)]
pub struct PaletteEntry {
    pub index: u16,
    pub name: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

pub fn encode_canonical_state_bytes(
    chain_genesis_hash_hex: &str,
    board_account_id: &str,
    board_epoch: &str,
    width: u32,
    height: u32,
    palette_version: &str,
    palette: &[PaletteEntry],
    empty_rgba: [u8; 4],
    cells: &[Vec<u8>],
) -> Result<Vec<u8>, String> {
    if cells.len() as u32 != width.saturating_mul(height) {
        return Err("cell count mismatch".into());
    }
    let genesis = hex_to_bytes32(chain_genesis_hash_hex)?;
    let mut sorted = palette.to_vec();
    sorted.sort_by_key(|e| e.index);

    let mut out = Vec::new();
    out.extend_from_slice(STATE_DOMAIN);
    out.extend_from_slice(&genesis);
    out.extend_from_slice(&encode_prefixed_string(board_account_id));
    out.extend_from_slice(&encode_prefixed_string(board_epoch));
    out.extend_from_slice(&encode_u32_be(width));
    out.extend_from_slice(&encode_u32_be(height));
    out.extend_from_slice(&encode_prefixed_string(palette_version));
    out.extend_from_slice(&encode_u16_be(sorted.len() as u16));
    for entry in &sorted {
        out.extend_from_slice(&encode_u16_be(entry.index));
        out.extend_from_slice(&encode_prefixed_string(&entry.name));
        out.push(entry.r);
        out.push(entry.g);
        out.push(entry.b);
    }
    out.extend_from_slice(&empty_rgba);
    for cell in cells {
        out.extend_from_slice(cell);
    }
    Ok(out)
}

pub fn encode_absent_cell() -> Vec<u8> {
    vec![0]
}

pub fn encode_snapshot_identity_bytes(
    state_hash_hex: &str,
    finalized_block_hash_hex: &str,
    block_height: u64,
    block_timestamp_ns: u64,
    revision: u64,
    receipt_id: &str,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.extend_from_slice(SNAPSHOT_DOMAIN);
    out.extend_from_slice(&hex_to_bytes32(state_hash_hex)?);
    out.extend_from_slice(&hex_to_bytes32(finalized_block_hash_hex)?);
    out.extend_from_slice(&encode_u64_be(block_height));
    out.extend_from_slice(&encode_u64_be(block_timestamp_ns));
    out.extend_from_slice(&encode_u64_be(revision));
    out.extend_from_slice(&encode_prefixed_string(receipt_id));
    Ok(out)
}

pub fn encode_print_identity_bytes(
    snapshot_hash_hex: &str,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("crop dimensions must be positive".into());
    }
    let mut out = Vec::new();
    out.extend_from_slice(PRINT_DOMAIN);
    out.extend_from_slice(&hex_to_bytes32(snapshot_hash_hex)?);
    out.extend_from_slice(&encode_u32_be(x));
    out.extend_from_slice(&encode_u32_be(y));
    out.extend_from_slice(&encode_u32_be(width));
    out.extend_from_slice(&encode_u32_be(height));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct FixtureFile {
        state_1x1_absent: StateCase,
        snapshot_identity: SnapshotCase,
        print_identity: PrintCase,
        fixture_hashes: FixtureHashes,
    }

    #[derive(Deserialize)]
    struct FixtureHashes {
        state: String,
        block: String,
    }

    #[derive(Deserialize)]
    struct StateCase {
        input: StateInput,
        expect: StateExpect,
    }

    #[derive(Deserialize)]
    struct StateInput {
        #[serde(rename = "chainGenesisHash")]
        chain_genesis_hash: String,
        #[serde(rename = "boardAccountId")]
        board_account_id: String,
        #[serde(rename = "boardEpoch")]
        board_epoch: String,
        width: u32,
        height: u32,
        #[serde(rename = "paletteVersion")]
        palette_version: String,
        palette: Vec<PaletteJson>,
        #[serde(rename = "emptyRgba")]
        empty_rgba: [u8; 4],
    }

    #[derive(Deserialize)]
    struct PaletteJson {
        index: u16,
        name: String,
        r: u8,
        g: u8,
        b: u8,
    }

    #[derive(Deserialize)]
    struct StateExpect {
        full_bytes_hex: String,
        genesis_offset: usize,
        genesis_raw_hex: String,
    }

    #[derive(Deserialize)]
    struct SnapshotCase {
        input: SnapshotInput,
        expect: SnapshotExpect,
    }

    #[derive(Deserialize)]
    struct SnapshotInput {
        #[serde(rename = "stateHashHex")]
        state_hash_hex: String,
        #[serde(rename = "finalizedBlockHash")]
        finalized_block_hash: String,
        #[serde(rename = "blockHeight")]
        block_height: String,
        #[serde(rename = "blockTimestampNs")]
        block_timestamp_ns: String,
        revision: String,
        #[serde(rename = "receiptId")]
        receipt_id: String,
    }

    #[derive(Deserialize)]
    struct SnapshotExpect {
        full_bytes_hex: String,
        state_raw_at_offset: usize,
        block_raw_at_offset: usize,
    }

    #[derive(Deserialize)]
    struct PrintCase {
        input: PrintInput,
        expect: PrintExpect,
    }

    #[derive(Deserialize)]
    struct PrintInput {
        #[serde(rename = "snapshotHashHex")]
        snapshot_hash_hex: String,
        crop: CropJson,
    }

    #[derive(Deserialize)]
    struct CropJson {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    }

    #[derive(Deserialize)]
    struct PrintExpect {
        full_bytes_hex: String,
    }

    fn fixture() -> FixtureFile {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/history/canonical-hash-encoding.json");
        let raw = fs::read_to_string(path).expect("fixture");
        serde_json::from_str(&raw).expect("parse fixture")
    }

    #[test]
    fn state_golden_matches_typescript() {
        let f = fixture();
        let input = &f.state_1x1_absent.input;
        let palette: Vec<PaletteEntry> = input
            .palette
            .iter()
            .map(|p| PaletteEntry {
                index: p.index,
                name: p.name.clone(),
                r: p.r,
                g: p.g,
                b: p.b,
            })
            .collect();
        let bytes = encode_canonical_state_bytes(
            &input.chain_genesis_hash,
            &input.board_account_id,
            &input.board_epoch,
            input.width,
            input.height,
            &input.palette_version,
            &palette,
            input.empty_rgba,
            &[encode_absent_cell()],
        )
        .unwrap();
        assert_eq!(bytes_to_hex(&bytes), f.state_1x1_absent.expect.full_bytes_hex);
        let off = f.state_1x1_absent.expect.genesis_offset;
        assert_eq!(
            bytes_to_hex(&bytes[off..off + 32]),
            f.state_1x1_absent.expect.genesis_raw_hex
        );
    }

    #[test]
    fn snapshot_golden_raw_hashes() {
        let f = fixture();
        let input = &f.snapshot_identity.input;
        let bytes = encode_snapshot_identity_bytes(
            &input.state_hash_hex,
            &input.finalized_block_hash,
            input.block_height.parse().unwrap(),
            input.block_timestamp_ns.parse().unwrap(),
            input.revision.parse().unwrap(),
            &input.receipt_id,
        )
        .unwrap();
        assert_eq!(
            bytes_to_hex(&bytes),
            f.snapshot_identity.expect.full_bytes_hex
        );
        let s = f.snapshot_identity.expect.state_raw_at_offset;
        let b = f.snapshot_identity.expect.block_raw_at_offset;
        assert_eq!(bytes_to_hex(&bytes[s..s + 32]), f.fixture_hashes.state);
        assert_eq!(bytes_to_hex(&bytes[b..b + 32]), f.fixture_hashes.block);
    }

    #[test]
    fn print_golden() {
        let f = fixture();
        let input = &f.print_identity.input;
        let bytes = encode_print_identity_bytes(
            &input.snapshot_hash_hex,
            input.crop.x,
            input.crop.y,
            input.crop.width,
            input.crop.height,
        )
        .unwrap();
        assert_eq!(bytes_to_hex(&bytes), f.print_identity.expect.full_bytes_hex);
    }
}
