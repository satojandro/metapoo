# Board contract (Open wall)

This folder is a NEAR contract written in Rust. Schema version 1. It describes a 128 by 128 board, stores painted cells sparsely, and lets any caller paint any in-range cell.

Do not deploy it until an explicit review. Local `cargo test` is not a testnet or mainnet result.

## Words that matter

- A **view method** (`get_board`, `get_pixel`) reads data. It is not a transaction.
- A **change method** (`draw`) is what a wallet sends as a transaction.
- **Open wall** means the predecessor account may paint any cell. The latest writer is the current artist.
- **Storage** is data the contract keeps. Empty squares are not stored. They are the default answer from `get_pixel`.

## Checks

From this folder:

```bash
cargo test
```

That runs on your computer. It does not start a NEAR node and it does not prove the WASM build. The crate enables the `unit-testing` feature so host tests can compile. A real deploy later needs `cargo near build` (or the `wasm32-unknown-unknown` target).

## Methods

| Method | Kind | Behavior |
|---|---|---|
| `new` | init | Empty board, schema 1 |
| `get_board` | view | Size, palette, `overwrite_rule: "open_wall"` |
| `get_pixel` | view | One cell, or empty nulls |
| `draw` | call | Store color, predecessor as artist, block timestamp |

## Not in this crate

No token transfers, fees, treasury, sponsor keys, admin account, pause switch, or pixel history paging.
