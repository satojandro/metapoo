# Board review and next steps — 12 October 2026

## Assessment

The repository implements a useful NEAR transaction scaffold, but it does not yet deliver a satisfying shared pixel-art experience. Revisit Berry Club as a source of engineering patterns and use Reddit r/place as the primary interaction reference. The latest visual direction is a three-dimensional stall viewed from its entrance: board on the back wall, emblematic toilet beneath, and side walls extending toward the viewer.

The distinction between an original implementation and studying an existing implementation matters. The requirement to build an original product did not require excluding Berry Club's lessons. The current README describes it as inspiration for the concept only; that boundary should be revised in the next implementation brief.

This is an assessment and proposed plan. It does not change the accepted Open wall rule, enable payments, replace the wallet library, or deploy a contract.

## Evidence and limits

- Reviewed Meta Poo commit `95c9525897216cea92c740066f2d7f34f0e3b884`; checkout was clean before this report.
- Reviewed frontend, shared rules, Rust contract, decision record, roadmap, and storage notes.
- Opened the local page and measured the displayed canvas and selection ring.
- All 27 frontend tests, 12 shared tests, and 15 Rust unit tests passed. Production frontend build passed.
- No local `web/.env` or configured game contract was present. The inspected page was explicitly an empty mock. These checks do not verify yesterday's deployed testnet build, account, wallet behavior, or transactions. A deployed URL and game contract identifier are needed to compare that exact version.
- Inspected the original Berry Club repository's public history and pinned frontend source. The July 2020 source below is an early NEAR Place ancestor, not the literal first commit. Later features are identified separately.

## Reference findings

### Early Berry Club / NEAR Place

The repository history records a July 27, 2020 commit describing a one-transaction-per-finality-window bottleneck, followed by batching, guarded refresh, and scaling changes. At July 28 commit `f89fe34516d376223b6e431639bafce0590f4fcc`, `frontend/src/App.js` already contains:

- A 50×50 board drawn using 16×16 bitmap rectangles. Bitmap dimensions are not a guarantee of displayed screen size.
- A queue batching up to 10 pixels, with a 500 ms batching timer.
- Pending pixels rendered before confirmed board refresh.
- Automatic refresh scheduled at 1 second while active, with hidden-tab suppression.
- Row version checks and retrieval of changed rows rather than every pixel on each update.
- Browser key storage, wallet session restoration, and contract-scoped sign-in through the historical NEAR wallet API.

The later repository head `be63065a289abd7251775e2ae84ad2ec8fc1f7b7` also includes mouse/touch drawing handlers, larger batches, a color eyedropper, and allowance-exhaustion handling. Do not attribute all of those to the first version or copy its old dependencies, wallet URLs, retry logic, economics, or undifferentiated pending paint.

Primary source: [early frontend](https://github.com/evgenykuzyakov/berryclub/blob/f89fe34516d376223b6e431639bafce0590f4fcc/frontend/src/App.js), [history](https://github.com/evgenykuzyakov/berryclub/commits/master/), [later frontend](https://github.com/evgenykuzyakov/berryclub/blob/be63065a289abd7251775e2ae84ad2ec8fc1f7b7/frontend/src/App.js).

### Reddit r/place

Reddit's own engineering account treats synchronized board state, substantial zoom, easy pan, and support across desktop/mobile as core requirements. It distinguishes the small logical pixel from the larger screen target used to place it. This is the useful reference for Meta Poo; copying Reddit's million-cell size, infrastructure, or cooldown is unnecessary.

Primary source: [How We Built r/Place](https://redditinc.com/blog/how-we-built-rplace).

### NEAR drawing permissions

NEAR function-call keys restrict calls to a receiver contract, optionally named methods, and a gas allowance. They do not allow attached NEAR deposits. Our existing `draw` call attaches zero, which fits that constraint. The installed wallet connector exposes `addFunctionCallKey` options for contract, selected methods, and a limited allowance, but Meta Poo currently requests sign-in without adding a key.

This makes a drawing session plausible without a library rewrite. It does not prove end-to-end support in every wallet. Key creation, local signing, account/network isolation, reload restoration, allowance exhaustion, and actual on-chain revocation still need a focused testnet experiment. Clearing a browser session is not proof that an on-chain key was deleted.

Primary source: [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys). Local API evidence: `web/node_modules/@hot-labs/near-connect/build/types/index.d.ts`.

## Code review

| Finding | Evidence | Implication / correction |
|---|---|---|
| Cells are too small for precise painting | `web/src/style.css`: full-width canvas inside a board capped at 640 px; 128 columns. Local displayed width was 432 px: 3.375 screen px per cell. | Separate overview from painting zoom. Aim for roughly 16–24 screen px per cell when placing paint; keep the 128×128 logical board initially. |
| Selection obscures tiny cells | `#selection-ring`: 2 px border, inward outline, and an additional inset shadow after color selection. Local ring measured 4×4 px, with 2 px borders. | Draw selection outside the cell or use a zoom-aware indicator. Preserve the entire colored cell interior. This supports an overlay explanation for the reported partial fill; the exact deployed symptom remains unverified. |
| Renderer already paints full rectangles | `web/src/render-board.ts`: confirmed cells use `fillRect(x * CELL, y * CELL, CELL, CELL)` with `CELL = 4`. | Changing bitmap `CELL` alone will not enlarge screen targets because CSS scales the whole board to its container. Verify cell interiors and adjacent boundaries visually at multiple zoom levels. |
| No zoom/pan or touch gesture distinction | `web/src/main.ts`: click maps directly to selection; arrow keys select cells; no camera state or pan/pinch handlers. | Add one shared transform for rendering, pointer hit testing, and overlays. Panning/pinching must never submit paint. |
| Painting is a slow form workflow | Canvas click selects and reads; Draw/Enter submits; one in-flight draw blocks another. | Default to tap/select + obvious Place action, especially on mobile. Offer explicit direct-paint mode after drawing-session authorization. Queue changes rather than discard rapid input. |
| Board is not automatically shared in practice | Full refresh runs at startup, manual refresh, and after own success; selected-cell reads are separate. | Start with bounded visible-tab polling, reconnect refresh, last-updated status, and backoff. Measure full-board cost before choosing row/chunk versions or an indexed update feed. |
| Multi-page reads mix changing chain state | Each RPC view uses independent `finality: optimistic`; no shared block identifier. At full occupancy, 16,384 cells require 64 pages of 256. | Pin each complete load to one block. Ensure an older full refresh or selected-cell response cannot overwrite newer cached state. |
| Read-back conflates successful placement with current ownership | `submit-draw.ts` returns failed when wallet success is followed by a nonmatching current cell. | Under Open wall, another artist may already have overwritten a successful draw. Track transaction result separately from current board state; use unresolved/confirmation-delayed states for uncertain outcomes and query transaction status when a hash is available. |
| Contract metadata is displayed but not validated | `bootstrapBoard()` reads dimensions, schema, rule, and palette, while rendering/writes use local constants. | Reject incompatible contract metadata before enabling drawing; validate RPC data and provide bounded request timeouts. |
| Presentation prioritizes implementation details | Large evidence/rules/state text above and beside canvas; no stall environment. | Make the wall primary, keep palette and place controls within reach, and move contract/schema/debug detail into an expandable About/details panel. Retain a compact testnet and fee indication. |
| Contract intentionally provides only one-cell writes | `contracts/board/src/lib.rs`: zero-deposit `draw(x,y,color)`, sparse bounded board, latest artist/time. | Retain for first placement milestone. Add a separately specified bounded batch method only if direct painting is required, with argument checks, atomic failure rules, gas/storage measurements, and deployment compatibility planning. |

Good foundations: server-side bounds/palette checks, a clear overwrite rule, sparse storage, attribution, keyboard selection, safe text insertion, and refusal to claim success from a transaction hash alone. Preserve those. Passing unit tests establish this logic; they do not establish rendering, gestures, wallet sessions, or a live two-user journey.

## Proposed implementation order

### 1. Correct the visual and interaction brief

Write the next brief around: “A live communal pixel-art wall inside a toilet stall. Explore the wall, zoom to a cell, choose a color, and place it precisely.” Restore Berry Club as a technical reference. Produce desktop and 390 px mobile views showing overview, zoomed painting, selection, pending paint, and compact connection status.

Use the 3D stall composition and reference-inspired surrounding art described in the [latest visual notes](2026-10-12-stall-visual-references.md). Keep the back-wall board precisely targetable and every pixel fully colored; scene perspective and decoration must preserve painting usability.

The Sydney photographs inform the painting palette as well as scenery. Propose saturated colors alongside the visual draft. The current eight-color contract palette is an implementation baseline; coordinate any change across frontend/shared/contract and preserve the meaning of existing stored colors.

### 2. Make the board usable without changing the contract

Implement zoom, pan, fit-to-wall, crisp rendering, coordinates, hover/selection preview, and an external selection indicator. Use pointer events and distinguish tap from drag. Keep palette and Place action close to the board on mobile. Label any local art used for visual testing as demo data.

Acceptance: adjacent painted cells touch without unintended gaps; selected color remains visible; at painting zoom a chosen cell is comfortably targetable; all corners and center map correctly after zoom/pan/resize; touch drag and pinch never paint; keyboard navigation remains usable.

### 3. Establish reliable shared updates and outcome recovery

Pin full loads to a block; guard against stale responses; add bounded polling and visible freshness state; separate submitted, confirmed, confirmation-delayed, failed, and overwritten states. Keep preview/pending paint in a separate client layer, visibly different from confirmed art. An uncertain request must not automatically be resubmitted.

Acceptance: two independent sessions see each other's confirmed changes within a stated target, initially about 3–5 seconds under healthy testnet/RPC conditions. Reconnect catches up. Delayed reads and immediate overwrite do not misreport an executed transaction as failed.

### 4. Prove the NEAR drawing session

Use the installed connector's capability as the starting point. Authorize only the board's draw method with a small explicit gas allowance. Show activation, remaining allowance, renewal, and revoke behavior in plain language. Keep ordinary wallet approval as a fallback.

Acceptance: authorize once, make multiple placements without repeated wallet popups, reload safely, switch accounts/networks safely, exhaust the allowance gracefully, and verify the key is removed on chain when revoked. This spends the player's authorized gas budget; it is not gas sponsorship.

### 5. Add continuous drawing only after the placement loop works

For an r/place-like first release, one deliberate cell placement is sufficient. If brush strokes are desired, add an explicit paint mode, a serialized queue with visible pending cells, duplicate suppression, and a bounded batch contract method. Define rejection, partial/atomic failure, nonce handling, and uncertain-result recovery before testing rapid strokes.

Measure contract storage requirements for all 16,384 cells with long account IDs and fund that finite storage requirement before broader use. Open wall already accepts overwriting; transaction/queue limits still matter for reliability and cost.

## Next milestone

Two people on separate devices can enter the stall, zoom, select a full colored cell, place paint with clear status, and observe each other's work automatically. A tested drawing session removes repeated wallet interruption. Demonstrate this on testnet before advancing payments, rewards, sponsorship, or chain abstraction.

The immediate next change should be the board viewport and toolbar, alongside a narrow wallet-session experiment. There is no evidence that the entire repository needs to be rewritten.

## Added visual guidance

The user's Sydney photographs now provide a concrete reference for the stall's art and materials: vivid geometric/pixel compositions on dark grounds, layered public marks, weathered brick, and metal. See [stall visual references](2026-10-12-stall-visual-references.md) for the identified artist, source files, and how this applies to the interface.
