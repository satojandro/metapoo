# Wall journey review, PR #87, and what comes next: 7 November 2026

Session record and handover. A fresh session should start here, then read the documents it
links. Branch `claude/quirky-lovelace-e800wo`, PR
[satojandro/metapoo#87](https://github.com/satojandro/metapoo/pull/87): **open, not merged.**

## Why

Owner, 7 Nov: How it works, TOILET, Stake and Where the money goes are well designed; the wall
page felt bare: "just the painting experience", with the useful information hidden on other pages.
Review and proposal (private artifact, owner's account): "Wall Journey Rethink". It compared the
pages and mapped the journey (arrive, care, paint, hold, return); the wall served only two of those
steps.

## What PR #87 contains

| commit | what |
|---|---|
| `6210f06` | Phase 1: the earning line, Who holds the wall, three rule cards below the wall linking to the story pages, empty Tile card hidden, tighter phone beta banner |
| `132e551` | Phase 2: Right now feed (strokes grouped from the pixel cache; tap flies there), Tile card "Cheaper: 1 credit in 15 min", paint footer "Earns up to N TOILET a day", and the correction below |
| `b54901d` | Phase 3: Your tiles (count, Show my tiles, the existing TOILET claim panel), "since you last looked" from this browser's memory |
| `d0d6757` | (owner) screen-reader punctuation in holder rows and Right now items |
| `3e5ea8a` | Pulse strip under the wall (fill, blank, wet, happy hour; the wall gives up 46 px, the panel grows to match); contract view `get_earning_cells`; TOILET a day per holder; screen-reader punctuation visually hidden |
| `a1bf101` … `5b1670c` | Board server spec, rewritten as a port of Berry Fast (below) |

Owner constraints kept throughout: a tile shows on **hover**, not only on tap; **no "Paint this
tile" button while painting**; no camera maths, palette, key-scope or allowance changes.

Evidence: `npm test` 915/915, `npm run build` clean; `cargo test` 206/206, wasm32 release build OK.
Checked against the live mainnet testing board (`fcd66acf…`) at 1440×900, 1280×720 and iPhone 13.
**Not verified with a wallet:** the paint-footer earnings line and Your tiles (unit tests and a
sample-value layout check only).

## Before merging #87

1. **Signed-in check with a real wallet:**
   - hover a tile: no paint button while painting;
   - select a stroke: "Earns up to … TOILET a day";
   - Your tiles shows your count and claimable TOILET;
   - reload: the "since you last looked" line appears.
2. **Contract:** `get_earning_cells(account_id) -> u32` is in `contracts/paid-board/src/emission.rs`.
   It is read-only, needs no migration, and is **not deployed**. Until the board is upgraded, Who
   holds the wall shows tiles only (MethodNotFound, handled). Deploying is an owner decision.
3. **Backlog** (PRs do not edit `docs/backlog.md`; the merger does):
   - new row: wall journey phases 1–3 + pulse strip + TOILET a day per holder, with the merge
     commit;
   - R2.2's open per-row item: superseded by the board server, see the spec's §9.
4. **Docs-only commits** (the server spec, this record) went on the PR branch because the
   session could push only there. AGENT.md says docs go straight to `main`; they land on `main`
   with the merge.

## Owner decisions recorded this session

| decision | where |
|---|---|
| Phases 1–3 of the journey proposal: yes | PR #87 |
| A real pulse strip under the wall; the height comes back when the beta banner goes | `3e5ea8a` |
| TOILET a day per holder: yes, via a contract view | `get_earning_cells` |
| "Since you last looked": not essential | stays as built, per browser |
| Board server: port Berry Fast, **in Rust** | `docs/implementation/2026-11-07-board-server-berry-fast-port.md` §8 B1 |
| Per-row reads (R2.2 open item): shelved unless the server slips past a launch push | same spec, §9 |
| No v2.0.0 paint event; the existing `draw` / `draw_many` event is enough | same spec, §3 |
| **Full-window wall: a hybrid, not a change of direction** (below) | this record |

### Full-window wall: the decision

Mockup (private artifact, owner's account): "Full-Window Wall", four artboards, live wall image.
Owner's verdict:

- Meta Poo has a whole game that deserves attention and easy navigation. **Full window is an
  extra feature, not a new direction.**
- **Desktop keeps the logo, the menu bar, and the wall's story** (everything PR #87 added).
- **Add one button that enters full-screen mode.**

So the next wall UI task is a "Full screen" button on today's page:
- it enters a full-window view of the wall;
- the mockup's ideas (floating controls, a hover card, a minimap when zoomed, a floating paint
  dock) apply inside that mode only;
- leaving the mode restores the normal page, in the same place.

The mockup's drawer, Menu-only nav and beta pill are **not** adopted for the normal page.

## Board server (Berry Fast port): status

Spec: `docs/implementation/2026-11-07-board-server-berry-fast-port.md`. Nothing is built. Source
read: `fastnear/berry-fast` at `31f1695`.

The shape is a straight port:
- the neardata block stream feeds a Valkey queue;
- the Axum server writes one 98,304-byte region blob (the whole wall), the HTTP meta and blob
  endpoints, and the WebSocket with 2 h catch-up;
- the browser caches the blob in IndexedDB.

Changes our contract forces:
- read the board's `EVENT_JSON` log from successful outcomes, not the call arguments (our `draw`
  can reject);
- handle `draw` and `draw_many` in order;
- apply no ownership rules (the contract already did);
- convert palette index to RGB.

Replay starts at the board's deploy block: the event format predates the 5 Nov deploy. **Open:**
ask FastNEAR how NEAR Data is billed (B3), and when to build it (B4: before a public launch push).

## What went wrong, and what to do differently

- **Multiplied tiles by the rate.** Phase 1 showed "every tile you hold earns 86.4 TOILET a day"
  and a per-holder figure of tiles × rate. Free paint holds a tile but earns nothing
  (`free_paint_earns_nothing`). Corrected in phase 2; `get_earning_cells` is the right input. →
  traps.md, Painting model.
- **Visible punctuation for screen readers.** Commas added for screen readers showed on screen as
  ", just now". Fixed with visually hidden spans. → traps.md, Painting model.
- **Claimed the contract logs no paint event.** It does. A search for log lines containing
  "draw|paint|pixel" missed `paint()`'s `env::log_str`, because that line names neither. Read the
  function, don't grep for a word you expect.
- **Designed a server from scratch** (SQLite, SSE, a `get_pixels` snapshot) and priced block
  streaming as RPC credits, when `docs/learning/2026-11-05-board-version-polling.md` had already
  identified Berry Fast as the model. Then said the repo "already fetches only changed rows"; it
  doesn't (one board-wide counter). → traps.md, Repository: read the learning records and prior
  research before designing.
- **A full redesign when an addition was wanted.** The full-window mockup replaced the page's
  structure; the owner wanted a mode on top of it. Ask whether a new idea replaces or adds before
  mocking up a whole layout.

## Where things are

| thing | where |
|---|---|
| wall story module | `web/src/pages/wall/wall-story.ts` (+ test) |
| Your tiles module | `web/src/pages/wall/wall-yours.ts` (+ test) |
| Tile card "Cheaper" | `web/src/pages/wall/tile-inspector.ts` `cheaperIn` |
| stroke earnings hook | `RepaintChrome.onQuote` in `web/src/pages/wall/repaint-price.ts` |
| contract view | `contracts/paid-board/src/emission.rs` `get_earning_cells` |
| server spec | `docs/implementation/2026-11-07-board-server-berry-fast-port.md` |
| Berry Fast source used | `fastnear/berry-fast` @ `31f1695` (not vendored) |
