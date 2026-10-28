# Cursor prompts

Two ready-to-paste prompts. Each is a separate PR, in this order. Both assume the repo is at `main`.

Give Cursor the prompt text, not a summary of it — it already has the repo.

---

## Prompt 1 — delete the retired Journey C pressure path

> You are working in this repo. Read `AGENT.md` and `docs/learning/traps.md` first, then
> `docs/implementation/pay-recency-ui.task.json` for context.
>
> **Task: delete the retired Journey C paid-pressure path.** Schema 3 was the pressure prototype and is
> dead (decision D1 in `docs/00-shared-decisions.md`; `contract-meta.ts` now accepts schema 2 and 4 only).
> The code is still wired into the wall and still contains a fixture-quote path that can render fabricated
> prices. Remove it.
>
> **Delete these files entirely:**
> - `web/src/paid-mode.ts`
> - `web/src/paid-paint.ts` and `web/src/paid-paint.test.ts`
> - `web/src/pressure-quote.ts` (and its test if one exists)
> - `web/src/features/pressure/` (all four files and their tests)
>
> **Remove their wiring** from `web/src/pages/wall/mount-wall.ts`, `web/src/pages/wall/wall-template.ts`,
> `web/src/style.css` and `web/src/wall-design.css`: the `#pressure-panel` markup and its control,
> `pressureElements`, `useMockQuotes`, `selectedQuote`, `rebuildPressureHooks`, `applyPaidModeChrome`,
> `syncPaidModeFromBoard`, the quote fetch, and the max-cost checks that only exist for quotes.
>
> **Keep working, unchanged:**
> - the free schema-2 paint path, drag strokes, direct paint, the drawing session
> - the schema-4 credit path in `web/src/paint-wallet.ts` and the Paint & wallet panel
> - `web/src/contract-meta.ts` as it is now (accepts 2 and 4; schema 3 rejection names it "retired")
> - every unrelated test
>
> **Acceptance:** `cd web && npm test` and `npm run build` both pass; `539`-style test counts drop only by
> the tests belonging to deleted files; no remaining import of a deleted module
> (`grep -rn "paid-mode\|paid-paint\|pressure-quote\|features/pressure" web/src` returns nothing);
> the wall still paints on the free testnet board.
>
> Do not touch `contracts/` or `shared/`. Do not rename anything unrelated. If a live behaviour depends on
> a quote price, stop and report it rather than inventing a replacement.

---

## Prompt 2 — show the repaint price before the user commits

> You are working in this repo. Read `AGENT.md`, `docs/learning/traps.md`, then
> `docs/implementation/pay-recency-ui.task.json` — that file is the spec, follow it.
>
> **Context:** `contracts/paid-board` charges **1 / 2 / 4 credits** depending on how recently the cell was
> painted (>60 min / 10–60 min / <10 min). The page currently implies a flat price. The contract exposes
> `get_cell_cost(x,y)` and `get_tunables()`; use them, do not re-implement the tiers in TypeScript.
>
> **Deliverables:**
> 1. Per-cell price on hover (touch: on selection): "repaint 2 min ago · 4 credits" or "unpainted · 1 credit".
> 2. Stroke total before submit: "this stroke: 23 cells · 31 credits" — a mixed-age drag must show a mixed total.
> 3. One-line legend in the default view, not inside `<details>`: "Fresh cells cost more to repaint. Wait an
>    hour and it is 1 credit again."
> 4. If `get_cell_cost` or `get_tunables` fails: show "price unavailable", disable submit, never fall back to 1 credit.
> 5. Insufficient credits for the priced total is explained before the wallet call, not after.
>
> **Acceptance (from the task file):** a test that fails on current `main` — with a cell painted 2 minutes
> ago, the stroke total equals cost × cells, not cells × 1; the legend string is present outside any
> `<details>`; a `get_cell_cost` failure disables submit. `npm test` and `npm run build` pass.
>
> Frontend only: `web/src/**`. No contract, palette, camera-math or wallet-key changes.

---

## How to hand these over

- Paste the block, not a paraphrase.
- Tell Cursor to work on a branch (`cursor/<task-id>`), run both commands, and open a PR — do not push to `main`.
- Expected merge order: Prompt 1, then Prompt 2. Prompt 2's file set overlaps Prompt 1's, so running them
  concurrently will conflict.
- After Prompt 2, the remaining frontend task is `pay-checkout.task.json` (quantity, NEAR/mPOO, receipt states).
