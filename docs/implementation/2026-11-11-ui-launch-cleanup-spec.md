# UI-1 — launch cleanup, batch 1

Date: 11 November 2026. Status: **implementation specification; no app code changed.**
Source: batch 1 of the "Suggested order" in the [UI launch review](../2026-11-11-ui-launch-review.md)
(merged in `bc414d3`, PR #107). Backlog row: **UI-1** in [`../backlog.md`](../backlog.md).
Task list: [`ui-launch-cleanup.tasks.json`](ui-launch-cleanup.tasks.json).

Read the review first. It owns the findings and the reasoning; this document owns only what batch 1
changes.

## 1. Result and scope

Six findings that need no design decision: a phone user can read every page without sideways
scroll, the three pages that contradict the live product stop contradicting it, a shared link has a
title and a card, a bad URL has a page instead of a stub, and one word ("tile") replaces the four in
use.

In scope, exactly: **A1, A2, A5, A6, B2, C3** from the review.

Out of scope, deliberately, even where it touches the same file:

- **A3, D, E, F** (payment sheets, account panel, connected paint panel) — batch 2, needs a real
  wallet.
- **A4, G** (Send, Self-custody, approval window) — batch 4, needs owner sign-off on wording and
  ships with SEND-HARDEN.
- **B1, B3, B4, B7–B9, C1, C2, C4, C10** — batch 3. B4 ("short ids in the wall lists") is the same
  helper as A1, so it lands in batch 3 by calling it, not by duplicating it.
- **B5, B6** — batch 5, needs a physical phone.
- **C5–C9** — ride along with whichever PR touches the file; not here.
- **The "square"/"pixel" wording in the confirmation and the account panel (F2, E1).** B2 is only
  the two surfaces a player sees while painting: the stroke tally and the screen-reader readout. The
  wider vocabulary cleanup needs those two files, which are batch 2's.
- No contract change, no config change, no new dependency, no design decision.

Asset work this batch does need: one favicon and one social card image (A5). They are small
deliverables, not a design exercise — the card is a screenshot of the real wall.

## 2. Evidence baseline

`main` at `5833e99` (after PR #107). All line numbers below verified there, not carried over from the
review:

| # | Finding | Verified anchor |
|---|---|---|
| A1 | Full account ids stretch their grid, so five routes are wider than a 390 px phone | Each page interpolates the board id into one "read live from" line: `toilet-page.ts:319-320`, `how-it-works-page.ts:347-348`, `stake-page.ts:207,211`. Two shortening helpers already exist and disagree: `wallet-chrome.ts:244` (6…4) and `revenue-panel-page.ts:222` (8…8, private). |
| A1 | The layout gate never looked at these pages | `web/scripts/layout-check.mjs:26` takes **one** URL and asserts only board overlap and board cut-off. It has no horizontal-overflow assertion and no route list. |
| A2 | How it works says earning is not live | `how-it-works-page.ts:251-256`: the `hiw-next` section, "Earning switches on in a later round", already links to `/toilet` — so the section is redundant rather than wrong-headed. |
| A2 | TOILET says staking is open and then that its controls are absent | `toilet-page.ts:326`: with a staking contract set it renders "…The staking controls land on this page next." while `/stake` exists (`register-default-pages.ts:22`). |
| A2 | The diagram labels the stakers' 70% as held | `revenue-flow-svg.ts:43`: `sub: ["held on the board", "until staking opens"]` — a hardcoded string, while the card below reads the staking contract from state (`toilet-page.ts:327`). |
| A5 | No page identity | `web/index.html:10` is the only head content after charset/viewport/theme-color: `<title>Meta Poo</title>`. No description, no Open Graph, no Twitter tags, no favicon. No `document.title` assignment exists anywhere in `web/src`. |
| A6 | The 404 is a stub | `register-default-pages.ts:25-31` mounts `createStubPage({title: "Not found", body: "That path is not a known Meta Poo route."})`. |
| B2 | Four words for one thing | "cell" in `formatStrokeTotal` (`repaint-price.ts:151-155`, the dock's stroke tally) and in the readout `"Cell: none selected"` (`camera-controller.ts:257`). The wall says tile. |
| C3 | Stray comma starting a line | `stake-page.ts:156` splits the sentence across a grid child boundary: `<li><b>The pool pays out 10% of itself a day</b>, a little every moment, split by locked TOILET.</li>`. `.stk-flow li` is `display: grid; gap: 4px` (`stake-page.css:83`), so the bold and the trailing text are **separate grid rows** and the row below starts with a comma. |

Not asserted by this document, and to be established by the work: the review's pixel measurements
(553 px on `/toilet` at 390 px, and the other four). Task 1 adds the check that produces them; the
before/after numbers belong in the PR body.

## 3. Work

Each task is one commit-sized change, tests included. `PALETTE`, `q()` and the existing page styles
are reused; do not introduce a second helper for anything that already has one.

### Task 1 — A1 gate first: make `layout-check.mjs` able to fail on this

Change the script **before** any fix, so the defect is measured rather than trusted.

- Accept a route list instead of one URL: `["/", "/toilet", "/how-it-works", "/money", "/wall", "/stake", "/nope"]`,
  each against the existing two sizes.
- Add an assertion, per page and size: `document.documentElement.scrollWidth <= innerWidth + 1`, and
  the same for `document.body`. Keep the existing board-overlap and board-cut-off assertions exactly
  as they are (they are the wall's guard; do not weaken them).
- Report which element overflows: on failure, name the widest element and its `scrollWidth` so the
  next run is diagnostic, not just red.
- Exit non-zero with one line per failing page/size. It stays a manual script (`npx vite --port 5174`
  in another terminal), as its header already says.

**Acceptance:** on unfixed `main` it fails on the five routes the review names, with widths in the
same order of magnitude (≈550 on `/toilet` at 390 px, etc.), and passes `/` and `/nope` only if they
genuinely fit. Paste the output in the PR body.

### Task 2 — A1: one helper, the three source lines, and the CSS backstop

- **New `web/src/shared/short-account.ts`:** `shortAccount(account: string): string` → first 8 …
  last 8 (`fcd66acf…3076f59e`), returning the input unchanged when it is 20 characters or fewer so
  named accounts (`misfits-validator.near`) are never mangled. Unit test: a 64-char id, a named
  account, a 20-char boundary, a short string, `undefined`-safety at the call sites that need it.
- **Replace both existing helpers** with it: `wallet-chrome.ts:244` `shortAccountLabel` (6…4 → this)
  and `revenue-panel-page.ts:222` `shortAccount` (delete the private copy, import the shared one).
  Update their tests; the only intended visible change is the chip's 6…4 becoming 8…8.
- **Apply at the three overflow sources:** `toilet-page.ts:319-320`, `how-it-works-page.ts:347-348`,
  `stake-page.ts:207,211`. Shorten the id; keep the full id in `title` (hover) — that is where it
  belongs, not in prose.
- **CSS backstop**, so a future long string cannot re-break the layout: on the grid children that
  hold these lines, `min-width: 0` and `overflow-wrap: anywhere`. Add it next to the existing rules
  for `.hiw-foot`, the TOILET live block and `.stk-source` rather than inventing new selectors.
- Full ids stay in `aria-label`s where they already are (NearBlocks links, copy actions): a screen
  reader benefits from the whole id even when the eye does not.

**Acceptance:** Task 1's script passes on all seven routes at both sizes. The five widths from the
pre-fix run are in the PR body next to their post-fix values.

### Task 3 — A2: the three pages stop contradicting the product

- **How it works:** delete the `hiw-next` section (`how-it-works-page.ts:251-256`). Its content is
  now covered by `/toilet`, which the section already links to. Nothing replaces it.
- **TOILET:** in the staking-is-set branch, replace "The staking controls land on this page next."
  with a real link — "Stake your TOILET →" pointing at `/stake`. The not-set branch keeps its
  existing honest copy ("Staking opens on this page once the staking contract is live.").
- **Revenue diagram:** `revenue-flow-svg.ts:43` takes the same staking-set signal the card uses
  (`toilet-page.ts:327`) instead of a hardcoded string: set → `["forwarded to the staking", "contract"]`,
  not set → `["held on the board", "until staking opens"]`. Pass the flag in as a parameter; do not
  read state inside the SVG builder.
- Any test asserting the old strings is updated to the new ones, not deleted.

**Acceptance:** with a staking contract set (the mainnet-testing state), no page says staking is
coming or that the stakers' share is held. With none set, all three still say so. A test covers both
branches of the diagram label.

### Task 4 — A5: title and card

- **Static, in `web/index.html`:** `<meta name="description">`, Open Graph
  (`og:title`, `og:description`, `og:image`, `og:url`, `og:type=website`) and
  `twitter:card=summary_large_image` with `twitter:title/description/image`, plus
  `<link rel="icon">`. Absolute URLs for `og:image` and `og:url` — the production origin is
  `https://metapoo-testnet.vercel.app`; put it in one place in the head and note it must change at a
  real domain.
- **Per-route titles, in `web/src/main.ts`** next to `shell.setActiveNav(route)` (`main.ts:30`): a
  `document.title` of `"<Page> · Meta Poo"` from a small map keyed by `route.pageId`, reusing
  `NAV_ITEMS` labels (`shell.ts:27-33`) so there is one source of page names. `not-found` →
  `"Nothing painted here · Meta Poo"`.
- **Assets:** `web/public/favicon.svg` (a tile from the palette's Ink colour on the page background —
  keep it to the existing token colours) and `web/public/og.png` at 1200 × 630, a real screenshot of
  the wall taken with Playwright in the repo's existing style (`capture_screenshot`-equivalent: a
  `page.screenshot({clip})` at 1200 × 630 against a running dev server, whole-board view). Commit the
  PNG; keep the capture command in the PR body so it can be redone.

**Honest limit to state in the PR:** a client-set `document.title` fixes the tab, not the share
preview. Per-route social cards would need prerendering, which this batch does not add; the static
tags give every route the same site-wide card, which is the launch-day improvement the review asked
for.

**Acceptance:** every route has a distinct tab title; `curl -s <prod>/ | grep og:image` returns an
absolute URL that resolves 200 with `content-type: image/png`; the favicon is served at `/favicon.svg`.

### Task 5 — A6: a 404 a player can use

- **New `web/src/app/not-found-page.ts`**, mounted in `register-default-pages.ts:25-31` in place of
  `createStubPage`. Content, in player language: heading "Nothing painted here.", one line
  ("That page isn't on the wall."), and one primary button "Go to the wall" → `/wall`.
- Use the same hero layout as `/admin`'s signed-out state (it is the existing pattern for a page that
  must exist without data). Reuse its classes; do not build a second hero.
- Test: the page mounts at an unknown path, renders the heading, and the button's href is `/wall`.

**Acceptance:** `/nope` renders the styled page, not the stub, and Task 1's script still passes on it.

### Task 6 — B2: "tile" in the two places a player reads while painting

- `formatStrokeTotal` (`repaint-price.ts:151-155`): `this stroke: 1 cell · 1 credit` →
  `this stroke: 1 tile · 1 credit`; plural likewise.
- Readout (`camera-controller.ts:257`): `"Cell: none selected"` → `"Tile: none selected"`, and the
  selected branch with it.
- Update the three tests that assert these strings (`camera-controller.test.ts:98`,
  `mount-wall.behaviour.test.ts:606,519` and any tally assertion) to the new wording. Grep the whole
  suite for `cell` in player-facing assertions before finishing; anything the player can read says
  tile, anything in code or data may stay `cell`.

**Acceptance:** no player-readable string in `repaint-price.ts` or `camera-controller.ts` says cell.

### Task 7 — C3: the comma stops starting a line

`stake-page.ts:156`: move "a little every moment" inside the bold so the grid row is the heading and
the row below is a complete sentence (`<b>The pool pays out 10% of itself a day, a little every
moment</b>, split by locked TOILET.`), **or** wrap the whole sentence in one element so it is a
single grid row. Prefer the first: it keeps the emphasis where the design put it. Add a test
asserting step 3's text starts with a letter or digit, not punctuation, so the pattern cannot come
back in step 4.

**Acceptance:** step 3 reads as one sentence and no line on `/stake` begins with a comma.

## 4. Verification

From `web/`, on Node 22.20.0 (the version `ci.yml` pins):

```
npx vitest run          # all green, no new skips
npx tsc --noEmit        # clean
npx vite build          # clean
npx vite --port 5174    # in another terminal, then:
node scripts/layout-check.mjs http://localhost:5174
```

The PR body carries, per finding: the pre-fix measurement, the post-fix measurement, and the file
where it changed. "Fixed" without both numbers is not evidence.

## 5. What this batch does not prove

- **Nothing here was seen with a wallet.** All six findings are signed-out or static, so this is the
  one batch where that limit costs little. A3/E/F still need a real wallet and are batch 2.
- **The phone is emulated.** Task 1 runs a 390 × 844 Chromium viewport, not a device. B5 stays open
  until someone holds a phone.
- **The social card is a screenshot of today's wall.** When the wall's look changes, the card is
  stale; the capture command in the PR body is the fix, and nobody will remember it — so put one line
  in the review doc when it is redone.

## 6. Backlog

Only **UI-1** moves, from `spec → done` when merged. B4's shortening rides the helper from Task 2 but
stays in batch 3, and the rest of the batches are unchanged. Update `docs/backlog.md` on `main` after
the merge, per AGENT.md.
