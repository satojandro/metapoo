# Wall page front-end audit and plan — 2 November 2026

Status: **Phase 0 done (#49). Phase 1 draft approved by the owner on 2 Nov; build in progress.** Supersedes nothing: the
[29 Oct whole-site review](2026-10-29-whole-site-design-review.md) is still the design reasoning, and
most of its P1/P2 rows are still open (checked below).

## How this was checked

`main` at `203298b`, `npx vite` against `board3.metapoo-player1.testnet` (testnet, live reads), headless
Chromium at **1440 × 900** and **390 × 844** (touch, mobile). No wallet was connected, nothing was signed.
Exercised: first load, the first-use hint, Paint zoom, selecting a cell, choosing a colour, Place paint
while disconnected, `/money`, `/admin`. Web tests: 433/433. No console errors; one aborted RPC request
during navigation.

`/money` is in good shape and is the visual reference for everything below.

## What is broken on the wall page

### P1: the wall doesn't work as the product

| # | finding | evidence |
|---|---|---|
| 1 | **The paint dock covers the wall.** | Desktop: the board canvas spans y 273–803; the dock starts at y≈660, so the bottom quarter of the wall is under it on first load. Phone: about 250 px of wall is visible before the dock fills the rest of the screen. |
| 2 | **The wall isn't the hero.** The decorative stall photo is louder than the live wall. | Desktop: the board is 530 px wide (37% of the viewport) inside a 1,320 px photo of murals. Board3 holds a handful of painted cells, so the product reads as an empty dark panel between two vivid pictures. |
| 3 | **The first-use hint covers the wall on phone.** | The hint card covers most of the visible board at 390 px. On desktop it sits over the right-hand mural. |
| 4 | **Feedback happens off-screen.** | Place paint is enabled with no cell selected. Pressing it puts a "Choose a pixel" callout below the dock, out of view on both sizes. |
| 5 | **Paint zoom loses the wall.** | It scrolls the page so the top of the wall is off-screen, and the zoom readout ("Zoom 483% · Cell: …") is clipped at the board's bottom edge. |

### P2: the page reads like a debug view

| # | finding | evidence |
|---|---|---|
| 6 | **Developer copy in the main UI.** | "State: disconnected — look freely; draw needs a wallet." (shown twice), "BOARD LAST UPDATED JUST UPDATED BLOCK 275877344.", "DEMO STALL ART / LIVE BOARD", "Paint preview: Bubblegum (palette index 11)", "Selected square x=64, y=66 … Counting starts at the top-left … not in our cache", "Unpainted squares have no artist.", a "Direct paint" checkbox. |
| 7 | **Controls in four places with overlapping meanings.** | Header (Connect NEAR wallet, Paint & wallet), scene corner (Focus canvas), dock (swatches, Direct paint, Place paint), a toolbar under the scene (−, +, Fit wall, Paint zoom, Refresh board). Focus canvas, Paint zoom, Fit wall and zoom all change the view. |
| 8 | **Three visual languages.** | Dark stall scene, a cream dock with a grey disabled "Buy credits", and the `/money` style. Two CSS layers (`style.css` 1,377 lines, `wall-design.css` 180) with no shared tokens. |
| 9 | **Two wallet buttons** and a public "Board settings" link in the nav. | "Connect NEAR wallet" and "Paint & wallet" side by side. "Board settings" is fixed by ADM-2. |
| 10 | **Dead space and lost information.** | Desktop: about 190 px of empty page between the dock and the toolbar. The repaint price rule and the contract line live in a collapsed "About / details" at the bottom. |

### Still open from the 29 Oct review

Mobile composition (P1), scattered guidance (P2), overlapping view and paint concepts (P2), dock
arrangement (P2), small status text (P2), conflicting colour language (P2), empty-board state (P2). Done
since: checkout (`55526b9`), inactive nav destinations removed.

## Plan

### Phase 0 — stop the bleeding (one PR, no redesign, about a day)

Behaviour stays the same; layout and copy change. No camera maths changes (`docs/learning/traps.md`).

1. The dock never overlaps the board: it sits in the page flow below the wall on desktop, and the wall
   gets a guaranteed minimum height on phone.
2. The first-use hint moves into the dock as one dismissible line; it never covers the board.
3. Place paint is disabled until a cell is selected, with the reason next to the button. Every
   message caused by a dock action appears in the dock.
4. Copy pass: remove block numbers, palette indices, coordinates, cache language and duplicate
   status lines from the main UI; "Board updated 12 s ago"; a plain status in one place.
5. One wallet button in the header. "Board settings" leaves the nav (shared with ADM-2 step 1).
6. Paint zoom keeps the wall in view; the zoom readout isn't clipped.

Acceptance: screenshots at 1440 × 900 and 390 × 844 before and after, no element overlapping the board
canvas (asserted with bounding boxes in a Playwright check), existing 433 tests green.

### Phase 1 — redesign the wall page (design first, then build)

1. **Design draft as an artifact first**, like How it works, for owner approval before any code:
   - **Wall first.** The live wall is the largest thing on screen. The stall is a frame, not a competitor.
   - **Two modes of one wall:** overview (look, inspect, share) and painting (precise canvas, tools in
     thumb reach). View controls and paint tools separated.
   - **A dark dock in the `/money` language:** colour, cost, credits and the next action as one group.
   - **Cell inspector:** who painted it, how long ago, what it costs to cover now.
   - **Art / Price / Age views** of the real wall (the owner's idea from the How it works draft), so
     people can see where paint is wet and where it's cheap.
   - **A truthful empty state** for a mostly empty wall: invite the first marks; never fake pixels.
2. **Build in steps behind tests**, one PR each: layout and dock; view modes; inspector; empty state.

### Phase 1 — approved design and build steps (owner, 2 Nov)

Approved draft: [`visual-concepts/wall-draft.html`](visual-concepts/wall-draft.html) (also published as an
artifact). Owner answers to the draft's questions:

| question | decision |
|---|---|
| Open in Look or Paint? | **Look.** |
| More stall framing on phone? | **No.** Owner asked for a recommendation: keep the thin tiled frame and spend the space on the wall. The stall identity lives in the header line and the empty state. |
| A Move button for touch? | **Yes.** Not being able to move the wall while painting is a major UX problem. In Paint mode a visible Move toggle switches drag to panning, alongside two-finger pan. |
| Price view shows blank tiles as free while you have free paints? | **Yes.** |
| Show who painted? | **Yes, for the turf war.** Built as its own **Turf** view: tiles coloured by painter, your tiles highlighted, a legend of who holds the most tiles. Age stays about age. |

Build steps, one PR each, in order (they share files, so they don't run in parallel):

1. **Layout and modes.** Wall-first layout (wall beside a side panel on desktop, bottom sheet on phone),
   Look / Paint switch (Look default), the Move toggle, view bar (Art / Price / Age / Turf placeholders, −,
   +, Fit), one dark dock on the design tokens with its state-driven primary button. Existing selection,
   stroke, pricing and submission logic is reused, not rewritten. No camera-maths changes.
2. **Views.** Art / Price / Age / Turf recolour the live wall from data the page already reads
   (`artistAccountId`, `lastWriteTimestampNs`, repaint tiers), refreshing as paint dries.
3. **Tile inspector.** Painter, time ago with wet/drying/dry, cost to cover now, "Paint over this", copy a
   `#tile-x-y` link that opens the wall on that tile.
4. **Empty state and clean-up.** The nearly-empty-wall state with the free first paints; remove the old
   stall photo layers and the cream dock styles; the wall page fully on tokens.

### Phase 2 — one design system for the site

Shared tokens (colour, type, spacing, buttons, panels, status) extracted from `/money` and the approved
drafts, used by the wall, `/how-it-works`, `/toilet` and the owner console. Retire the cream dock styles.

### Order against the existing queue

Phase 0 → Phase 1 design draft → `/how-it-works` (FE-HIW) and ADM-2 → Phase 1 build → FE-3, FE-BUYBACK →
Phase 2. Owner to confirm.
