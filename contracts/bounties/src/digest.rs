//! Deterministic consent digest and proposal fingerprint helpers.
//!
//! Serialization is explicit and documented so clients can reproduce digests
//! without depending on serde field order. Format version is part of the payload.

use crate::split::RecipientShare;
use crate::CropRect;
use near_sdk::env;

/// Documented consent-digest serialization (v1).
///
/// Lines joined by `\n`:
/// ```text
/// mpoo_bounty_consent_v1
/// network_id=<str>
/// escrow_account_id=<str>
/// bounty_id=<decimal>
/// proposal_id=<decimal>
/// snapshot_id=<str>
/// manifest_hash=<str>
/// crop=<x>,<y>,<width>,<height>
/// note_hash=<str>
/// terms_version=<str>
/// recipients=<account>:<bps>,...   # sorted by account_id ascending
/// ```
/// Digest = lowercase hex of `sha256(utf8(payload))`.
pub fn consent_digest_payload(
    network_id: &str,
    escrow_account_id: &str,
    bounty_id: u64,
    proposal_id: u64,
    snapshot_id: &str,
    manifest_hash: &str,
    crop: &CropRect,
    note_hash: &str,
    recipients_sorted: &[RecipientShare],
    terms_version: &str,
) -> String {
    let recipients = recipients_sorted
        .iter()
        .map(|r| format!("{}:{}", r.account_id, r.share_bps))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "mpoo_bounty_consent_v1\n\
         network_id={network_id}\n\
         escrow_account_id={escrow_account_id}\n\
         bounty_id={bounty_id}\n\
         proposal_id={proposal_id}\n\
         snapshot_id={snapshot_id}\n\
         manifest_hash={manifest_hash}\n\
         crop={x},{y},{w},{h}\n\
         note_hash={note_hash}\n\
         terms_version={terms_version}\n\
         recipients={recipients}",
        x = crop.x,
        y = crop.y,
        w = crop.width,
        h = crop.height,
    )
}

pub fn compute_consent_digest(
    network_id: &str,
    escrow_account_id: &str,
    bounty_id: u64,
    proposal_id: u64,
    snapshot_id: &str,
    manifest_hash: &str,
    crop: &CropRect,
    note_hash: &str,
    recipients_sorted: &[RecipientShare],
    terms_version: &str,
) -> String {
    let payload = consent_digest_payload(
        network_id,
        escrow_account_id,
        bounty_id,
        proposal_id,
        snapshot_id,
        manifest_hash,
        crop,
        note_hash,
        recipients_sorted,
        terms_version,
    );
    hex::encode(env::sha256(payload.as_bytes()))
}

/// Canonical fingerprint excluding proposal/client IDs (duplicate-proposal guard).
///
/// ```text
/// mpoo_bounty_fingerprint_v1
/// bounty_id=...
/// proposer=...
/// snapshot_id=...
/// crop=...
/// note_hash=...
/// recipients=...
/// ```
pub fn proposal_fingerprint(
    bounty_id: u64,
    proposer: &str,
    snapshot_id: &str,
    crop: &CropRect,
    note_hash: &str,
    recipients_sorted: &[RecipientShare],
) -> String {
    let recipients = recipients_sorted
        .iter()
        .map(|r| format!("{}:{}", r.account_id, r.share_bps))
        .collect::<Vec<_>>()
        .join(",");
    let payload = format!(
        "mpoo_bounty_fingerprint_v1\n\
         bounty_id={bounty_id}\n\
         proposer={proposer}\n\
         snapshot_id={snapshot_id}\n\
         crop={x},{y},{w},{h}\n\
         note_hash={note_hash}\n\
         recipients={recipients}",
        x = crop.x,
        y = crop.y,
        w = crop.width,
        h = crop.height,
    );
    hex::encode(env::sha256(payload.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split::RecipientShare;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId};

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn digest_is_stable_for_same_inputs() {
        testing_env!(VMContextBuilder::new().build());
        let crop = CropRect {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        let recipients = vec![
            RecipientShare {
                account_id: acct("alice.testnet"),
                share_bps: 6000,
            },
            RecipientShare {
                account_id: acct("bob.testnet"),
                share_bps: 4000,
            },
        ];
        let a = compute_consent_digest(
            "testnet",
            "bounties.test.near",
            1,
            2,
            "snap-1",
            "mh-1",
            &crop,
            "nh-1",
            &recipients,
            "bounty-terms-v1",
        );
        let b = compute_consent_digest(
            "testnet",
            "bounties.test.near",
            1,
            2,
            "snap-1",
            "mh-1",
            &crop,
            "nh-1",
            &recipients,
            "bounty-terms-v1",
        );
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn digest_changes_when_proposal_id_changes() {
        testing_env!(VMContextBuilder::new().build());
        let crop = CropRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        let recipients = vec![RecipientShare {
            account_id: acct("alice.testnet"),
            share_bps: 10000,
        }];
        let a = compute_consent_digest(
            "testnet",
            "escrow",
            1,
            1,
            "s",
            "m",
            &crop,
            "n",
            &recipients,
            "v1",
        );
        let b = compute_consent_digest(
            "testnet",
            "escrow",
            1,
            2,
            "s",
            "m",
            &crop,
            "n",
            &recipients,
            "v1",
        );
        assert_ne!(a, b);
    }
}
