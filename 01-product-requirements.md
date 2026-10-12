# 01 Product Requirements

## Product summary

Meta Poo is a playful public toilet wall where people connect a NEAR wallet and leave pixel graffiti on a shared board. The stall is the setting; the wall is a precise, flat communal canvas. Berry Club / NEAR Place is a technical reference for board engineering patterns (refresh, pending paint, function-call drawing sessions) and inspiration for communal pixel competition. Reddit r/place is the primary interaction reference for zoom, pan, and screen-sized paint targets. The implementation should be a modern, original product, not a direct fork or a copy of Berry Club's code, assets, or distinctive presentation.

The MVP should prove the basic loop: explore the wall (zoom and pan), connect a wallet, choose a pixel and color, place paint with clear status, receive a clear result, and see others' confirmed work update automatically. Keep the first release achievable by limiting the board to a provisional 128 by 128 pixels, using a small palette, and postponing payments and cross-chain features. Free means no in-game fee; an unsponsored NEAR transaction may still require the user's wallet to pay network gas.

See `docs/2026-10-12-viewport-and-interaction-brief.md` for the current viewport and placement brief.

## Goals

- Make a shared pixel canvas fun and understandable within the first minute.
- Give each pixel an on-chain owner or equivalent durable claim, with the exact ownership rule documented before implementation.
- Let users draw without paying MPOO or NEAR as an application fee in the MVP.
- Make wallet actions understandable, recoverable, and visibly confirmed.
- Use carefully capped gas sponsorship only if its design can be made safe and a sponsor is available; the game must still have a clear non-sponsored path.
- Keep token, treasury, and chain-abstraction features behind replaceable interfaces.

## Non-goals for MVP

- MPOO or NEAR payment, trading, buybacks, creator royalties, or token burns.
- DEX integrations, token price display, token staking, or promises of value.
- MPDAO treasury custody or automated revenue allocation.
- NEAR Intents, bridging, cross-chain settlement, or multi-chain wallets.
- Moloch-style rage quit or any user withdrawal from a shared treasury.
- A large open-ended canvas, complex drawing tools, private messages, or a marketplace.
- Claims that artwork is permanent, censorship-proof, or owned in a legal or copyright sense without an explicit, reviewed definition.

## Primary user journey

1. A visitor sees the board and a short explanation of how a pixel claim works.
2. The visitor connects a supported NEAR wallet or continues in read-only mode.
3. The user chooses one pixel and a color from a limited palette.
4. The interface shows the pixel, intended action, network, and any gas or sponsorship disclosure.
5. The user confirms in the wallet, or the sponsored flow signs only the scoped action after an explicit user gesture.
6. The interface shows pending, success, or failure using the transaction result; it never treats a click as confirmation.
7. The board refreshes from the authoritative game state. The user can inspect the transaction reference and pixel history if implemented.

## User types

- Visitor: explores the board without connecting a wallet.
- Graffiti artist: claims or updates pixels under the game rule.
- Sponsor operator: funds a bounded gas budget and monitors use.
- Maintainer: deploys, pauses, upgrades, or administers contracts under documented controls.
- Future treasury participant: outside MVP; later phases may define governance and withdrawal rights.

## Product rules to decide before coding

The board size is provisionally 128 × 128. Decide whether one pixel is one claim, whether an existing owner may recolor their pixel, whether another user may overwrite it, whether claims are permanent or time-limited, and whether colors are restricted. For Sunday MVP, prefer one explicit, easy-to-explain rule set and encode it consistently in contract, frontend, and tests. Do not silently invent a fee or a token requirement.

## Pixel takeover and tenure rewards

The overwrite rule is not decided. Choose who can replace a pixel, whether the current artist may recolor it, what ends a claim, and whether the interface credits the current or most recent artist.

A candidate Sunday rule is that any connected user may overwrite any pixel, with the latest successful writer shown as the current artist. This keeps the wall open and is simple to explain, but it allows vandalism. An alternative is owner-only recoloring with a separately defined takeover or expiry rule. These are options for the product owner to choose, not settled requirements.

Time-based token earnings were not previously specified. A concrete later-phase proposal is: each successful write records the current artist and start time; the next successful write by a different artist closes that interval; eligible tenure is `min(end time - start time, per-claim cap)`. A season cutoff closes any remaining intervals. Same-artist recolors should not restart the clock unless the product explicitly chooses that behavior. A finite season pool could then be divided among eligible artists in proportion to capped tenure, subject to per-account caps. This is a discussion model, not an agreed rule, and it needs anti-sybil and farming analysis.

Before any payout, define how empty pixels, downtime, duplicate writes, account switching, seasons, and same-artist recolors work, plus caps per pixel, account, and season. Prefer a visible tenure statistic or bounded points experiment before token payouts. Any token reward needs a fixed budget and an identified source; it must not accrue indefinitely or be assumed to mint MPOO. The reward asset and funding source are undecided.

For the MVP, the recommendation is to record the current artist and successful write time if useful, but make no token or points payout. Do not implement the overwrite rule until the product owner chooses it.

## Success measures for the first demo

- A new visitor can understand the rules and make a drawing action without coaching.
- The board has one source of truth and updates after an observed successful transaction.
- Wallet rejection, network mismatch, duplicate action, slow RPC, and failed transaction have understandable outcomes.
- The demo can be reset or redeployed through a documented safe process.
- Any sponsor is protected by explicit per-user, per-action, and total-budget limits; otherwise sponsorship is disabled.
- No screens suggest MPOO is required or that future economic features already exist.

