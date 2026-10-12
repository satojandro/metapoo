//! Canonical print / bounty-series identity encoding.
//!
//! Matches `shared/history` and `docs/implementation/history-and-prints.md`:
//! integers are unsigned big-endian; strings are UTF-8 with a u32 length prefix;
//! hashes are 32 raw SHA-256 bytes (stored on chain / at JSON as lowercase hex).

use near_sdk::env;

pub const PRINT_DOMAIN: &[u8] = b"MPOO_PRINT_V1\0";
pub const BOUNTY_SERIES_DOMAIN: &[u8] = b"MPOO_BOUNTY_SERIES_V1\0";

pub const PUBLIC_SERIES_ID: &str = "public-v1";

/// Decode a 64-char (optional `0x`) hex string into 32 raw bytes.
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

fn encode_u32_be(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

fn encode_u64_be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

fn encode_prefixed_string(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&encode_u32_be(bytes.len() as u32));
    out.extend_from_slice(bytes);
    out
}

/// `print_id = lowercase hex(SHA256(MPOO_PRINT_V1\\0 || snapshot_hash || crop))`.
pub fn compute_print_id(
    snapshot_hash_hex: &str,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("crop dimensions must be positive".into());
    }
    let snap = hex_to_bytes32(snapshot_hash_hex)?;
    let mut out = Vec::with_capacity(PRINT_DOMAIN.len() + 32 + 16);
    out.extend_from_slice(PRINT_DOMAIN);
    out.extend_from_slice(&snap);
    out.extend_from_slice(&encode_u32_be(x));
    out.extend_from_slice(&encode_u32_be(y));
    out.extend_from_slice(&encode_u32_be(width));
    out.extend_from_slice(&encode_u32_be(height));
    Ok(hex::encode(env::sha256(&out)))
}

/// `series_id = "bounty-" + hex(SHA256(MPOO_BOUNTY_SERIES_V1\\0 || genesis || escrow || bounty_id))`.
pub fn compute_bounty_series_id(
    chain_genesis_hash_hex: &str,
    escrow_account: &str,
    bounty_id: u64,
) -> Result<String, String> {
    let genesis = hex_to_bytes32(chain_genesis_hash_hex)?;
    let mut out = Vec::new();
    out.extend_from_slice(BOUNTY_SERIES_DOMAIN);
    out.extend_from_slice(&genesis);
    out.extend_from_slice(&encode_prefixed_string(escrow_account));
    out.extend_from_slice(&encode_u64_be(bounty_id));
    Ok(format!("bounty-{}", hex::encode(env::sha256(&out))))
}

pub fn print_token_id(print_id: &str, series_id: &str, edition_number: u32) -> String {
    format!("{print_id}:{series_id}:{edition_number}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn env_ready() {
        testing_env!(VMContextBuilder::new().build());
    }

    #[test]
    fn print_id_is_stable_hex() {
        env_ready();
        let snap = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let a = compute_print_id(snap, 0, 0, 128, 128).unwrap();
        let b = compute_print_id(snap, 0, 0, 128, 128).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(
            compute_print_id(snap, 0, 0, 64, 64).unwrap(),
            a,
            "different crop → different print_id"
        );
    }

    #[test]
    fn bounty_series_differs_by_escrow_and_id() {
        env_ready();
        let genesis = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let s1 = compute_bounty_series_id(genesis, "escrow.a.near", 1).unwrap();
        let s2 = compute_bounty_series_id(genesis, "escrow.b.near", 1).unwrap();
        let s3 = compute_bounty_series_id(genesis, "escrow.a.near", 2).unwrap();
        assert!(s1.starts_with("bounty-"));
        assert_ne!(s1, s2);
        assert_ne!(s1, s3);
    }
}
