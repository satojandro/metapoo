# Storage and gas (beginner notes)

Plain-language notes for the Open wall contract. These are **planning sketches**, not a bill from the chain. Measure on testnet before telling a player an exact fee.

## Storage staking, in one sentence

NEAR makes a contract lock a little NEAR for the bytes it keeps. More painted pixels → more locked NEAR. Deleting data can unlock some of it later; this MVP does not delete pixels.

## Why empty cells are free

The board is 128 × 128 = **16,384** cells. If we stored every cell at deploy time, the contract would pay storage for blank wall. Instead, only cells that someone successfully paints are stored in a map. Unpainted cells are “missing,” and `get_pixel` returns nulls.

## What one painted cell stores

Roughly:

- palette index (`u32`)
- artist account id (a string; longer names cost more)
- write time in nanoseconds (`u64`)
- map overhead for the key (`y * 128 + x`)

A common planning figure in NEAR docs is on the order of **~0.00001 NEAR per byte** of storage staking. Confirm the current protocol figure in the official NEAR docs before quoting users. Expect **a small fraction of a NEAR per new cell**, then measure with your account after a few test paints.

## Gas, in one sentence

Gas is the fee for **computation** on a call. The player’s wallet pays network gas on the ordinary path. This game adds **no** extra NEAR or MPOO fee.

## What `draw` should cost in work

One `draw`:

1. checks bounds and palette
2. writes one map entry
3. logs one short event string

It must not loop over the whole board. That keeps gas bounded.

Views (`get_board`, `get_pixel`) are reads. They are not signed transactions. They still use node resources, but the player is not signing a wallet popup for them.

## Sponsorship

Off. There is no sponsor key in this repo. Do not add one in the browser.

## Security concerns to remember

| Concern | Note |
|---|---|
| Page is not the authority | Anyone can call `draw` with a wallet; the contract must enforce bounds and Open wall. |
| Open wall vandalism | Accepted product risk. |
| No pause | Decide before a public launch whether you need an admin pause. |
| Wrong contract id | Never point the game at the token account. |
| Fake success | UI must wait for an observed transaction + read. |

## What we verified in this repository

| Check | Environment | Result meaning |
|---|---|---|
| `cargo test` in `contracts/board` | **local** | Logic for paint, overwrite, recolor, rejects |
| WASM build / testnet deploy | **not done in-repo** | Follow `DEPLOY.md` on your machine |
| Mainnet | **forbidden here** | Do not claim live mainnet verification |
