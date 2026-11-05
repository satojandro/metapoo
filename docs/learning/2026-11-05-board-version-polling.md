# Board version polling and the idle pause — 5 November 2026

## Why

FastNEAR's trial (500,000 credits) made the cost of board polling visible. Every visible tab
walked the whole painted set every 4 s: `1 + ceil(painted / 256)` requests, so 2 today (8 cells),
33 half full, 65 on a full 128 × 128. Hermes's estimate, if one request costs one credit: a single
always-visible tab on a full board spends the trial in about 8.5 hours. The browser stays anonymous
(domain-restricted browser keys are a paid FastNEAR feature), so the same load lands on the public RPC.

## Where the design comes from

- **Berry Club** (Evgeny Kuzyakov, 2020; `github.com/evgenykuzyakov/berryclub`, last commit
  `be63065`, July 2022). Every browser still read the chain directly, every second, but cheaply:
  the contract keeps `line_versions`, one counter per row bumped by every draw
  (`contract-rs/pixel-board/src/board.rs:105,121`). The client calls `get_line_versions` and fetches
  only the rows whose counter moved (`frontend/src/App.js:677-720`). It also stops refreshing after
  10 minutes without input (`MaxWorkTime`, `App.js:64,683`; mouse activity resets it, lines 520 and
  554), and skips hidden tabs (line 690). A `#watch` mode kept refreshing for display screens.
- **Berry Fast** (FastNEAR, 2026; `github.com/fastnear/berry-fast`, commit `31f1695`). The same
  idea taken all the way: browsers never read board state from the chain. An indexer reads blocks
  through NEAR Data, a server keeps the board in Valkey, and browsers load region blobs over HTTP,
  then receive each paint over a WebSocket and cache regions in IndexedDB. Its contract's `draw()`
  is empty; transactions exist only to be indexed.

We took Berry Club's two cheap ideas and left Berry Fast's server for later:

| | Berry Club | Berry Fast | Meta Poo now |
|---|---|---|---|
| Change check | per-row counters | server push | one board-wide counter (`get_board_version`) |
| On a change | fetch changed rows | apply the pushed paint | re-read every painted cell |
| Idle tab | stops after 10 min | n/a (push) | stops after 10 min (`BOARD_IDLE_PAUSE_MS`) |
| Who reads the chain | every browser | one indexer | every browser |

One counter instead of per-row: our `get_pixels` pages in storage order, not by row, so per-row
counters would need a new row-read view as well. One counter removes the cost of an *unchanged*
poll, which is most polls. A busy board still costs a full read per change; the next steps would be
per-region versions or the Berry Fast server.

## What changed

- `contracts/paid-board`: `get_board_version() -> u64`, bumped once per successful `draw` /
  `draw_many` call. Raw key `board_version`, outside `Board`: no migration, and a board upgraded to
  this code reads `0` until its next paint. Not bumped by reads or `expand_board`.
- `web/src/contract.ts`: `fetchAllPaintedPixels({ knownVersion })`. Same version → `{ unchanged }`
  after one call. Otherwise the pages are pinned to the version's block, which replaces the old
  separate `block` request. A board without the view (MethodNotFound) is learned once per page and
  keeps the old full walk.
- `web/src/pages/wall/board-controller.ts`: polls, tab return, reconnect, after-draw and resume
  pass the cached version. First load and Refresh always walk every cell. No input for 10 minutes
  stops polling, with a visible "paused" line; the next input or tab return reloads.

## Evidence

- Contract: `cargo test` 206 passed; clippy `-D warnings` clean; release wasm builds
  (634,394 B, 722 B more than `main`). With the bump removed, 4 of the 5 new tests fail
  (`every_successful_paint_call_bumps_the_version_once`, `a_rejected_paint_leaves_the_version_alone`,
  `reads_and_growing_the_board_leave_the_version_alone`,
  `a_board_without_the_version_key_reads_as_zero_and_counts_from_there`).
- Web: `npm test` 822 passed; `npm run build` green. Against the old source, 8 of the 10 new tests
  fail; the 2 that pass guard behaviour that must not change (a first load still walks; a watched
  wall stays live).
- Live state, read 2026-11-05: neither board3 nor board5 holds a key named `board_version`. board5
  holds keys under a `v…` prefix, which is why the key is not `v`.

## What this does not prove

Nothing here ran on chain. Until a board is deployed with this code, every page takes the fallback
(full walk per poll); only the idle pause helps today. Proof needs, on the testnet board the page
uses: code hash before and after; `get_state_version`, `get_pixels` total and a few cells unchanged;
`get_board_version` = 0; one `draw` → 1; one `draw_many` → 2; one rejected paint → still 2; and the
page's status line reading "Board unchanged at block …" between paints.

Deploy with the board account's full-access key, **not** `upgrade()`: `upgrade()` calls `migrate`,
which rejects state that is already version 2 (see `traps.md`, Contract state).
