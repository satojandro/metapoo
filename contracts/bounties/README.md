# Meta Poo bounty escrow

Separate NEAR contract for MPOO-funded art commissions. Deposits are **escrow liabilities**, never paint revenue.

Wave 1: unit-tested state machine. No mainnet deploy. FT transfers are stubbed (`claim` → PENDING; settle via `on_claim_result` with predecessor = contract).

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
