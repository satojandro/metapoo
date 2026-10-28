# 2026-10-28 — paid-board safety and TOILET token

## Learned

Adding fields to a nested Borsh struct changes the saved contract layout just as
adding fields directly to `Board` does. The safety brief called its addition
"migration-free", but its four fields were absent from `Tunables` at `e745942`.
The resulting code is explicitly fresh-initialization only; migration remains a
release gate. Do not upgrade a live account based on a schema number alone.

The outstanding-credit counter now protects withdrawals, so arithmetic saturation
is unsafe: it could hide obligations. Use checked additions/deductions. Tightening
that invariant exposed geometry test fixtures which granted balances without
counting outstanding credits; fixtures now record both sides of the ledger.

A fee-on-transfer token must tell the receiver what it actually received. Here,
tax settles before the receiver runs, failed calls refund only the net amount,
and refund processing does not apply tax or honor a later transfer pause. The
private resolver also records burns when the sender has removed its token account.
These are explicit local semantics, not evidence of compatibility with a live pool.

## Evidence

- Baseline checked: clean `34b1a84` checkout, fetched and fast-forwarded to `e745942`
  to include the two requested task briefs. Existing contract implementation commits
  verified in `origin/main`: `0e4eae5`, `34b1a84`.
- Test-first regression: `payments::tests::threefold_price_change_is_rejected`
  **failed before** the fix because no panic occurred; it passes after price bounds.
- `cargo test --locked --manifest-path contracts/paid-board/Cargo.toml`: **63 pass**.
  Covers paused paths, FT full refund, reserve/withdrawal boundaries, an immediately
  repeated withdrawal, price step/cooldown boundaries, immutable price history, and
  outstanding-credit overflow.
- `cargo test --locked --manifest-path contracts/toilet/Cargo.toml`: **18 pass**.
  Includes issuance cap after burn, rounding conservation, exemptions, authority,
  storage refund/removal, failed/partial/oversized receiver responses, deleted
  sender, receiver spending, pause during refund, and actual promise payload inspection.
- Both crates build with `cargo build --locked --release --target wasm32-unknown-unknown`.
- Both crates pass formatting checks and `cargo clippy --locked --all-targets -- -D warnings`.
  Local release WASM sizes: paid board 372,588 bytes; TOILET 337,810 bytes.
- `web/`: **284 tests pass**, `npm run build` passes. Existing warnings remain:
  browser externalization of `util` through `generate-function`, and mixed static/
  dynamic imports of NEAR crypto. These contract changes do not fix or validate that
  browser runtime path.
- TOILET pins SDK and standards package to 5.29.1 and includes its Cargo.lock.

## Boundaries and next proof

Changes are isolated on `codex/paid-board-safety-toilet-token` for review. No sandbox or chain transaction was executed,
no deployment was performed, and no actual funds moved. Unit tests inspect a mocked
NEAR runtime; they do not prove live receipt settlement, WASM gas limits, AMM
compatibility, storage cost, or a migration. The older free-board chain state would
not validate either new build, so it is not presented as evidence here.

Independent review should check the full diff, followed by a separately authorized
fresh testnet/sandbox rehearsal: buy → paint → pause/refund → bounded withdrawal,
and token mint → taxed transfer-call → successful/failed receiver → supply readback.
Keep paid-board storage measurement, migration and venue integration as open gates.
