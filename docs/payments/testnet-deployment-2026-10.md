# Testnet rehearsal — paid board and TOILET, 2026-10-29

First live deployment of `contracts/paid-board` (schema 4) and `contracts/toilet`.
Everything below was executed against NEAR testnet; hashes are transaction hashes,
not local test runs. **Nothing here is a mainnet result.**

## What is deployed

| Role | Account | Notes |
|---|---|---|
| Paid board (schema 4) | `board1.metapoo-player3.testnet` | owner = itself; `upgrade()` present |
| TOILET token | `metapoo-toilet.testnet` | NEP-141, 18 decimals, 1B cap, no owner |
| Test payment token (stands in for mPOO) | `metapoo-mpoo.testnet` | same TOILET wasm, 0 tax, emitter = `berrywall1.testnet` so test balances can be minted |
| Players | `metapoo-player1.testnet`, `metapoo-player2.testnet`, `metapoo-player3.testnet` | faucet-funded, 10 NEAR each |

WASM (built with `cargo near build non-reproducible-wasm`):

| Contract | Size | SHA-256 |
|---|---|---|
| paid board | 287,860 B | `5ef0b862dd748354dad02e9c74136e4d126813ccb2ffa6ea68805b2b65b0a308` |
| TOILET | 231,550 B | `4ae3739a4286fb4b07c8331fa5e58ef2553ecbe3c78d7e7c86e5975ef1dbe525` |

Live configuration (`get_tunables`, `get_payment_config`):

- 0.0069 NEAR per credit — `6900000000000000000000` yoctoNEAR, unchanged launch price.
- 1 mPOO per credit (`1000000000000000000`) — **a plumbing fixture, not an economic rate.**
- Registration fee 0.01 NEAR; repaint tiers 1 / 2 / 4 credits at >60 min / 10–60 min / <10 min.
- `toilet_per_cell_second = 1000000000000000` (0.001 TOILET per cell per second). **Fixture.** Roughly 86.4 TOILET per cell per day; the real emission model is still an open owner decision.
- `reserve_floor` 5 NEAR, price cooldown 24 h, float cap uncapped, quota stored but unenforced.

## Build trap that invalidated the first deploy

The first deployment used plain `cargo build --release --target wasm32-unknown-unknown`.
It produced a 431 KB wasm in which **every rejection surfaced as
`WebAssembly trap: An 'unreachable' opcode was executed.` with empty logs** — the
documented codes (`AccountNotRegistered`, `InsufficientCredits`, `NothingToClaim`)
never reached the client, including for `near-sdk`'s own `assert_one_yocto`.

`cargo near build non-reproducible-wasm` produces 288 KB and real messages
(`Smart contract panicked: …: AccountNotRegistered`). **Use `cargo near build` for
anything a client must branch on.** A frontend cannot distinguish failure modes
without it, and this is invisible in `cargo test`.

## Provisioning a fresh board (one board per account, init is once-only)

`~/Hermes-crypto-builder/mpoo/harness/provision-paid-board.sh` does the four steps a
new board needs. Missing any one produces an opaque failure rather than a useful one:

1. create the account and `deploy` + `new(mpoo_token, mpoo_per_credit)`;
2. `set_tunables` (emission rate is zero by default — accrual silently never starts);
3. `storage_deposit` for the board on the payment token (bought credits are paid by
   `ft_transfer_call`; an unregistered receiver rejects the transfer);
4. hand the TOILET `emitter` to the new board — **only the current emitter can do this**,
   so the previous board signs the handoff. `get_emitter` confirmed after each move.

The faucet rate-limits after roughly six accounts ("retry in 12 hours"). Later boards
were created as funded subaccounts (`board1.metapoo-player3.testnet`, 5 NEAR from a
player) and that path works; the script's faucet step is the part that does not scale.

## Evidence — 49 checks against the live deployment

Harness: `~/Hermes-crypto-builder/mpoo/harness/paid-board-acceptance.mjs`
(signs and broadcasts directly over JSON-RPC; every check asserts observable state).
Raw output: `acceptance-results.json`, `acceptance-results-area2.json`.

Result: **48 of 49 passed in-process.** The one failure was a JSON-RPC
`TIMEOUT_ERROR` on the `NothingToClaim` check, not a contract result; replayed
directly it returned
`Smart contract panicked: … NothingToClaim` — so all 49 behaviours are confirmed.

| Check | What it proves on chain |
|---|---|
| D1–D7 | schema 4, 128×128, price/registration/token, `get_emitter` = board, 18 decimals, rate live |
| A1 | unregistered account reads `null`, not zero — the UI's "not registered" state is real |
| A2 | paint from an unregistered account rejects `AccountNotRegistered` |
| A3 | registration with the wrong fee is rejected; **see finding F1** |
| A4–A5 | registration succeeds with exactly 0.01 NEAR; second attempt rejects `AlreadyRegistered` |
| A6 | registered account with zero credits rejects `InsufficientCredits` |
| A7–A8 | stale `expected_price` rejects and the attached NEAR is reverted (credits unchanged) |
| A9 | non-multiple deposit rejects `InvalidPurchaseOrUnregisteredAccountOrFloatFull` |
| A10–A12 | 0.069 NEAR buys exactly 10 credits; `get_outstanding_credits` tracks the float |
| A13 | empty cell costs 1 credit |
| A14–A17 | first paint debits 1; the cell's cost immediately becomes 4 (young tier) |
| A18 | an instant repaint debits 4 — the recency rule is enforced, not advisory |
| A19–A20 | a stroke the balance cannot cover rejects and writes **no** pixels |
| A21–A22 | 3-cell stroke debits 3 in one transaction; ownership counters move |
| A23–A24 | mPOO `ft_transfer_call` credits the buyer and debits exactly 2 tokens |
| A25–A26 | stale-price mPOO purchase credits nothing and the token resolver refunds exactly |
| B1–B2 | `accrued_total` / `remaining` are consistent against the 1B cap |
| B3 | 4 held cells accrue a non-zero pending amount (~0.16 TOILET in 20 s at the fixture rate) |
| B4–B5 | a second artist takes the cell and pays the young-tier price |
| B6 | the first artist's pending emission survives losing the cell (settled, not wiped) |
| B7–B8 | `claim_toilet` mints real TOILET: balance 0.585 → 0.780, no failed receipt |
| B9–B11 | `toilet_claimed` emitted, `claim_failed` absent, pending reset |
| B12–B14 | **claim against a non-emitter token emits `claim_failed`, restores pending, mints nothing** |
| B15 | a cell-less player claiming rejects `NothingToClaim` (replayed by CLI) |
| B16 | a cell-less player accrues exactly zero |

This closes the two proofs the work queue asked for: the paid board answers
schema-4 `get_board` / `get_payment_config`, and `resolve_claim` handles a genuinely
refused mint on chain rather than in a mock.

## Findings

**F1 — should-fix, contract.** `ExactRegistrationFeeRequired` (`register_credit_account`)
and `PriceChanged` (`buy_credits_near`) are produced by Rust `assert_eq!`, so the chain
reports `assertion failed` with no code. Every other rejection uses `env::panic_str` or
`expect` and is readable. The README documents codes the client cannot see; switch these
two to `near_sdk::require!` / `panic_str` before a UI branches on them.

**F2 — note.** A board with `toilet_per_cell_second = 0` accrues nothing and reports no
error. Emission is opt-in per deployment; `get_toilet_emission` is the only signal.

**F3 — note.** Emitter handoff is emit-once-per-handoff and requires the current emitter's
signature. Re-provisioning a board therefore depends on the previous board's key still
being available. Losing it strands the token's mint authority.

## Not proven here

- Checkout, credit purchase and claim **UI** — no frontend code calls any paid method yet;
  the recency price display (PR #20) reads `get_cell_cost` / `get_tunables` / `get_credits`.
- `set_paused`, `withdraw_near`, `set_credit_prices` bounds, `set_toilet_paused`.
- `upgrade()` and any state migration; the safety fields changed Borsh layout.
- Quota enforcement and the `max_earning_cells` cap (stored, not enforced).
- The 1B cap under real emission pressure — unit-tested only; reaching it on chain needs
  an absurd rate.
- Mainnet cost matrix (PAY-COST), NEARLY/AMM tax behaviour, and the "real" mPOO token;
  `metapoo-mpoo.testnet` is a stand-in with zero tax and a mint we control.
