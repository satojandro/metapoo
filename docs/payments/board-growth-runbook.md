# Growing a paid board (`expand_board`)

The paid board launches at **64 × 64** and can only grow, up to **128 × 128**. There is no
admin control for this yet, so the owner calls the contract from the CLI. This is the runbook
that makes the feature reachable, written after the testnet rehearsal below.

Decided 2026-11-05 (PR #67). A board never shrinks, so no painted cell can fall off it.

## Rules the contract enforces

| Rule | Failure code |
|---|---|
| Owner only | `OwnerOnly` |
| Exactly 1 yocto attached | `OneYoctoRequired` |
| The new side must be **larger** than the current one | `BoardCanOnlyGrow` |
| The new side must be ≤ 128 | `BoardTooLarge` |

The side is stored under the raw key `s`, is absent on boards deployed before growth existed
(board3, board5), and an absent key reads as 128 — those boards are unaffected and cannot be
shrunk. Pixels keep the fixed key stride 128, so growth never moves a cell.

## Procedure

Owner key required (the `payments.owner` account, not the deployment key unless they are the same).

```bash
ACCOUNT=board5.metapoo-player1.testnet      # the board
SIDE=96                                    # new side, see "How far to grow"

near contract call-function as-transaction "$ACCOUNT" expand_board \
  json-args "{\"side\":$SIDE}" \
  prepaid-gas '40 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as <owner-account> network-config testnet sign-with-keychain send
```

Then confirm, in order:

```bash
near contract call-function as-read-only "$ACCOUNT" get_board json-args '{}' network-config testnet now
near contract call-function as-transaction "$ACCOUNT" draw \
  json-args "{\"x\":$((SIDE-1)),\"y\":2,\"color\":7,\"max_credits\":10}" \
  prepaid-gas '40 Tgas' attached-deposit '0 NEAR' \
  sign-as <painter> network-config testnet sign-with-keychain send
near contract call-function as-read-only "$ACCOUNT" get_pixels \
  json-args '{"from_index":0,"limit":256}' network-config testnet now
```

`get_board` must report the new side, the draw on the new edge must succeed, and `get_pixels`
must still list the pre-growth cells at their old coordinates and colours. The page picks a
new size up on its next 4 s board poll — no reload needed (`refreshBoardFromContract` →
`setBoardSide` → refit).

## How far to grow

Double or step evenly (64 → 96 → 128) rather than +1. Each growth **raises the protected
storage reserve** by `new_cells × 664_000_000_000_000_000_000` yoctoNEAR (≈ 0.00066 NEAR per
cell, so 64 → 96 reserves ≈ 3.8 NEAR more and 96 → 128 another 4.9 NEAR). A board whose balance
cannot cover the new reserve reports `get_withdrawable_near` as 0 and stops distributing until
it is funded. Top the board up before a large step.

Growing also does not restart free first paints (F1). If the latch has already set, it stays set.

## Rehearsal record — 2026-11-05, testnet

Fresh account `board64.metapoo-player1.testnet`, wasm from PR #67 (sha256
`145671e9a37443c371aee5f5aed9a70d655095b3363d68e387bb87739c06e39b`). Deployed and exercised
end to end; this is the proof the merge rested on, not a plan.

| Step | Result |
|---|---|
| `get_board` on a fresh deploy | 64 × 64 |
| `draw(63,63)` | succeeded |
| `draw(64,0)` | `CoordinateOutOfRange` |
| `expand_board(32)` | `BoardCanOnlyGrow` |
| `expand_board(200)` | `BoardTooLarge` |
| `expand_board(96)` | succeeded, `CS21GJ8CDm8gRrcHTAQiRjj5fLETiFaWk5MGrV1NTrdm` |
| `get_board` after growth | 96 × 96 |
| `draw(95,2,7)` past the old edge | succeeded |
| `get_pixels` | `(63,63) color 1`, `(95,2) color 7`, total 2 — the old cell kept colour and coordinates |

## Still open

- No `/admin` control; the CLI is the only path until one is built.
- Launch emission rate: `toilet_per_cell_second` starts at 0. At 64² the per-tile rate for the
  same cap and duration is ~4× the 128² figure T1 was chosen against, so set it deliberately at
  deploy rather than leaving the default.
