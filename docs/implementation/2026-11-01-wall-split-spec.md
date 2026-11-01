# Wall controller split — spec

Date: 1 November 2026. Work order: [`wall-split.task.json`](wall-split.task.json) (FE-0).
Source: [code audit](../2026-10-29-code-audit.md) F1 and F2. Baseline: `main` = `0c3eb8d`.

## The problem

`web/src/pages/wall/mount-wall.ts` is the wall page's controller. It is **2,538 lines inside one
function**, `mountWall`. Inside it:

- about **240 `const`/`let` declarations** share one scope, including ~40 mutable flags and caches
  (`selected`, `drawInFlight`, `cachedCredits`, `creditsKnown`, `priceUnavailable`, `cellCostCache`,
  `boardSchema`, `pollTimer`, `camera`, …)
- **54 inner functions**, of which `attemptDraw` alone is 367 lines (868–1235) and `wirePointerGestures`
  is 265 (1384–1649)
- board loading, polling, prices, credits, painting, the drawing session, the buy-credits sheet, zoom,
  pan, gestures and every status line

Any function can read or change any of that state. The modules around it are clean (`board-sync`,
`paint-queue`, `stroke-commit`, `repaint-price`, `viewport`, `gesture`). The controller that wires them
is the problem.

**What it has cost:**

- The last run of fixes were features breaking each other through shared state: a price read
  blocking a paint (`9ea4a76`), direct paint waiting on a price read (`09965fe`), stroke quotes starving
  the buy-credits sheet (`69578bb`).
- The credit balance lives in at least three places (`cachedCredits`/`creditsKnown`, the sheet's
  `onCreditsChanged`, the dock text). That's the shape of issue #29: credits not updating after spend.
- `cellCostCache` is never invalidated, and queued taps all check the same cached balance without
  reserving it, so five fast taps with 2 credits all pass the page's check and three fail on chain.
- Every agent touching paint, price or checkout edits this one file. Agents collide here (handover).

**Why now:** the paid-board revision adds 16 swatches, `max_credits`, free first paints, happy hour,
mPOO checkout and a revenue panel, all on this page. Added to the current file, each one makes the
problems above worse. After the split, those five pieces of frontend work touch different modules and
can run in parallel.

## The target

Five controllers, each owning its state, plus a thin `mountWall` that finds DOM nodes, creates the
controllers, connects them and disposes them.

| module (in `web/src/pages/wall/`) | owns this state | takes these functions from `mount-wall.ts` |
|---|---|---|
| `board-controller.ts`: load, poll, freshness, contract metadata | `boardSync`, `pixelCache`, `boardSchema`, `contractMetaOk`, `contractMetaIssue`, `boardLoadInFlight`, `loadAbort`, `pollTimer` | `bootstrapBoard`, `refreshBoardFromContract`, `refreshSelectedPixel`, `scheduleBoardPoll`, `clearBoardPoll`, `runBoardPoll`, `revalidateContractMeta`, `rememberBoardSchema`, `showBoardFreshness` |
| `pricing-controller.ts`: credits and cell prices. **The only place the balance lives** | `cachedCredits`, `creditsKnown`, `cellCostCache`, `priceUnavailable`, `pricedCellKey`, `priceRequest`, `submitQuoteInFlight`, `repaintReaders` | `refreshCreditsDock`, `refreshPaidLegend`, `requestCellPrice`, `ensurePaidQuote`, `paidBoard`, `chainNowNs` |
| `paint-controller.ts`: sending paints and the drawing session | `drawInFlight`, `activeStroke`, `paintQueue`, `pendingPaints`, `queuedPlacementOutcomes`, placement outcomes, `tapToPaintEnabled`, `tapToPaintUserChoice` | `attemptDraw`, `commitStroke`, `maybeEnqueueDirectPaint`, `enqueuePricedDirectPaint`, `drainPaintQueue`, `cancelUnsentPaintQueue`, `directPaintReady`, `updateDirectPaintAvailability`, `syncSubmitEnabled`, `onAuthorizeSessionClick`, `onRevokeSessionClick`, `showDrawingSession`, `refreshAllowanceNote` |
| `camera-controller.ts`: zoom, pan, gestures, pointer preview | `camera`, `viewTransform`, `gesture`, `strokeCancelled`, `spaceHeld`, pinch and tap state, `zoomStateListeners` | `render`, `applyCamera`, `readZoomState`, `clampToViewport`, `readViewportSize`, `zoomFromCenter`, `fitWallToView`, `wirePointerGestures`, `cellAtClientPoint`, `selectAtClientPoint`, `updatePointerPreview`, `clearPointerPreview`, `updatePositionReadout`, `positionSelection` |
| `wall-view.ts`: status text, selection panel, palette, rules | `uiPhase`, `selected`, `selectedColor` | `showSelection`, `updatePreview`, `updateCompactStatus`, `setFlow`, `fillRules`, `buildPalette`, `fillBlock`, `fillResultWithLink`, `clearBlock`, `colorName`, `applyRoutePaintingContext` |

**Rules for the boundaries:**

- Each controller is a factory `createXController(deps)` returning a small typed interface plus
  `dispose()`. `deps` lists exactly the DOM nodes, services and other controllers' interfaces it needs.
- No controller reads another's variables. Cross-controller changes go through the interface or a
  typed event (`onCreditsChanged`, `onBoardUpdated`, `onSelectionChanged`, `onCameraChanged`).
- Listener registration keeps using the existing `listen()` helper, so `disposeWall()` still removes
  everything (`mount-wall.dispose.test.ts` must stay green).
- `WallMountTestApi` keeps its current shape, so existing tests don't change.
- Target: `mount-wall.ts` under ~400 lines, no controller over ~700.

## Behaviour-neutral: what that means here

This PR **moves code. It changes no behaviour, copy, styling, timing or contract call.** If a bug is
found while moving code, write it down in the PR description and leave it. Two are already known and
belong to [`fe-max-credits.task.json`](fe-max-credits.task.json) (FE-2), which builds on this split:

- `cellCostCache` is never invalidated when the board changes
- queued paints don't reserve credits, so the page's balance check passes taps that will fail on chain

The point of keeping it neutral is that a reviewer can check it by reading the tests, not by
re-testing the app by hand.

## Method: test-first, one module per commit

1. **Characterization tests first**, in a new `mount-wall.behaviour.test.ts`, driving `mountWall`
   through `WallMountTestApi` and fake services. Cover at least: a tap paint on the free board; a
   drag stroke; a paid tap with a price read that fails and one that succeeds; credits refresh after a
   paint (the #29 path); poll backoff after a failed read; zoom-to-paint and fit; wallet disconnect
   mid-paint; dispose removing every listener and timer. They must pass on `0c3eb8d` **before** any
   code moves.
2. **Extract in this order**, least coupled first, tests green after each commit:
   camera → board → wall view → pricing → paint. One commit per controller, plus its own unit tests.
3. **Final wiring commit:** `mountWall` reduced to DOM lookup, factory calls, connections and dispose.

## Acceptance

- `cd web && npm test` and `npm run build` pass at every commit.
- The characterization tests pass unchanged before and after.
- Existing tests unchanged, except imports.
- `mount-wall.ts` under ~400 lines; each controller has its own test file.
- Manual check on `board3.metapoo-player1.testnet` (Brave + Meteor or any wallet): tap paint, drag
  paint, zoom and pan on desktop and a 390 px phone width, buy credits. A short screen recording or
  screenshots in the PR.
- `## Learned` in the PR. Backlog row F1-REFACTOR moved to Delivered with the merge commit.

## Collision rule

While FE-0 is open, **no other branch edits `web/src/pages/wall/mount-wall.ts`.** Frontend work that
needs it waits. Contract work and other `web/` files are unaffected. It is one PR; aim to merge within
a few days so the frontend queue isn't held up.
