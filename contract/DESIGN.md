# Game contract design note

Status: Open wall is **accepted** in `docs/00-shared-decisions.md`. The live implementation is `contracts/board` (schema version 1). It must not be deployed until an explicit review.

This note keeps the longer-term design context (storage costs, future paging, pause questions).

## Language choice

Use Rust and the official NEAR SDK (`near-sdk`).

NEAR contracts are small programs compiled to WebAssembly. Rust is the usual way to write them. The page is TypeScript, so the shared checks in `shared/` are the browser's copy of the rules. The contract must repeat those checks. The browser cannot be trusted: anyone can skip the page and call the contract.

## What one pixel means

A pixel is one cell on a 128 by 128 wall.

- Column `x` starts at 0 on the left and ends at 127.
- Row `y` starts at 0 on the top and ends at 127.
- A color is a palette index from 0 through 7, matching `shared/palette.ts` and `shared/board.json`.
- Palette index 0 is Ink. An unpainted cell is not color 0; it is the absence of a record.
- The account that last succeeded at writing the pixel is the current artist. That is credit on the wall. It is not a claim of legal ownership or copyright.

Empty cells are the absence of a record. The contract should not create 16,384 pixel records at deployment. A read of a missing cell returns "empty": no color, no artist, no write time.

## Implemented today (`contracts/board`)

| Method | Kind | Behavior |
|---|---|---|
| `new` | init | Empty board, schema 1 |
| `get_board` | view | Width, height, origin, `overwrite_rule: "open_wall"`, sponsorship false, palette |
| `get_pixel` | view | Painted cell or empty nulls; out-of-range panics |
| `draw` | call | Any predecessor may write any in-range cell with a valid color |

Local check: `cargo test` inside `contracts/board`.

## Stored state for a painted cell

A painted pixel can store:

| Field | Plain meaning |
|---|---|
| `x`, `y` | Which cell. The storage key, not a separate guess. |
| `color_index` | `u8` in the range 0..7 |
| `artist` | Account id of the latest successful writer |
| `last_write_timestamp_ns` | Block time of that write, from the chain, in nanoseconds |

Do not store a tenure balance, a points balance, or a token amount.

`env::block_timestamp()` is the clock to use. It is the block time, not the player's computer clock.

## Suggested methods after the rule is chosen

Names can be adjusted to the SDK's style. The behavior should stay this small.

| Method | Kind | Behavior |
|---|---|---|
| `get_board` / `get_metadata` | view (free read) | Width, height, palette, policy name, sponsorship flag (false) |
| `get_pixel` | view | One cell, or an explicit empty result |
| `get_pixels` | view | Painted cells only, paged if a full list gets large |
| `draw` | call (signed transaction) | One cell and one palette index, after the agreed rule |

`draw` arguments, as JSON the page would send:

```json
{ "x": 3, "y": 4, "color_index": 2 }
```

A successful change should emit one event with the cell, new color, new artist, previous artist (or none), and the block timestamp. One event per successful write. Not one event per cell on the wall.

The page may refresh by calling `get_pixel` after the transaction succeeds. The event helps later history. History paging is optional for the first demo; the current artist and last write time are enough to explain the cell.

## What `draw` must reject

- `x` or `y` outside 0..127
- `color_index` outside 0..7
- A caller who is not allowed by the chosen overwrite rule
- Anything other than one cell per call

There is no admin method in this proposal. That means there is also no pause button. Before any public deploy, decide whether the deployer needs a pause. A pause is a power: the account that holds it can stop the game. Write that account down if you add it.

## Storage, in plain language

NEAR makes a contract lock up a little NEAR for the bytes it stores. The usual planning figure is about 0.00001 NEAR per byte. Confirm the current protocol price in the NEAR docs before telling a user a fee, and measure this contract before quoting a number. This paragraph is a planning sketch, not a measurement.

If every cell were stored up front, the contract would pay for cells nobody has painted. Skipping empty cells means storage grows only when someone successfully paints. A painted cell needs an account id (up to 64 characters) plus a few small numbers, and the collection that holds it has its own overhead. Expect a small fraction of a NEAR per new cell, then measure.

Gas is the fee for computation. One `draw` should touch one cell and emit one event. It should not loop across the whole wall.

The player's wallet pays that network gas on the ordinary path. The game does not add its own fee. Sponsorship stays off.

## Local checks the contract agent should write first

Once a rule exists, test at least:

- First paint on an empty cell
- A second paint that the rule allows
- A second paint that the rule rejects
- Column 128 and color 8
- The stored artist and timestamp match the event
- A call does not mint, transfer, or require MPOO or extra NEAR

Run those on a local sandbox. A passing local test is not a testnet or mainnet result.

## Deliberately absent

No token transfer, no application fee, no treasury, no sponsorship signer, no NEAR Intents, no upgrade implementation, and no deployment instructions that contain keys.
