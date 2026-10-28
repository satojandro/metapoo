# Shared decisions

Created: 11 October 2026. Updated: 28 October 2026.

This file is the integration record. The overwrite rule below is **accepted and implemented locally**. The economy decisions below describe the next phase, not live contract behavior.

## Current payment stage — accepted 28 October 2026

This stage supersedes the older MPOO-only / TOILET purchase mechanics below.
Users buy non-transferable paint credits with **native NEAR or mPOO**. One credit
pays for one pixel placement, with no expiry. The launch price is **0.0069 NEAR**;
owner configuration remains supported and mPOO launch pricing is still unset.
Start with **Buy mPOO on NEARLY**, not an embedded swap or inventory shop.
The app must show pixel prices, available credits and NEAR/mPOO wallet balances;
see the accepted [frontend handoff](payments/frontend-handoff.md).

The separate schema-4 contract is local work, not deployed frontend behavior.
The owner confirms **no mainnet deployment yet**. [Mainnet cost validation](payments/mainnet-cost-validation.md)
is an open post-deployment gate. [Upgrade policy](payments/upgrade-policy.md) remains
a proposal: migration/control mechanisms are not implemented. Staking, longevity,
TOILET, revenue sharing and inventory trading remain a subsequent stage.

### Ratified by the owner — 2026-10-28

- **D1 — one paid model: prepaid credits, schema 4.** Schema 3, its mock pressure quotes and
  `payment-provider.ts` are deleted. The page accepts schema 2 (legacy free board) and schema 4
  (paid board) only.
- **D2 — one paid board, on mainnet.** `contracts/paid-board` is the wall; `contracts/board`
  (schema 2) is retired as a product and kept as the testnet fixture. The 2,301-pixel testnet
  mural does **not** migrate; the mainnet wall starts empty and is seeded deliberately.
- **D3 — pricing stays per pixel.** Storage is charged per pixel, so a flat per-stroke price
  cannot cover a full-length drag. Launch price comes from the table in the decision record.
  The free-paint-window idea is recorded there in its safe form (empty cells only, per-account cap).

Evidence and the full contradiction list: [paid model v1 decisions](payments/2026-10-28-paid-model-decisions.md).

## Product expansion: approved direction, proposed mechanics

The user selected three product pillars: demand-sensitive placement pricing, chosen historical NFT prints, and funded **Art Bounties** that communities rally around. Mystery cards are explicitly excluded. Audience order is mPOO/NEAR communities, other crypto communities, then broader pixel-art audiences. Creation builds attachment; defence supports return visits. Creative freedom remains compatible with mPOO's cheeky rivalry with Meta Pool.

The [full PRD](2026-10-12-product-prd.md) and [agent delivery plan](implementation/delivery-plan.md) now own the expansion scope. Regional pressure parameters, numbered print policies, sponsor-judged escrow mechanics and service trust choices are **proposed prototype defaults**, not separately confirmed mainnet settings. R1 stages the existing economy: paint purchase/spending first, with longevity/staking/shop implementation deferred rather than cancelled. No new product capability is enabled by this documentation update.

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
| Board picture today | Paginated `get_pixels` when `VITE_CONTRACT_ID` is set; empty mock otherwise | Refresh reloads every painted cell. |
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
- Tenure / reward clock: **not implemented** in the free milestone. Next-phase changes are specified in the economy plan.
- What ends a claim under Open wall: **another account’s successful write** (or the same account’s recolor, which updates artist credit and timestamp).

## Tenure and payments

No token payout, no points payout, and no tenure score in this scaffold.

Read-only mainnet observations, not used by the current board code:

- MPOO account: `mpoo.nearlytrade.near`
- MPOO launch creator: `meta-poo-shitcoin.near` (not proof of the game deployer)
- Intended network: NEAR mainnet
- Configured tax: 2% buy / 3% sell; burn and holder allocations recorded in the [MPOO evidence](research/2026-10-12-mpoo-live-contract-readout.json). Actual transfers/refunds/burns have not been trialled.

Those identifiers are not the game contract. Do not point the pixel contract at the token account.

### Historical economy direction — payment rules superseded above

- Paid paint purchases use **MPOO only**, replacing the earlier NEAR/MPOO choice and its 20% price comparison.
- Pixels earn bounded **TOILET**, which is spent/burned as paint. No third independent paint-credit currency is planned.
- Users stake **MPOO**, explicitly confirmed by the user, and receive net game revenue **in MPOO** after a disclosed operating reserve and liabilities. This replaces earlier TOILET staking and NEAR-only payout proposals. *(Contested 2026-10-28: the owner now proposes staking **TOILET** for the same revenue. Both cannot claim it — see [TOILET economy v1](economy/2026-10-28-toilet-economy-v1.md) §4. Decision pending.)*
- Competitive repeated painting should consume more paint units than pixels issue. The economy must also have explicit reward caps for quiet/cooperative/bot-dominated play.
- A separate NEAR-to-MPOO premium inventory shop and bounded replenishment executor are under investigation. NEAR buys MPOO there; it does not directly buy game paint. No premium, budget or live execution configuration is chosen.

The [economy plan](2026-10-12-paint-economy-and-swap-plan.md) is the single implementation-planning document. It contains contract boundaries, interfaces to specify, migration, failure recovery, tests and unset economics. Updating these product decisions does not enable payments in the current free contract.

## Interface (accepted for Open wall)

TypeScript shapes live in `shared/types.ts`. The Rust contract in `contracts/board` implements the first version.

Reads:

- `get_board()` → width, height, origin, `overwrite_rule: "open_wall"`, sponsorship false, palette, schema version
- `get_pixel(x, y)` → color / artist / written time, or nulls when never written
- `get_pixels(from_index, limit)` → one page of currently painted cells (latest color/artist after overwrites; each cell at most once). Cap `limit` on chain. Call again with `next_from_index` until null.

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

History paging (past colors / past artists) is still deferred. `get_pixels` only returns the current painted set.

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
