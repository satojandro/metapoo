# Testnet rehearsal — free first paints without registration (2026-11-14)

Contract change `0ffdb20`: F1 no longer requires a registered account. `plan_stroke` prices an
account's first 25 empty cells at 0 whatever its registration state, and
`get_free_first_paints.remaining` stops zeroing out for unregistered accounts. Happy hour (F2) is
untouched: still registered, and still gated on a purchase where the flag is on.

Motivation, measured on mainnet before the change: a new wallet had to pay **0.01 NEAR**
(`register_credit_account`) **plus one credit at 0.0025 NEAR** before its first free tile, so the
"paint free" affordance was unreachable without a purchase.

## Artifact

| | |
|---|---|
| source | `0ffdb20` (main) |
| build | `cargo near build non-reproducible-wasm` |
| size | 444,263 B |
| sha256 | `492d0cfb774e05f5e05a2172c5237fb617a691419f292c4b80eaf4f395b6c766` |
| code hash (bs58) | `5vec6GdTjApxxjekSWhSrNMNVomNrn4miVWRSm8hQKJD` |

`cargo test --lib`: **206 passed, 0 failed**, including the rewritten
`f1_an_unregistered_account_paints_its_first_25_free_then_needs_credits`.

## Trap found: a code-only deploy over stale-layout state bricks reads

Deploying that wasm onto `board3.metapoo-player1.testnet` (code `ASD1Leb…`, state version 2) —
a board whose state predates the current `Board` layout — made every read panic:

```
wasm execution failed with error: HostError(GuestPanic { panic_msg: "Cannot deserialize the contract state." })
tx efMuSvjEYHJw2bMuYRxJQkkife5ExiYiawgp4KK2Zne
```

Borsh state is positional, so new code cannot read state written before the last struct field was
added — `get_state_version` says 2 both before and after, which is why the version is not the signal.
The signal is **the layout the live code was built from**.

Recovered by redeploying the matching artifact (`~/Projects/metapoo-main/contracts/paid-board/target/near/metapoo_paid_board.wasm`,
`ASD1Leb…`), tx `HVqrkfhFDvpcM6zyKWS4CrZMzxRUQw38EUdiuRefzNDH`. After: code `ASD1Leb…`,
`get_state_version` 2, board 128 × 128, outstanding credits 8, `get_free_first_paints(berrywall1)`
`remaining 0` — identical to before the attempt. A code-only deploy is therefore reversible in one
transaction.

**Consequence for mainnet:** `board.meta-poo-stall.near` runs `93V8Jh43r8HYpkq8JAp8A5dpJKrgGyjwSZhzCu3iBiB8`,
built from `7edcdec` (merge of #76). `git log 7edcdec..HEAD -- contracts/paid-board/src/lib.rs` is
**empty**, so no field has been added since that build and the mainnet layout is the one this artifact
expects. A code-only deploy there is layout-safe; every testnet board was not (board3/board4 run
`ASD1Leb…`, board64 `2NPcAg…` predates `board_version`).

## Behaviour, on chain

No testnet board carried the current layout, so the rehearsal provisioned a fresh one from the same
artifact: `metapoo-f1.testnet` (faucet-funded), one transaction creating it with
`new(mpoo_token, 1000e18 mPOO/credit, team, buyback, toilet)` — tx `7tnMuLuaUSLM4JwtEoMxz41tf9WZuDk9bShowWQp8FPp`.
It reads 64 × 64, schema 4, state version 2, `free_first_paints_per_account` 25, unpaused.

Painter: `berrywall1.testnet`, **never registered, never buys, no credits**.

| step | tx | result |
|---|---|---|
| `get_credits(berrywall1)` | — | `null` (unregistered) |
| `get_free_first_paints(berrywall1)` | — | `used 0, remaining 25, active true, registered false` |
| `get_stroke_cost(25 empty cells)` | — | `total 0`, all 25 `free: true` |
| `draw_many(25 cells, max_credits 0)` | `8WDgK4kBrXdhqCQAShSZasbtKgr974wZU6znxkB7Jvci` | **ok**; events carry `credits:0, free:true` |
| after | — | `used 25, remaining 0`, `get_credits` still `null`, `get_pixels.total` 25 |
| `draw(x40,y5, max_credits 0)` | `2SmU2gV1hJxn5Fi2Ffx7c29zxC6wakVroKzhrShbJ3gp` | panics `PriceRoseAboveMax: draw was rejected and no pixel was stored` |
| `draw(x40,y5, max_credits 1)` | `77jAS7shwvYjDU4kW9skD7abKvJ3sRLv3DzKGdBDvPSQ` | panics `AccountNotRegistered` (`payments.rs:251` — `spend`) |

Cell `(0,0)` after the stroke: `{color 3, artist berrywall1.testnet}`. Holder accounting for an
unregistered painter, which is what a farmer would also get:

| read | value |
|---|---|
| `get_cells_owned(berrywall1)` | 25 |
| `get_earning_cells(berrywall1)` | **0** — free paints never earn |
| `get_pending_toilet(berrywall1)` | `0` |
| `get_outstanding_credits` | `0` — nothing was sold, nothing spent |

16 of 16 checks passed (`rehearse-fresh-board-results.json`); the one apparent failure in the run log
was the harness reading `.length` off `get_pixels`, which returns `{pixels, total}` — `total` is 25.

## What this does not prove

- **Upgrade-over-live-state on testnet**: impossible without a board at the mainnet layout. The
  mainnet safety argument is the git evidence above plus the fact that the deploy path itself is
  exercised (board3 deploy and rollback, both one transaction).
- **Gas is still not free.** `draw` costs the painter a fee (~0.0001–0.0003 NEAR). A Privy wallet
  holding 0 NEAR can now paint free cells but still cannot pay the fee; that remains the SPONSOR drip's
  job, now scoped to gas only.
- **Sybil cost is now gas per account.** Registration was the only payment standing between a throwaway
  account and 25 free cells. 655 accounts at gas price can fill the whole 16,384-cell wall during the
  fill window. They earn no TOILET and hold no credits, and the latch ends the offer at the first fill,
  but the wall can be seeded by one fanner rather than by users.

## Harness

`~/Hermes-crypto-builder/mpoo/harness/rehearse-fresh-board.mjs <new-account> <new-account> 0 --existing`
provisions/initialises and runs every check above. `restore-board3.mjs` redeploys the previous
artifact when a deploy has to be undone. Both sign locally with the harness' `@near-js` helpers; no
private key is printed.
