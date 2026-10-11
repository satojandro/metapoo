# Shared decisions

Date: 11 October 2026

This file is the integration record. The overwrite rule below is **accepted**.

## Repository at the start of this work

The repository began with the agent pack (`README.md` and `01` through `09`) and no package manifest, contract, wallet setup, tests, or frontend. The scaffold below builds on that pack.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Page | Vite and TypeScript in `web/` | A small local server and one language for the first board. |
| Shared checks | TypeScript in `shared/` | The same bounds, palette, and overwrite checks run in Node tests and in the page. |
| Game contract | Rust and `near-sdk` in `contracts/board` | Open-wall `draw` with sparse pixel storage. Local tests only so far. Do not deploy until an explicit review. |
| Design note | `contract/DESIGN.md` | Longer-term shape and storage notes. |
| Wallet | `@hot-labs/near-connect` on **testnet** | Connect and disconnect work. A draw is only sent after a contract account is configured. |
| Board picture today | Local empty mock until a contract id is set | Not chain state until reads are wired to a deployment. |
| Public rehearsal | testnet, later | Required by the pack before any mainnet use. |
| Intended public network | mainnet | Supplied context. Nothing here is deployed there. |

## Design assumptions

- The wall is 128 by 128 cells.
- Column 0 is the left edge. Row 0 is the top edge. Numbers increase to the right and downward.
- Colors are palette indices 0 through 7, named in `shared/palette.ts` and `shared/board.json`. The contract stores the index. The hex value is for the browser.
- Palette index 0 is **Ink**, a real paint color. An unpainted cell is the absence of a record, not color 0.
- An empty cell has no stored record.
- The latest successful writer is shown as credit (current artist), not as legal ownership of the picture.
- Gas sponsorship is off.
- The ordinary path is a normal wallet transaction. The player may still pay network gas. The game adds no fee.
- One drawing action paints one cell with one palette color.

## Accepted: who may overwrite a pixel

**Status: accepted — Open wall** (`overwrite_rule: "open_wall"`).

Any connected account may paint any cell, including a cell someone else painted. The latest successful writer is the current artist. The same account may recolor their cell.

Known tradeoff: vandalism is easy; someone can cover the whole wall. That risk is accepted for the smallest Sunday loop and must be stated in the rules panel.

Rejected for now:

- **First claim sticks** — can permanently freeze the wall.
- **Claim with expiry** — too many clock details for this milestone.

### Ride-along choices (accepted with Open wall)

- Current artist may recolor: **yes**.
- Stored time: **block time of the latest successful write** (`written_at_ns` / `last_write_timestamp_ns`). No separate tenure-start field.
- Tenure / reward clock: **not implemented**. Do not add payout logic.
- What ends a claim under Open wall: **another account’s successful write** (or the same account’s recolor, which updates artist credit and timestamp).

## Tenure and payments

No token payout, no points payout, and no tenure score in this scaffold.

Supplied context, not checked against chain state, and not used by this code:

- MPOO account: `mpoo.nearlytrade.near`
- Deployer account: `meta-poo-shitcoin.near`
- Intended network: NEAR mainnet
- Reported tax: 2% buy / 3% sell

Those identifiers are not the game contract. Do not point the pixel contract at the token account.

## Interface (accepted for Open wall)

TypeScript shapes live in `shared/types.ts`. The Rust contract in `contracts/board` implements the first version.

Reads:

- `get_board()` → width, height, origin, `overwrite_rule: "open_wall"`, sponsorship false, palette, schema version
- `get_pixel(x, y)` → color / artist / written time, or nulls when never written

Write:

- `draw(x, y, color)` → signed change method; any predecessor may write any in-range cell with a valid palette index

Page-side `DrawResult` statuses after a real submit path exists:

- `rejected` — client checks failed; nothing submitted
- `pending` — transaction exists and is not confirmed yet
- `success` — only after an observed transaction result and a fresh read
- `failed` — transaction observed and did not succeed

Example arguments:

```json
{ "x": 3, "y": 4, "color": 2 }
```

(`color` is the palette index. The page types may still say `colorIndex`.)

Example cell after a real success:

```json
{
  "x": 3,
  "y": 4,
  "color": 2,
  "artist": "alice.testnet",
  "written_at_ns": 1700000000000000000
}
```

`get_pixels` / history paging is deferred.

There is no payment method and no sponsor method.

## File ownership for the next agents

| Path | Who may edit | Note |
|---|---|---|
| `docs/00-shared-decisions.md` | Coordinator | Overwrite rule is accepted; further product changes land here first |
| `docs/threat-sketch.md` | Coordinator | Update when sponsor design appears |
| `shared/**` | Coordinator | Agents propose changes; they do not edit this in parallel |
| `contracts/board/**` | Contract agent (05) | Open-wall implementation + handoff/deploy docs; no silent mainnet deploy |
| `contract/DESIGN.md` | Contract agent / coordinator | Broader design notes |
| `web/**` | Frontend agent (06) | Wire reads/writes using `contracts/board/FRONTEND_HANDOFF.md`; no fake success |
| `docs/research/**` | Chain-abstraction agent | Memo only, no MVP code |
| `01`–`09` markdown pack | Coordinator | Leave the briefs intact |

## Definition of done for this decision

- Open wall is written as accepted, with ride-along choices.
- `shared/board.json`, TypeScript, the page rules text, and the contract all say `open_wall`.
- Contract unit tests cover first paint, overwrite by another account, recolor, and rejects for bad coordinates/colors.
- The page still does not claim a chain success without a configured contract and an observed transaction.
- Sponsorship stays off. No token code. No deploy in this step.
