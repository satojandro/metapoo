# Mainnet deploy — free first paints without registration (2026-11-14)

`0ffdb20` is live on `board.meta-poo-stall.near`. Code-only deploy: one `DeployContract`
action, no `migrate`, no state change.

| | |
|---|---|
| tx | `9keAQzyjN2dwBQC4AxnqtbKSpEJaj4XvMDpvuAjED1N6` — 3.4 Tgas, fee 0.000332 NEAR |
| actions | `DeployContract` only |
| artifact | 444,263 B, sha256 `492d0cfb774e05f5e05a2172c5237fb617a691419f292c4b80eaf4f395b6c766` |
| build | `cargo near build non-reproducible-wasm` from `c6b088a` (rebuilt from the same checkout → identical hash) |
| code hash | `93V8Jh43r8HYpkq8JAp8A5dpJKrgGyjwSZhzCu3iBiB8` → `5vec6GdTjApxxjekSWhSrNMNVomNrn4miVWRSm8hQKJD` |
| signed by | the board's own full-access key, from the owner's machine |

Why a bare `deployContract` and not `upgrade()`: `upgrade` always batches `DeployContract` with
`migrate`, and `migrate` rejects state already at version 2 (`UnsupportedStateVersion`), which would
roll the deploy back. See `docs/payments/testnet-rehearsal-free-first-paints-2026-11-14.md`.

## State preserved

| read | before | after |
|---|---|---|
| `get_state_version` | 2 | 2 |
| `get_board` | 64 × 64, schema 4 | 64 × 64, schema 4 |
| `get_pixels.total` | 1,270 | 1,270 |
| `get_tunables` | free_first 25, unpaused, tiers 1/2/4, mPOO cap 0 | identical |
| `get_payment_config` | 0.0025 NEAR/credit, 1000 mPOO/credit, 0.01 registration | identical |
| `get_happy_hour.first_fill_complete` | false | false |
| storage_usage | 671,523 B | 673,662 B (+2,139 = the code size delta) |

## The behaviour change, read off mainnet

| read | result |
|---|---|
| `get_free_first_paints(<unregistered>)` | `used 0, remaining 25, active true, registered false` — was `remaining 0` |
| `get_stroke_cost(unregistered, 3 empty cells)` | `costs [0,0,0], free [true,true,true], total 0` |
| `get_stroke_cost(unregistered, painted (58,24))` | `costs [1], free [false], total 1` — repaints still cost |
| `get_stroke_cost(unregistered, painted (54,19))` | `costs [1], free [false], total 1` |
| `get_stroke_cost(unregistered, painted (6,5))` | `costs [1], free [false], total 1` |

So the allowance reaches accounts that never registered, and it stays confined to **empty** cells:
every painted cell still prices at the base tier. The offer ends when `first_fill_complete` latches;
as of this deploy the board is 1,270 of 4,096 cells, so it is still open.

## Notes

- The web needs no change: `parseFreeFirst` reads `remaining`, and `admitTap` already admits a blank
  cell at 0 credits when it is free. The deployed `admin-catalog.ts` copy only affects `/admin`.
- `outstanding credits` reads 117 — unspent prepaid credits. A `DeployContract` cannot touch the
  ledger; that number is unrelated to this change.
- The board's balance moved by ~0.084 NEAR across the window, which is the hourly keeper
  distribution (`withdrawable_near` reads 0), not the deploy: the deploy cost 0.000332 NEAR plus
  +2,139 bytes of storage (~0.000021 NEAR).
- No key was added or removed for this deploy. The ephemeral key described in the rehearsal doc was
  never granted and does not exist on chain.
