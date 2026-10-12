# Meta Poo bounty escrow

Separate NEAR contract for MPOO-funded art commissions. Deposits are **escrow liabilities**, never paint revenue.

Wave 1: unit-tested state machine. No mainnet deploy.

## Claims (FT transfer)

`claim(claim_id)` marks the claim PENDING, then schedules NEP-141 `ft_transfer` on the configured `mpoo_token` (1 yoctoNEAR deposit) to the fixed beneficiary for `claim.amount`, followed by a private callback:

`Self::ext(...).on_claim_ft_result(claim_id, attempt_id)`

The callback requires predecessor = current account and derives success from `env::promise_result(0)`:

- `PromiseResult::Successful(_)` → status PAID
- otherwise → status AVAILABLE, clear `attempt_id` so the beneficiary can retry

Unit tests assert outgoing receipts include `ft_transfer`, then invoke the callback with mocked `promise_results` (`Successful` / `Failed`). Settlement logic lives in a private `settle_claim_attempt` helper used only by that callback path.

## Storage funding

User-controlled writes that allocate new persistent records require an attached NEAR deposit covering storage growth:

| Method | Policy |
| --- | --- |
| `create_bounty` | Measure `storage_usage` before/after inserts; require `attached_deposit ≥ storage_byte_cost × bytes_used`; refund excess to predecessor; panic (tx rollback) if short |
| `propose_submission` | Same |
| `register_snapshot_reference` | Same |

Idempotent nonce / identical-snapshot paths that do not grow storage refund the full attached deposit.

**Not yet metered:** claim rows created inside `accept_submission` / `expire_bounty` (sponsor award / permissionless expiry). Those still grow contract storage without a caller storage deposit; treat as a known Wave 1 gap.

## Mock accounts (tests only)

| Role | Account id |
| --- | --- |
| MPOO FT | `mpoo.token.mock.test.near` |
| Snapshot registry | `snapshot.registry.mock.test.near` |
| Escrow (current) | `bounties.escrow.mock.test.near` |

## Build / test

```bash
cd contracts/bounties
cargo test
```

near-sdk version matches `contracts/board` (5.29.1). This crate is standalone (no workspace root); do not merge into the board package.

## Consent digest

Documented in `src/digest.rs` (`mpoo_bounty_consent_v1` newline payload → sha256 hex).
