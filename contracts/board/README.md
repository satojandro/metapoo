# Board contract (free Open wall, schema 2)

Retired as a product. It is kept as the testnet fixture at `wall.berrywall1.testnet`, with 2,301 painted cells.
The product board is [the schema-4 paid board](../paid-board/README.md).

A sparse 128×128 board with an 8-colour palette. It runs an Open wall rule: anyone may overwrite any cell, and
painting is free. Every painted cell stores its colour, its artist and its write time. `cargo test` passes locally;
that result is not evidence from a chain.

## Methods

| Method | Kind | Behavior |
|---|---|---|
| `new()` | init | Empty board |
| `get_board` | view | Schema 2 metadata and palette |
| `get_pixel(x, y)` | view | One cell; null fields when unpainted |
| `get_pixels(from_index, limit)` | view | Painted cells, each exactly once; `limit` clamped to 256; follow `next_from_index` |
| `draw(x, y, color)` | call | Paint one cell |
| `draw_many(cells)` | call | Up to 64 cells, all or nothing |

## Read next

- `FRONTEND_HANDOFF.md`: the view and call shapes the page relies on
- `STORAGE_AND_GAS.md`: measured storage per cell
- `DEPLOY.md`: WASM build and testnet steps, with no keys in git

History: a schema-3 design with regional pressure pricing, quotes with `max_cost`, and paint sessions lived here
until 2026-10-28. It is in git history under the tag `archive/pre-cleanup-2026-10-29`.
