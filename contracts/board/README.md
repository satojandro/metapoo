# Board contract (Open wall)

Rust NEAR contract, schema version 2. Sparse 128×128 board, 8-color palette, Open wall `draw`, paginated `get_pixels`.

Local `cargo test` is not a testnet or mainnet result. Do not deploy to mainnet from this repo’s docs.

## Read these next

1. `FRONTEND_HANDOFF.md` — method args/results for agent **06**
2. `DEPLOY.md` — WASM build and **testnet** deploy steps (no keys in git)
3. `STORAGE_AND_GAS.md` — beginner storage/gas and limitations
4. `../../contract/DESIGN.md` — longer design context

## Words that matter

- A **view method** (`get_board`, `get_pixel`, `get_pixels`) reads data. It is not a transaction.
- A **change method** (`draw`) is what a wallet sends as a transaction.
- **Open wall** means any predecessor may paint any cell. The latest writer is the current artist.
- **Storage** holds only painted cells. Empty squares are missing records.
- **`get_pixels`** pages that sparse set. Each painted cell appears once with its latest color and artist.

## Methods

| Method | Kind | Behavior |
|---|---|---|
| `new` | init | Empty board, schema 2 |
| `get_board` | view | Size, palette, `overwrite_rule: "open_wall"` |
| `get_pixel` | view | One cell, or empty nulls |
| `get_pixels` | view | Page of painted cells (`from_index`, `limit` ≤ 256) |
| `draw` | call | Store color, predecessor as artist, block timestamp |

## Local checks

```bash
cargo test
```

Host tests use the `unit-testing` feature of `near-sdk`. A real on-chain binary needs `cargo near build` / `wasm32-unknown-unknown` (see `DEPLOY.md`).

## Agent 05 status

| Deliverable | Status |
|---|---|
| Design note | Done (`DESIGN.md` + this folder) |
| Implementation + focused tests | Done (local), including `get_pixels` |
| Example calls for frontend | Done (`FRONTEND_HANDOFF.md`) |
| Storage/gas in plain language | Done (`STORAGE_AND_GAS.md`) |
| Local/testnet deploy instructions | Done (`DEPLOY.md`) — not executed in-repo |
| Mainnet deploy | Out of scope |

## Not in this crate

No token transfers, fees, treasury, sponsor keys, admin pause, or past-color history paging.
