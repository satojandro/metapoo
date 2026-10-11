# Board contract (holding build)

This folder is a NEAR contract written in Rust. It is schema version 0. It can describe a 128 by 128 board and a palette of 8 colors. Every `draw` call stops with an error. No pixel is stored.

Do not deploy it. The overwrite rule is not chosen, and this build has not been run on testnet or mainnet.

## Words that matter

- A **view method** (`get_board`, `get_pixel`) reads data. It is not a transaction.
- A **change method** (`draw`) is what a wallet would send as a transaction. Here it always panics, and a panic rolls the call back.
- **Storage** is data the contract keeps. Empty squares are not stored. They are the default answer from `get_pixel`.

## Checks

From this folder:

```bash
cargo test
```

That runs on your computer. It does not start a NEAR node and it does not prove the WASM build. Building WASM needs the extra Rust target `wasm32-unknown-unknown`, which this scaffold did not install.

## Not in this crate

No token transfers, fees, treasury, sponsor keys, admin account, pause switch, or pixel history.
