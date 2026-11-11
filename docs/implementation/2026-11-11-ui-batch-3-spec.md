# UI-3 — launch cleanup, batch 3

Date: 11 November 2026. Status: **implementation specification; no app code changed by this file.**
Source: batch 3 of the "Suggested order" in the [UI launch review](../2026-11-11-ui-launch-review.md).
Backlog row: **UI-3** in [`../backlog.md`](../backlog.md).
Predecessors: batch 1 (PR #108, `59b259c`) and batch 2 (PR #109, `cf776c1`).

Read the review first. It owns the findings; this document owns only what batch 3 changes.

## 1. Result and scope

The wall and the shared components stop arguing with themselves: one freshness view instead of
two, overlays off the artwork, one vocabulary and one disabled style, short ids in the inspector,
a footer that says where to report a problem, and a header that fits a phone.

In scope, exactly: **B1, B3, B4 (inspector), B7, B8, B9, C1, C2, C4, C10**.

Out of scope, deliberately:

- **A4, G** (Send, Self-custody, approval window) — batch 4, needs owner sign-off and ships with
  SEND-HARDEN.
- **B5, B6** — batch 5, needs a physical phone.
- **C5–C9** — ride along only where this batch already touches the file. C9 is `no-fix` (the review
  itself says the copy box is correct); C6 is UI-6.
- **No contract, config, dependency or design-token *palette* change.** One new token-free rule
  (the disabled treatment) is added in `design/tokens.css` because that file owns `.mp-btn`.

### B4 is already delivered — verify, do not redo

Batch 1's shared `shortAccount()` (`web/src/shared/short-account.ts`, 8…8) was applied to the wall
lists in `8e1064b` (`wall-story.ts`) and to the inspector in `tile-inspector.ts:228-246`. Batch 2
applied it to the paint panel (`F6`). B4-inspector therefore lands as **a check plus a test**, not a
rewrite: any remaining 64-character id printed in wall chrome is a bug found by that test.

## 2. Evidence baseline

`origin/main` at `fb16c11` (after PR #109). Every anchor below was read there.

| # | Finding | Verified anchor |
|---|---|---|
| B1 | Price and Age show the same variable two ways | `wall-template.ts:62-63` renders both chips; `wall-views.ts:314-344` builds two legends from the same `tunables`/`repaintTier` data. `ageColor()` (`wall-views.ts:233-248`) adds a day-old fade that price does not have, which is the only information Age holds alone. |
| B3 | The opt-in says nothing about what it does | `shell.ts:142-145`: `<label for="authorize-drawing-session">Also allow painting without a popup each time</label>`, no explanation, sitting first under the palette (`mount-wall.ts:492`). The same mechanism is explained properly in the wall dock (`wall-template.ts:124-136`). |
| B4 | Inspector printed 64 characters | Already fixed: `tile-inspector.ts:228-246` uses `shortAccount()`, full id in `title` + `aria-label`. Test coverage for the shortening itself is missing. |
| B7 | Four overlays sit on the art | `wall-template.ts:48-83`: hint + Move (top-left), view tabs (top-right), fullscreen/panel toggle, zoom (bottom-right), and `.wall-foot` — freshness, refresh, hover, network — floated bottom-left (`.wall-page .wall-foot`, `wall-page.css:204-228`). On phone the foot is already static (`wall-page.css:571-583`); the view tabs are not. |
| B8 | "About / details" is a full-width bar | `wall-template.ts:241-242`: `<details class="wall-advanced about wall-about"><summary>About / details ＋</summary>`; `.wall-advanced > summary` is a full-width flex row (`wall-design.css:215`). |
| B9 | No footer | A footer exists since PR #106 (`app/site-footer.ts`) with social links only. It has no "Report a problem" link even though `GITHUB_ISSUES_URL` exists (`social-links.ts:30`) and the beta banner reads `VITE_BETA_REPORT_URL`/`VITE_BETA_GUIDE_URL`, neither set in production (`config.ts:173-175`). |
| C1 | Disabled buttons look broken | Three treatments: `.mp-btn:disabled { opacity: .45 }` (`tokens.css:121`), `.action:disabled { opacity: .55 }` (`style.css:445`), `.action:disabled { opacity: .45 }` (`wall-design.css:151`). Opacity is what turns the yellow primary murky olive. Separately, `toilet-claim.ts:108`, `stake-page.ts:295,307,330` render dead buttons when the only reason is "no wallet". |
| C2 | "Connect a wallet" printed as a value | `stake-page.ts:273` (share, cut) and `:284-285` (wallet, staked, pending) write those words into `<dd>` values; two more hints say the same thing. No Connect control in the position card. |
| C4 | Lock / Unlock vs Stake | `stake-page.ts:70,94,103-120,127,145` say Lock/Unlock; nav and page name say Stake (`shell.ts:32`); `/toilet` says "burned when you unstake". |
| C10 | Phone header wraps | `style.css:551` wraps nav items (`flex-wrap: wrap`); the phone rule (`wall-design.css:237`) turns the row into a horizontal scroller, so the longest label — "Where the money goes" (`shell.ts:33`) — is only reachable by sideways scroll. |

## 3. Work

One commit per task, tests included, in this order.

### Task 1 — B3: say what the painting key does

`shell.ts:142-145` becomes a two-line control:

> **Paint without approving every stroke**
> Adds a painting key that can only paint here. It can't move your funds. Turn it off any time.

The label keeps the checkbox (`for="authorize-drawing-session"`); the explanation is a `<span>` inside
the label so it is part of the accessible name, not a detached paragraph. Wording is the review's,
verbatim. Test: the shell renders both lines and the checkbox is still disabled until a wallet can
authorise it.

### Task 2 — C10: a header that fits

`NAV_ITEMS` gains an optional `short` label. The link renders `<span class="app-nav-long">` +
`<span class="app-nav-short" aria-hidden="true">`, so the accessible name stays the full page name
(and `PAGE_NAMES` is untouched). `short` is set for `Where the money goes` → `Money`. CSS at
`≤600px`: show short, hide long (`wall-design.css` already scrolls the row; this makes it fit).

Test: the money link carries both labels, and `pageTitle("money")` still reads
`Where the money goes · Meta Poo`.

### Task 3 — C1: one disabled style, and Connect where that is the reason

- **One visual rule**, in `tokens.css` next to `.mp-btn`:

  ```
  .mp-btn:disabled, .action:disabled {
    background: var(--mp-card-2); border-color: var(--mp-line); color: var(--mp-muted);
    opacity: 1; cursor: not-allowed; filter: none;
  }
  ```

  The two local `opacity` rules (`style.css:445`, `wall-design.css:151`) are deleted, not
  duplicated. Segmented controls and zoom keep their own dimming: they are not buttons.
- **Connect instead of dead** where the only blocker is a signed-out wallet: `claimButtonState`
  (`toilet.ts:186-200`), `lockState`/`unlockState`/`claimRewardsState` (`staking.ts:265-305`) and the
  revenue "Distribute now" decision (`revenue-panel.ts:211-225`) gain a `connect?: true` reason whose
  label is `Connect wallet`. `toilet-claim.ts`, `stake-page.ts` and `revenue-panel.ts` route a press
  with that reason to the shell's `#connect-button` (the pattern `mount-wall.ts:545-549` already
  uses). Tests: signed-out renders `Connect wallet` and is **enabled**; signed-in still disables for
  the real reasons (no TOILET, nothing pending, wrong network).

### Task 4 — C2 + C4: Stake, and one Connect control

- **C2:** signed out, the five values read `—`; the position card gains one real
  `<button class="mp-btn">Connect wallet</button>` that presses `#connect-button`. Hints keep saying
  why ("Connect a wallet to stake"), but only in the hint slot.
- **C4:** player-visible copy only — `Lock → Stake`, `Unlock → Unstake`, `Locked → Staked`,
  `locked → staked`, `unlock → unstake` in `stake-page.ts` and `staking.ts` labels/hints, and the
  `/toilet` sentence already says "unstake". Identifiers (`lockState`, `data-act="lock"`, CSS
  `stk-lock-*`) do **not** change: this is a vocabulary fix, not a refactor. Tests asserting the old
  labels move to the new ones.

### Task 5 — B1: one freshness view

`price` and `age` become one mode, **`fresh`**:

- `WallViewMode` is `"art" | "fresh" | "turf"`. The chip row is Art · Fresh · Turf
  (`wall-template.ts:60-65`).
- The painter is today's price painter (wet / drying / dry bands from `repaintTier`), so a player
  sees both what to expect to pay and how fresh the wall is in one picture. Blank tiles keep the
  free-first-paint tint.
- One legend, from the board's own numbers: `Wet · 4 credits · under 10 min`,
  `Drying · 2 credits · under an hour`, `Dry · 1 credit`, plus the existing blank line. With
  tunables unread, the same bands say the time window and no credit figure (never a guess).
- `ageColor()` and the day-old fade are removed with the mode — nothing else used them.
- The stroke tally, the Tile card and `repaintTier` are untouched.

Tests: legend items and labels for both tunables-known and tunables-unknown; `data-wall-view` chips
are exactly art/fresh/turf; a saved or linked `price`/`age` view is not a URL parameter anywhere
(check `wall-modes`, `wall-view`), so no migration is needed.

### Task 6 — B7: overlays off the art

- `.wall-foot` (freshness, refresh, hover summary, network) moves **out of `.wall-frame` into
  `.wall-stage`, below the frame**, directly above the pulse strip; desktop stops floating it.
  `--wall-pulse-h` grows by the row it now occupies so the board is not clipped
  (`wall-page.css:13-22` is the only place that height is defined). Phone keeps its existing static
  row (`:571-583`) and simply inherits the new order.
- `.wall-views` (the Art/Fresh/Turf group) moves out of `.wall-bar` into `.wall-stage` after the
  frame. Desktop: absolutely positioned at the wall's top-right corner (`.wall-stage` becomes
  `position: relative`). Phone: static, one row under the wall, above freshness. The toolbar keeps
  Move, fullscreen, panel toggle and zoom.
- Fullscreen keeps its own rule (`wall-page.css:1303-1305`) and is re-anchored to the new parent.
- Acceptance is the layout gate, not an opinion: `layout-check.mjs` must still report the board
  uncut at 1440 × 900 and 390 × 844, and the board must not lose height on a phone.

### Task 7 — B8 + B9: a footer that finishes the page

- **B8:** the summary reads **"Contract details"** and renders as a text link (`.wall-link`
  treatment) instead of a full-width bar. The content is unchanged.
- **B9:** the shared footer gains **"Report a problem ↗"** → `GITHUB_ISSUES_URL`. A guide link is
  added only when `VITE_BETA_GUIDE_URL` is set (the banner's own rule: no link, no dead control), so
  an unset variable cannot ship a fake route. Terms stay out: there is no terms page, and inventing
  one is a copy decision, not a tidy-up.
- Tests: footer renders the report link with the issues URL; guide link appears only with the env
  value; the wall summary text is "Contract details".

### Task 8 — B4-inspector: prove it stays short

No behaviour change. A `tile-inspector` test asserts the rendered painter link is 17 characters
(`8…8`) with the full id in `title`/`aria-label`, so the regression cannot return silently. Any
other 64-character id found in wall chrome while doing this is fixed here.

## 4. Verification

From `web/`, Node 22.20.0 (the version `ci.yml` pins):

```
npx vitest run
npx tsc --noEmit
npx vite build
npx vite --mode production --port 5174     # another terminal
node scripts/layout-check.mjs http://localhost:5174
```

Plus a visual pass at 1440 × 900 and 390 × 844 on `/wall` (Look and Paint) for B1/B7/B8, and on
`/stake` signed out for C1/C2/C4.

The PR body carries, per finding, the file changed and the evidence: layout-check before/after,
the test names, and screenshots for the two visual findings (B1, B7).

## 5. What this batch does not prove

- **Still no real wallet.** C1's Connect routing and C2's dead values are asserted with the stub
  session the unit tests already use; the live popup path is batch 4's problem.
- **The phone is emulated.** B5 stays open until someone holds a phone; C10 is measured at 390 px.
- **B1 removes a view.** If anyone linked `?view=age`, nothing breaks (no such parameter exists),
  but the day-old fade is gone by design: the review's point is that it duplicated the price bands.
