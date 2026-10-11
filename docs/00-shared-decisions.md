# Shared decisions

Date: 11 October 2026

This file is the integration record. Contract and frontend work stay on the mock until the overwrite section below changes from **open** to **accepted** and names one rule.

## Repository at the start of this work

The repository was not empty. It contained the agent pack (`README.md` and `01` through `09`) and no package manifest, contract, wallet setup, tests, or frontend. Those notes are the starter. This scaffold builds on them.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Page | Vite and TypeScript, no React yet | A small dev server and one language. The first page has no runtime dependencies. |
| Shared checks | TypeScript in `shared/` | The same rules run in the page and in Node tests. |
| Future contract | Rust and `near-sdk`, not created yet | NEAR contracts compile to WebAssembly. Rust is the usual tool, and it is already installed. Creating the crate now would force an overwrite rule into code. |
| Wallet | Practice session only | A real NEAR wallet is a later adapter behind the same session shape. This page does not open one. |
| Dev network | `mock` | Practice data in the browser. |
| Public rehearsal | testnet, later | Required by the pack before any mainnet use. |
| Intended public network | mainnet | Supplied context. Nothing here is deployed there. |

## Design assumptions used by the mock

These are provisional so the page can render. They are easy to change before a contract exists. They are not the overwrite rule.

- The wall is 128 by 128 cells.
- Column 0 is the left edge. Row 0 is the top edge. Numbers increase to the right and downward.
- Colors are palette indices 0 through 7, named in `shared/palette.ts`. The contract would store the index. The hex value is for the browser.
- An empty cell has no stored record.
- The page shows the latest artist as credit, not as legal ownership of the picture.
- Gas sponsorship is off. The type in `shared/types.ts` allows only `false`.
- The ordinary path, later, is a normal wallet transaction. The player may still pay network gas. The game adds no fee.
- One drawing action paints one cell with one palette color.

## Open: who may overwrite a pixel

The product owner has not decided. Do not encode a rule in the contract or in the page's success path.

Three options:

### 1. Open wall

Any connected account may paint any cell, including a cell someone else painted. The latest successful writer is the current artist. The same account may recolor their cell.

- Fits a public graffiti wall and is the smallest rule to explain and test.
- Vandalism is easy. A person can cover the whole wall.
- A later tenure interval would end when a different account successfully writes.

### 2. First claim sticks

The first successful writer is the only account who may change that cell. Nobody else can overwrite it. The owner may recolor.

- Easy to say: "you keep what you claim."
- The wall can fill up and freeze. A griefer can claim every cell and leave it.
- Needs a later takeover or expiry rule, or the board stops being a shared wall.

### 3. Claim with expiry

The writer controls the cell until a time limit. After expiry, another account may claim it. The owner may recolor during the window.

- Leaves room for new painters without letting every passersby overwrite live work.
- Too many details for a first Sunday loop: how long is the window, does recolor reset it, whose clock (use the block timestamp), and what the page says while a claim is active.

**Recommendation, not a decision.** If the goal is the smallest Sunday loop, pick option 1 and say the vandalism risk in the rules panel. If keeping a painting matters more than shipping the loop, pick option 3 and expect a longer contract. Option 2 feels like ownership and can permanently lock the wall.

This scaffold follows none of the three. `reasonDrawIsBlocked` returns `OWNERSHIP_RULE_UNRESOLVED` for a valid cell, and the page does not ask a wallet to sign.

### Choices that ride along with the rule

Answer these in the same decision, or the contract and the page will guess differently:

- May the current artist recolor? Recommendation: yes, under every option above.
- What does the stored time mean? Recommendation for the MVP: time of the latest successful write. Do not also store a tenure start unless a tenure display is requested.
- Same-artist recolor and a future tenure clock: the pack's later idea is that a recolor by the same artist does not restart that clock. Do not implement the clock now.
- What ends a claim? Option 1: another account's successful write. Option 2: nothing, unless you add a new rule. Option 3: the expiry time, or a successful claim after expiry.

## Tenure and payments

No token payout, no points payout, and no tenure score in this scaffold. A later tenure experiment has to define the interval start, the interval end, recolor behavior, per-pixel and per-account and season caps, the reward asset, and the funding source before any payout code.

Supplied context, not checked against chain state, and not used by this code:

- MPOO account: `mpoo.nearlytrade.near`
- Deployer account: `meta-poo-shitcoin.near`
- Intended network: NEAR mainnet
- Reported tax: 2% buy / 3% sell

Those identifiers are not the game contract. Do not point the pixel contract at the token account.

## Proposed interface

TypeScript shapes live in `shared/types.ts`. A future Rust contract should match this behavior.

Reads:

- `get_metadata()` → width, height, palette size, network, contract id or none, `sponsorshipEnabled: false`, `overwritePolicy`
- `get_pixel(x, y)` → `PixelView`, with nulls when the cell has never been successfully written
- `get_pixels` → painted cells only, paged if needed

Write:

- `draw({ x, y, colorIndex })` → a `DrawResult`
- `rejected` means nothing was submitted
- `pending` means a transaction exists and is not confirmed yet
- `success` is allowed only after the transaction result is observed, followed by a fresh read
- `failed` means a transaction was observed and did not succeed, or the receipt failed

Example future arguments:

```json
{ "x": 3, "y": 4, "color_index": 2 }
```

Example of a cell after a real success (not produced by this scaffold):

```json
{
  "x": 3,
  "y": 4,
  "color_index": 2,
  "artist_account_id": "alice.testnet",
  "last_write_timestamp_ns": "1700000000000000000"
}
```

`getPixelHistory` is deferred. The current artist and last write time are enough for the first demo.

There is no payment method and no sponsor method.

## File ownership for the next agents

| Path | Who may edit | Note |
|---|---|---|
| `docs/00-shared-decisions.md` | Coordinator | Accept the overwrite rule here before coding it |
| `docs/threat-sketch.md` | Coordinator | Update when a rule or a sponsor design appears |
| `shared/**` | Coordinator | Agents propose changes; they do not edit this in parallel |
| `contract/**` | Contract agent | After the rule is accepted. `DESIGN.md` is the proposal |
| `frontend/**` | Frontend agent | After the interface is accepted. Today it is a mock |
| `docs/research/**` | Chain-abstraction agent | Not created. Memo only, no MVP code |
| `01`–`09` markdown pack | Coordinator | Leave the briefs intact |

## Definition of done for this foundation

- The overwrite choice is written down as open, with options and a recommendation.
- The page can show the wall, a palette, a practice session, and a blocked draw with a readable reason.
- Local tests cover bounds, palette, the unresolved rule, a disconnected session, and a network mismatch.
- No transaction is sent. Sponsorship stays off. No token code.

The Sunday loop (a real wallet and a confirmed on-chain paint) starts after the overwrite rule is accepted.
