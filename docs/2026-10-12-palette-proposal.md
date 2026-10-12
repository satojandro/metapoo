# Saturated palette proposal — 12 October 2026

Inspired by the Sydney stall references (dark grounds, vivid cyan/blue/yellow/green/red/pink). **Not implemented yet.** Changing hex values for existing indices would recolor stored art; a coordinated schema bump is required.

## Proposed schema 3 swatches (same 8 indices)

| Index | Name | Current hex | Proposed hex | Notes |
|---|---|---|---|---|
| 0 | Ink | `#1c1917` | `#0a0a0c` | Near-black ground |
| 1 | Paper | `#f4efe4` | `#f7f4ef` | Light highlight |
| 2 | Brick | `#b23a2f` | `#ff3b30` | Saturated red |
| 3 | Marigold | `#e0a100` | `#ffd60a` | Saturated yellow |
| 4 | Moss | `#3d7a4a` | `#34c759` | Saturated green |
| 5 | River | `#2f6f8f` | `#0a84ff` | Saturated blue |
| 6 | Grape | `#6b4c7a` | `#bf5af2` | Saturated pink/violet |
| 7 | Clay | `#c47b5a` | `#64d2ff` | Cyan accent (name may become Cyan) |

## Compatibility plan

1. Bump `schema_version` to 3 in `shared/board.json`, `shared/palette.ts`, and `contracts/board`.
2. Deploy a new contract (or migration) that returns the new palette from `get_board`.
3. Frontend `validateContractMetadata` already rejects palette hex drift — ship frontend + contract together.
4. Document that existing painted cells keep their indices but will **display** as the new colors after upgrade (visual reinterpretation of history). If that is unacceptable, keep indices reserved and add new indices 8+ instead (requires contract storage change).

Do not silently change palette hex in production without this coordinated step.
