# Build and deploy (testnet only)

This document finishes the contract-agent deploy deliverable. It does **not** deploy for you. It does **not** include private keys. **Do not deploy to mainnet** from this guide.

Verification labels:

- Local: `cargo test` on your computer.
- Testnet: only after you build WASM, create/fund a testnet account, and deploy.
- Mainnet: out of scope here.

## Tools to install (once)

On the machine that will build and deploy:

```bash
# Rust WASM target
rustup target add wasm32-unknown-unknown

# Official helper for NEAR contracts (recommended)
cargo install cargo-near

# NEAR CLI (command shape varies by version; check `near --help`)
# Install from https://docs.near.org / the near-cli-rs releases for your OS
```

This repo’s maintainer machine may not have `cargo-near` or `near` installed yet. Install them before a real deploy.

## Local verification (already the default)

```bash
cd contracts/board
cargo test
```

Passing local tests proves the Open wall logic in a simulated host environment. It does **not** prove WASM size, gas on chain, or storage staking on testnet.

## Build WASM

From `contracts/board`:

```bash
cargo near build non-reproducible-wasm
```

If `cargo near` is unavailable, a manual fallback (may need extra flags for your SDK version):

```bash
cargo build --release --target wasm32-unknown-unknown
```

Prefer `cargo near build` when possible. Note the output `.wasm` path the tool prints.

## Create a testnet contract account

Use a **new** testnet account for the game board. Do not reuse the MPOO token account.

High-level steps (exact flags depend on your CLI version):

1. Create or log in a funded testnet account you control (the deployer).
2. Create a sub-account for the board, for example `board.<your-account>.testnet`.
3. Keep the key material outside the git repo (never commit `.json` key files).

## Deploy and initialize

Deploy the WASM to the board account, then call the init method **once**:

- Init method: `new`
- Init args: `{}`

Example shape with near-cli-rs style commands (adjust to your installed CLI):

```bash
near contract deploy BOARD_CONTRACT.testnet \
  use-file path/to/metapoo_board.wasm \
  without-init-call \
  network-config testnet \
  sign-with-keychain \
  send

near contract call-function as-transaction BOARD_CONTRACT.testnet new \
  json-args {} \
  prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' \
  sign-as BOARD_CONTRACT.testnet \
  network-config testnet \
  sign-with-keychain \
  send
```

Some deploy flows combine deploy + init in one step. Use one init only; calling `new` again on an initialized contract should fail.

## Point the page at the contract

In `web/src/config.ts`:

```ts
export const PAGE_NETWORK = "testnet" as const;
export const CONTRACT_ID = "board.YOUR_ACCOUNT.testnet";
```

Then agent **06** can wire wallet `draw` calls. Until `CONTRACT_ID` is non-empty, the page correctly refuses to open a draw signature.

## Smoke checks after deploy

1. View `get_board` → `overwrite_rule` is `"open_wall"`, width/height 128.
2. View `get_pixel` on `(0,0)` → all nulls.
3. Call `draw` from account A with `{"x":0,"y":0,"color":2}`.
4. View `get_pixel` → color 2, artist A.
5. Call `draw` from account B on the same cell with another color → artist becomes B.

Record whether each step was local or testnet in your learning journal.

## Known limitations (say these out loud)

- No admin pause. A bad public deploy cannot be frozen by a special key.
- Open wall allows vandalism by design.
- No `get_pixels` paging yet; reading the whole wall means many `get_pixel` calls or a later feature.
- Event log is a simple `EVENT_JSON` string, not a finalized NEP standard review.
- Storage and gas numbers below are planning estimates, not measurements from your deploy.
- No mainnet instructions on purpose.
