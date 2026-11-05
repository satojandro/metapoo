# Mainnet board upgrade — `get_board_version` (2026-11-06)

PR [#76](https://github.com/satojandro/metapoo/pull/76) merged as `7edcdec`. Its contract half is now
on the live testing board and its web half is on https://metapoo-testnet.vercel.app. This is the chain
evidence the PR asked for under *Deploying the contract*.

## Artifact

| | |
|---|---|
| source | `7edcdec` (merge of #76 into `main`) |
| build | `cargo near build non-reproducible-wasm` |
| size | 441,944 B (the artefact deployed on 2026-11-05 was 441,213 B; +731 B) |
| sha256 | `7780758a37519b81160eb5a3a064e6681a84eded50f1a6a757d71772dd378eef` |
| deployed to | `fcd66acf517ad5d77f4814ad939b2b69b4ab2529e8332fbbeb3aaed63076f59e` (mainnet testing board) |
| tx | `2t1cApxbrgk3BB7Bb6aL5bt69bdLmorZCsQyAsYZJHZw` — 3.4 Tgas, fee 0.000330 NEAR |
| code hash before → after | `2NPcAgVPuUY3w1jNno69ozsDRQPYZ2sYqZxeYMStou4W` → `93V8Jh43r8HYpkq8JAp8A5dpJKrgGyjwSZhzCu3iBiB8` |

Deployed with the board account's **own full-access key**, not `upgrade()`: `upgrade()` always runs
`migrate`, which rejects state already at version 2. Same path as the earlier `get_cell_costs`
code-only upgrade.

## State preserved (no migration)

| read | before deploy | after deploy |
|---|---|---|
| `get_state_version` | 2 | 2 |
| `get_board` | 64 × 64, schema 4 | 64 × 64, schema 4 |
| `get_pixels` total | 4 | 4 — same four cells, same artists |
| `get_board_version` | `MethodResolveError(MethodNotFound)` | `0` |

A board that has not painted under this code reads 0 and counts from there. Nothing in `Board`
changed, so no migration was needed or run.

## Version behaviour, on mainnet

| step | transaction | `get_board_version` |
|---|---|---|
| `draw(11, 10, 2, max_credits 1)` | `FssURozPBTwnsc83RbnBZzBGjpcB595Y4rjEQaFhJZqw` | 0 → 1 |
| `draw(47, 24, 5, max_credits 0)` — panics `PriceRoseAboveMax` | rejected | 1 → 1 |

The second call is the "a rejected paint leaves the counter alone" case: it panicked
`PriceRoseAboveMax: draw was rejected and no pixel was stored` and the version stayed at 1.
`get_pixels` total is now 5 — pixel `(11, 10)` colour 2, artist the board account.

Credits stayed at 4 across that paint, and that is correct: `get_free_first_paints` for the board
account now reads `used 2, remaining 23, allowance 25`. Empty cells are free under
`free_first_paints_per_account`, so no credit was due.

## Web

| | |
|---|---|
| deployment | `dpl_Ct1WgqUQofD4y8Rbq7aLGprRBu1Q`, production → https://metapoo-testnet.vercel.app |
| bundle check | the served `assets/app-BB8BMC62.js` contains both `get_board_version` and `fcd66acf…` |
| live page | status line reads `Board unchanged at block 223195311 (version 1).` |

That is the cheap-poll path working against the live board: one `get_board_version` call per poll,
and the full `get_pixels` walk only when the number moves.

## Not yet proven

- A credit-paying repaint on mainnet. The only paint since the upgrade was a free empty-cell one.
- `draw_many` moving the counter by exactly one: unit-tested, not exercised on mainnet.
- The 10-minute idle pause in a tab left alone — needs wall-clock time, not a test.
- Anything about the keeper or its read paths; this change did not touch them.
