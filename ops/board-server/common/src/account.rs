//! Account ids as the server stores and looks them up.
//!
//! The contract logs NEAR account ids, which are always lowercase, and the server stores them
//! exactly as logged. An id that arrives in a request is trimmed and lowercased, then checked
//! against NEAR's account-id rules (the same pattern as the web's `ACCOUNT_ID`, e.g.
//! `web/src/app/admin-settings.ts`), so `Alice.NEAR ` finds `alice.near`'s keys and junk is
//! rejected before it reaches Valkey.

/// The stored form of `raw`, or `None` if it is not a valid NEAR account id.
pub fn normalize_account(raw: &str) -> Option<String> {
    let id = raw.trim().to_ascii_lowercase();
    is_valid_account(&id).then_some(id)
}

/// NEAR account-id rules: 2–64 characters; `.`-separated parts, each made of `[a-z0-9]` runs
/// joined by single `-` or `_`. Implicit (64 hex) and `0x…` ids pass.
pub fn is_valid_account(id: &str) -> bool {
    if !(2..=64).contains(&id.len()) {
        return false;
    }
    id.split('.').all(|part| {
        part.split(['-', '_']).all(|run| {
            !run.is_empty() && run.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9'))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_ids_pass_and_are_lowercased() {
        assert_eq!(
            normalize_account("alice.near").as_deref(),
            Some("alice.near")
        );
        assert_eq!(
            normalize_account("  Misfits-Validator.NEAR ").as_deref(),
            Some("misfits-validator.near")
        );
        let implicit = "fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e";
        assert_eq!(normalize_account(implicit).as_deref(), Some(implicit));
        assert!(is_valid_account(
            "0x1234567890abcdef1234567890abcdef12345678"
        ));
        assert!(is_valid_account("a_b-c.d"));
    }

    #[test]
    fn junk_is_rejected() {
        let long = "a".repeat(65);
        for bad in [
            "",
            "a",
            "alice..near",
            ".alice",
            "alice.",
            "al--ice",
            "-alice",
            "alice_",
            "alice near",
            "alice@near",
            "covers:alice",
            long.as_str(),
        ] {
            assert_eq!(normalize_account(bad), None, "{bad:?}");
        }
    }
}
