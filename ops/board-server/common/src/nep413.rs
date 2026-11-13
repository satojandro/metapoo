//! NEP-413 signed messages (<https://github.com/near/NEPs/blob/master/neps/nep-0413.md>), the
//! off-chain "sign this text" a NEAR wallet offers. No transaction, no fee.
//!
//! What the wallet signs is `sha256(borsh(2^31 + 413 as u32) ++ borsh(Payload))`, where
//! `Payload { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }`.
//! The wallet returns `publicKey` as `ed25519:<base58>` and `signature` as base64.
//!
//! This module only checks the signature. It cannot know whether the key belongs to the
//! account, or whether it is a full-access key: the caller must ask the chain
//! (`view_access_key`). A function-call key can produce a perfectly valid signature here.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// The tag prepended to the payload so a signed message can never be a valid transaction.
pub const TAG: u32 = (1 << 31) + 413;

pub const NONCE_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// Not `ed25519:<base58 of 32 bytes>`, or not a point on the curve.
    BadPublicKey,
    /// Not base64 of 64 bytes.
    BadSignature,
    /// Well-formed, but not this key's signature over this payload.
    Mismatch,
}

fn put_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// The bytes that are hashed: the tag, then the borsh payload.
pub fn payload_bytes(
    message: &str,
    nonce: &[u8; NONCE_LEN],
    recipient: &str,
    callback_url: Option<&str>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + message.len() + recipient.len());
    out.extend_from_slice(&TAG.to_le_bytes());
    put_string(&mut out, message);
    out.extend_from_slice(nonce);
    put_string(&mut out, recipient);
    match callback_url {
        None => out.push(0),
        Some(url) => {
            out.push(1);
            put_string(&mut out, url);
        }
    }
    out
}

/// The 32 key bytes of an `ed25519:<base58>` public key.
pub fn parse_public_key(public_key: &str) -> Result<[u8; 32], VerifyError> {
    let encoded = public_key
        .strip_prefix("ed25519:")
        .ok_or(VerifyError::BadPublicKey)?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| VerifyError::BadPublicKey)?;
    bytes.try_into().map_err(|_| VerifyError::BadPublicKey)
}

fn parse_signature(signature: &str) -> Result<Signature, VerifyError> {
    let trimmed = signature.trim().trim_end_matches('=');
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed)
        .map_err(|_| VerifyError::BadSignature)?;
    let bytes: [u8; 64] = bytes.try_into().map_err(|_| VerifyError::BadSignature)?;
    Ok(Signature::from_bytes(&bytes))
}

/// Is `signature` (base64) the signature of `public_key` (`ed25519:<base58>`) over exactly
/// this message, nonce, recipient and callback URL?
pub fn verify(
    message: &str,
    nonce: &[u8; NONCE_LEN],
    recipient: &str,
    callback_url: Option<&str>,
    public_key: &str,
    signature: &str,
) -> Result<(), VerifyError> {
    let key = VerifyingKey::from_bytes(&parse_public_key(public_key)?)
        .map_err(|_| VerifyError::BadPublicKey)?;
    let signature = parse_signature(signature)?;
    let hash = Sha256::digest(payload_bytes(message, nonce, recipient, callback_url));
    key.verify_strict(&hash, &signature)
        .map_err(|_| VerifyError::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced outside this code, by near-api-js (`@near-js/signers` 2.5.1,
    // `KeyPairSigner.signNep413Message`) with the ed25519 key whose seed is the bytes 1..=32,
    // over the NEP's own example: message "hi", nonce 0..=31, recipient "myapp.com".
    const PUBLIC_KEY: &str = "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj";
    const WITH_CALLBACK: &str =
        "go9wr20JyIN3mavrLYG1XiN2WjuGi4e4NamNAU4RVqQ5L7ZsA7UPIZswf9VSG1QA1+xoWlMCAakp7v4tRBJzCw==";
    const WITHOUT_CALLBACK: &str =
        "05wuMQjiBjH5CtGwN0s+b5WNrvBe2akFDTvyKlrkEKFvP79gAE4BveGIrwrj/NVs0/G1ndHNq/u+GPPWxJSNDw==";
    const CALLBACK: &str = "myapp.com/callback";

    fn nonce() -> [u8; 32] {
        std::array::from_fn(|i| i as u8)
    }

    #[test]
    fn the_tag_is_two_to_the_31_plus_413() {
        assert_eq!(TAG, 2_147_484_061);
        assert_eq!(&payload_bytes("", &[0; 32], "", None)[..4], &[0x9d, 0x01, 0x00, 0x80]);
    }

    #[test]
    fn the_payload_is_the_neps_borsh_layout() {
        let bytes = payload_bytes("hi", &nonce(), "myapp.com", Some(CALLBACK));
        let mut expected = vec![0x9d, 0x01, 0x00, 0x80, 2, 0, 0, 0, b'h', b'i'];
        expected.extend(0u8..32);
        expected.extend([9, 0, 0, 0]);
        expected.extend(b"myapp.com");
        expected.push(1);
        expected.extend([18, 0, 0, 0]);
        expected.extend(CALLBACK.as_bytes());
        assert_eq!(bytes, expected);
        // No callback URL is one zero byte, not an empty string.
        let none = payload_bytes("hi", &nonce(), "myapp.com", None);
        assert_eq!(none.len(), 4 + 6 + 32 + 13 + 1);
        assert_eq!(none.last(), Some(&0));
    }

    #[test]
    fn a_near_api_js_signature_verifies() {
        assert_eq!(
            verify("hi", &nonce(), "myapp.com", Some(CALLBACK), PUBLIC_KEY, WITH_CALLBACK),
            Ok(())
        );
        assert_eq!(
            verify("hi", &nonce(), "myapp.com", None, PUBLIC_KEY, WITHOUT_CALLBACK),
            Ok(())
        );
        // Wallets differ on base64 padding.
        assert_eq!(
            verify(
                "hi",
                &nonce(),
                "myapp.com",
                None,
                PUBLIC_KEY,
                WITHOUT_CALLBACK.trim_end_matches('=')
            ),
            Ok(())
        );
    }

    #[test]
    fn a_tampered_message_nonce_recipient_or_callback_does_not_verify() {
        let ok = |m: &str, n: &[u8; 32], r: &str, c: Option<&str>| {
            verify(m, n, r, c, PUBLIC_KEY, WITHOUT_CALLBACK)
        };
        assert_eq!(ok("hi", &nonce(), "myapp.com", None), Ok(()));
        assert_eq!(ok("hi!", &nonce(), "myapp.com", None), Err(VerifyError::Mismatch));
        let mut other = nonce();
        other[31] ^= 1;
        assert_eq!(ok("hi", &other, "myapp.com", None), Err(VerifyError::Mismatch));
        assert_eq!(ok("hi", &nonce(), "evil.com", None), Err(VerifyError::Mismatch));
        assert_eq!(
            ok("hi", &nonce(), "myapp.com", Some(CALLBACK)),
            Err(VerifyError::Mismatch)
        );
        // Bytes moved between message and recipient: the length prefixes keep them apart.
        assert_eq!(ok("himyapp", &nonce(), ".com", None), Err(VerifyError::Mismatch));
    }

    #[test]
    fn another_key_or_another_signature_does_not_verify() {
        // The key whose seed is 32 zero bytes: a real key, not the signer.
        let other = "ed25519:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
        assert_eq!(
            verify("hi", &nonce(), "myapp.com", None, other, WITHOUT_CALLBACK),
            Err(VerifyError::Mismatch)
        );
        assert_eq!(
            verify("hi", &nonce(), "myapp.com", None, PUBLIC_KEY, WITH_CALLBACK),
            Err(VerifyError::Mismatch)
        );
    }

    #[test]
    fn malformed_keys_and_signatures_are_rejected_not_panicked_on() {
        let v = |key: &str, sig: &str| verify("hi", &nonce(), "myapp.com", None, key, sig);
        for key in [
            "",
            "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
            "secp256k1:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
            "ed25519:",
            "ed25519:abc",
            "ed25519:0OIl",
        ] {
            assert_eq!(v(key, WITHOUT_CALLBACK), Err(VerifyError::BadPublicKey), "{key:?}");
        }
        for sig in ["", "not base64!", "aGk=", &WITHOUT_CALLBACK[..40]] {
            assert_eq!(v(PUBLIC_KEY, sig), Err(VerifyError::BadSignature), "{sig:?}");
        }
    }
}
