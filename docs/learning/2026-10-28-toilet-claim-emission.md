# TOILET claim emission — 2026-10-28

Implemented the corrected toilet-accrual-claim brief. Both contracts are fresh init
only, no migration. No deployment, frontend changes, dependency changes, or git
index/commit/push operations were performed.

## Test-first evidence

Wrote the first three acceptance assertions and ran them before implementing the
accumulator. A temporary `get_pending_toilet` API stub panicked with
`not implemented: TOILET accrual`, allowing runtime red tests rather than treating
missing-method compiler errors as test failures. The new rate field/default was
present for the fixtures; no accrual/settlement implementation existed yet.

Command, from `contracts/paid-board`:

```text
cargo test --locked emission::tests:: -- --nocapture

failures:
    emission::tests::accrual_is_zero_until_a_rate_is_set
    emission::tests::one_cell_accrues_rate_times_elapsed
    emission::tests::overwrite_settles_the_previous_owner_and_starts_the_new_one

test result: FAILED. 0 passed; 3 failed; 0 ignored; 0 measured; 65 filtered out
```

The raw initial failure output was captured in `/tmp/toilet-accrual-red.log`.
The temporary stub has been replaced; all three tests now pass.

## Accounting and arithmetic boundaries

- The board reserves at accrual: `accrued_total <= CAP`. Claims neither re-reserve
  nor reopen the cap. Empty-board time earns nothing; same-artist repaints do not
  reset holder debt; a holder with zero cells retains pending emission.
- A single shared accumulator and holder `{cells, debt, pending}` avoid iteration
  over holders. `draw_many` moves ownership once per distinct cell, including
  duplicate entries. Existing credit charging and repaint pricing stay intact.
- `SCALE = 1e9`, `CAP = 1e27`, and the compile-time assertion is
  `const _: () = assert!(CAP <= u128::MAX / SCALE);`. The accumulator ceiling is
  `1e36`, about 340 times below `u128::MAX`. No U256 dependency was added.
- Accumulator division loses less than `total_cells / SCALE`, at most
  0.000016384 atomic units per call on the full board. The specified
  `rate * elapsed / 1e9 * total_cells` also truncates subsecond per-cell emission
  before multiplying by cell count; this separate rounding is not the accumulator
  precision bound and is not carried forward.
- The validated rate ceiling is `u128::MAX / (86_400e9 * 16_384)`.
  Rate changes settle elapsed emission at the old rate first.
- Idle periods can exceed 24 hours. Checked overflow in the unscaled emission
  calculation safely clamps to remaining issuance: even overflow before division
  represents more than `u128::MAX / 1e9` atomic units, already above CAP. A checked
  overflow after multiplying by cell count is also necessarily above CAP.
- Holder entitlement divides the accumulator into quotient and remainder before
  multiplication, preserving the specified floor exactly. This matters when a
  holder gains many cells after the accumulator has approached its single-cell
  ceiling; `cells * acc` itself can overflow even though its divided result fits.
- `accrual_reaches_the_cap_without_overflow` drives one real painted cell to CAP,
  checks `acc_per_cell == CAP * SCALE`, claims CAP, and checks a new holder gaining
  64 cells after exhaustion. Additional tests cover the maximum rate/full board,
  extreme idle time, rate changes, pause-independent claims and one-yocto gating.

## Claim and token boundaries

`claim_toilet(toilet)` settles and zeroes only the caller's pending amount, returns
an exact `mint(account, amount)` promise with zero deposit and 10 Tgas, and logs
`toilet_claimed{account_id, amount, accrued_total}`. An empty/repeated claim fails
`NothingToClaim`. Receipt payloads and event data are asserted in unit tests.
`get_pending_toilet(account)` projects through the current block without mutation;
`get_toilet_emission()` reports persisted reservations and the configured rate.

The token auto-registers missing mint recipients using standard internal
registration and emits `account_auto_registered`. It protects existing storage,
the new account's minimum storage cost and a liquid 1 NEAR floor; lower funding
fails `RegistrationReserveLow`. The exact reserve boundary, existing-recipient
minting below that boundary, and no repeated auto-registration are tested.
Explicit registration, unregister/refunds, tax behavior, emitter-only controls,
resolver return and `transfer_resolved` event stay intact. The board's `upgrade`
and `set_toilet_paused` implementations and their existing tests stay intact.

These are mocked-runtime tests, not an executed cross-contract sandbox test.
The board test asserts the minted amount and receipt arguments; the token's
`claim_auto_registers_an_unregistered_player` test exercises that emitter mint
path directly. The board must be the supplied token's configured emitter.

The first implementation had no failure-restoration callback: pending was zeroed
before the mint receipt executed, so a failed mint (wrong token, wrong emitter, low
registration reserve) destroyed the claim while `toilet_claimed` reported success —
scheduling is not settlement. Review added `resolve_claim`, a `#[private]` callback
chained after the mint: on `PromiseError::Failed` it restores `pending` and emits
`claim_failed`. `TooLong` counts as success, because the call succeeded and only the
payload could not be read; treating it as failure would double-credit. A test drives
both branches through `settle_claim_result`.

Receipt execution is still mocked, not proven on chain: the callback path needs the
testnet rehearsal before any deployment.
Gas sufficiency and actual WASM receipt execution remain deployment rehearsals.

## Verification

For each crate, used:

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
export DYLD_LIBRARY_PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/lib"
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
cargo clippy --locked --all-targets -- -D warnings
```

Both test suites, both release WASM builds and both strict Clippy checks passed.
The board has 77 tests; the token has 24 tests. Doc-tests have zero failures.
All eleven named acceptance tests are present and pass. Changes are restricted to
the two contract source trees, their READMEs and this learning note.
