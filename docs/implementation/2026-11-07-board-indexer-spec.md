# Board indexer ("Berry Fast-style server"): spec

Status: **draft for owner review, 7 Nov 2026.** Nothing here is built. No contract change is needed:
the server works from the board's existing paint event and views. Option 1 of the 7 Nov discussion
on [PR #87](https://github.com/satojandro/metapoo/pull/87); option 2, a v2.0.0 event that carries
each tile's previous holder, was declined because of the log-size limit (see §3.4).

## 1. What it is for

The wall reads the board straight from the chain. That is right for anything that costs money, and
it will stay that way. It cannot answer questions about the past, because the board only stores
the latest paint on each tile:

| wall feature | today (chain reads only) | with the indexer |
|---|---|---|
| Right now | latest paint per tile; a covered stroke shrinks or vanishes | every stroke, with "covered 9 of sunny.near's tiles" |
| Since you last looked | this browser's memory only (`wall-yours.ts`); misses tiles covered and won back | per account, any device, exact |
| Tile card | painter and age now | full history of the tile: who held it, for how long |
| Freshness | poll `get_board_version` every 4 s, walk `get_pixels` on change (R2.2) | changes pushed to the page as they happen |
| Leaderboards over time | none | "most tiles covered this week", longest-held tile, and the like |
| RPC bill | grows with visitors × time on page × activity (§7.3) | flat: the server reads the chain once for everyone |

The backlog row R2.2 already names this as the follow-up for a busy board: a changed board still
walks every painted cell once per change.

## 2. Trust model

**The indexer is a cache of public chain data, never a source of truth.**

- Nothing that spends money reads the indexer: prices, credits, stroke quotes, `max_credits`,
  claims and the drawing key keep their chain reads. The paint path does not change.
- Every number the indexer serves can be checked against the chain. It says which block it is
  current to (§5), and the wall checks that against `get_board_version` (§6.3).
- If the indexer is down, slow or wrong, the wall falls back to what it does today. No feature
  may depend on it for correctness, only for richness.
- The server holds no keys and signs nothing. It needs only an RPC/data credential for reads.

## 3. Inputs

### 3.1 A snapshot, once

On first start (or a rebuild), read the whole wall pinned to one block `B`:

1. `get_board_version` and `get_board` at `B`: the version and the side.
2. `get_pixels(from_index, 256)` at `B`, page by page until `next_from_index` is null. Each row:
   `{x, y, color, artist, written_at_ns}`.

Pin every call to the same block (`block_id: B`). This is the same rule the wall's loader follows
(`web/src/load-board.ts`, R2.2): pages read at different blocks can mix two states. Regular RPC
keeps recent blocks only; a `B` older than about two days needs the archival host
(`docs/ops/fastnear-rpc.md`).

The snapshot does **not** say whether a tile's latest paint was free. Mark those tiles
`free = unknown` until their next paint event. Holder earnings come from the board's own
`get_earning_cells` (§5), never from this flag.

### 3.2 The paint event, from block `B + 1` on

Every successful `draw` / `draw_many` logs exactly one event, written last in `paint()`
(`contracts/paid-board/src/lib.rs`):

```
EVENT_JSON:{"standard":"mpoo_board","version":"1.0.0","event":"draw_many",
  "data":[{"x":12,"y":40,"color":3,"artist":"sunny.near",
           "written_at_ns":1762480000000000000,"credits":4,"free":false}, …]}
```

- `event` is `"draw"` (one entry) or `"draw_many"` (1–64 entries, `MAX_DRAW_BATCH`).
- One entry per stroke entry, **in the order the contract applied them**. The same tile can appear
  twice in one stroke: apply in order, so the last entry wins. That is the contract's own rule.
- `artist` is the predecessor (the painter). With a drawing key that is still the painter's
  account, because a function-call key signs as its account.
- `credits` is what that entry cost; `free` is true for a free first paint (F1) or a happy-hour
  paint (F2).

Other board events to handle:

| event | meaning for the indexer |
|---|---|
| `board_expanded {from, to}` | the side grew; new tiles are blank. Update the side. |
| `state_migrated {from, to}` | the board was upgraded. Re-check §3.4 and reconcile (§7.2). |
| `credits_purchased` (`mpoo_payments`) | not needed for the wall features above; keep for later stats |

### 3.3 Rules for reading events

1. **Final blocks only.** Use finalized blocks, not optimistic ones, so nothing has to be rolled
   back. NEAR finality is a few seconds; that is the indexer's freshness floor.
2. **Successful receipts only.** Apply an event only if the receipt's execution outcome is a
   success (`SuccessValue` / `SuccessReceiptId`). The contract logs at the very end of `paint()`,
   so a rejected stroke normally logs nothing. Checking the status also covers a receipt that runs
   out of gas after the log line.
3. **Only the board's own receipts.** The executor account must be the board contract
   (`VITE_CONTRACT_ID`: `fcd66acf…` on the mainnet testing round, `board3.metapoo-player1.testnet`
   on testnet). Anyone can log a string that looks like this event from their own contract.
4. **Order:** block height, then the order of execution outcomes within the block. All of one
   contract's receipts in a block run on its shard in order, so this ordering is the order the
   board applied them.
5. **Unknown fields are ignored and unknown events are skipped**, so an additive contract change
   cannot stop the indexer. A different `version` major stops it, with an alert, until a human looks.

### 3.4 Why the event stays as it is

The event does not say who held each tile before. The indexer knows anyway: it looks the tile up in
its own copy before applying the entry. Adding `previous_artist` to the event was considered and
declined. NEAR caps one call's logs at 16,384 bytes. A 64-tile stroke by an account with a
64-character name already logs about 9.3 KB, and a second account name per entry would take that
to about 15 KB, too close to the limit. Doing it safely means a slimmer v2.0.0 format (painter and
time once per event), which breaks existing readers. Not worth it while the indexer can derive the
same thing.

## 4. Data source for blocks

Pick one at build time. **Check each option's current API and pricing then, not from this
document** (house rule, roadmap R4):

| option | notes |
|---|---|
| FastNEAR transaction index (`POST /v0/account` for the board, `from_tx_block_height`, `is_success`; then `/v0/transactions` for the new hashes) | already used by `/money` (`buyback-ledger.ts`). Polled every few seconds it is the cheapest option (§7.3). Check that the transaction call returns the receipts' logs, and keep the index's 2.4–3.4 s lag in mind. **Try first.** |
| FastNEAR block data API (`neardata`) | final blocks as JSON, with receipts and execution outcomes including logs. Simple and complete, but one request per block. |
| NEAR Lake (S3 buckets) | the reference indexer data source; requester-pays S3 reads, an AWS account needed |
| JSON-RPC `block` + `chunk` + `EXPERIMENTAL_tx_status` | no new provider, but several calls per block; fine for a test run, wasteful for production |

Following blocks means reading every one, because a skipped block can't be told apart from an
empty one: at about one a second that is ~86,400 a day. The transaction index avoids that by asking
only about the board's own transactions, which is why it is tried first. Whichever is chosen, the
replay test (§8) and the hourly reconcile (§7.2) are what prove it misses nothing.

## 5. What the server stores and serves

### 5.1 Storage

SQLite to start (one file, one process); Postgres only if a second reader process is needed.

| table | rows | purpose |
|---|---|---|
| `tiles` | one per painted tile | current `color, artist, written_at_ns, free (true/false/unknown), since_block` |
| `writes` | one per event entry | `block, receipt_id, tx_hash, idx, x, y, color, artist, previous_artist, written_at_ns, credits, free` |
| `strokes` | one per event | `block, tx_hash, artist, tiles, credits, covered_count, written_at_ns`, for the feed |
| `cursor` | one | last fully applied block, the board version and side at that block |

Each block is applied in one database transaction together with the cursor update. A crash
therefore resumes at the last whole block, never halfway through one.

Size: a `writes` row is about 120 bytes, so a million paints is about 120 MB. The wall has 16,384
tiles at most.

### 5.2 HTTP API (read-only, public, CORS open, cacheable)

Every response carries `{"block": <height>, "board_version": <n>}`: what it is current to.

| endpoint | returns | wall feature |
|---|---|---|
| `GET /v1/status` | cursor block, board version, lag in seconds, source | health; the wall's trust check |
| `GET /v1/wall` | every painted tile `{x, y, color, artist, written_at_ns}`, the side, at the cursor block | the page's first load, instead of walking `get_pixels` |
| `GET /v1/strokes?limit=20&before=<block>` | latest strokes, each with `covered: [{account, tiles}]` | Right now |
| `GET /v1/accounts/{id}/since?block=<n>` | the account's tiles covered since block `n`, by whom, and tiles won back | Since you last looked |
| `GET /v1/accounts/{id}` | tiles held, first paint, strokes, tiles covered by them / of theirs | Your tiles, a profile later |
| `GET /v1/tiles/{x}/{y}/history?limit=20` | the tile's writes, newest first | Tile card history |
| `GET /v1/stream` | Server-Sent Events: one message per applied stroke (the `strokes` row plus its entries) | live wall |

"Since" takes a **block height**, not a time. The page stores the block from the last response it
used, per account. No account login is needed: everything is public chain data.

SSE, not WebSockets: one direction, works through proxies, and the browser reconnects on its own.
The page's existing poll stays as the fallback.

## 6. How the wall uses it

Behind a config flag (`VITE_INDEXER_URL`; empty means off, as today). Every use falls back to the
current behaviour when the indexer is off, unreachable, or behind.

### 6.1 Features
- **Right now** (`wall-story.ts`): use `/v1/strokes` when available. Covered strokes stay in the
  list ("covered 9 of sunny.near's"). The label "Latest paint on each tile" goes away in this mode.
- **Since you last looked** (`wall-yours.ts`): use `/v1/accounts/{id}/since?block=…`. The
  "this browser remembers" note goes away, and won-back tiles are counted.
- **Tile card history** (`tile-inspector.ts`): a "History" row with the last few holders. It's a
  new read on hover, so throttle it as the price quote already is.
- **First load and live updates replace the poll.** Load the wall from `/v1/wall`, then apply each
  SSE stroke to the pixel cache, as a confirmed stroke's receipt already does (`c547bcd`). While the
  stream is healthy the page does **not** run the 4 s `get_board_version` poll or the `get_pixels`
  walks (R2.2). Only the trust check (§6.3) still reads the chain, once a minute. When the stream
  drops or falls behind, the page goes back to today's poll until it recovers. This is where the
  savings come from (§7.3); an indexer that only adds features costs more than it saves.

### 6.2 What does not change
Paint, prices, credits, quotes, `max_credits`, claims, the drawing key, the price and age views, and
`get_earning_cells` for holder earnings.

### 6.3 The trust check
Once a minute while the stream is healthy (instead of the 4 s poll), read `get_board_version`
from the chain and compare it with the indexer's (from `/v1/status` or the last SSE message). If the indexer is behind by more than a few versions
or 30 s, hide indexer-only features until it catches up. If its version is *ahead* of the chain's,
the RPC node is lagging; trust neither until the next poll.

## 7. Running it

### 7.1 Where
Next to the keeper and buyback services in `ops/` (`ops/indexer/`), Node + TypeScript, the same
config and logging conventions (`ops/keeper/README.md`: env vars, a check before start, one JSON
line per event). One process: follower, writer and HTTP server. Hosting: wherever the keeper runs
for testing (launchd today); a small always-on host with HTTPS for the public page.

### 7.2 Keeping it honest
- **Reconcile hourly.** Re-read the whole wall pinned at the cursor block and diff it against
  `tiles`. Any difference means a bug or a missed block: log it as an error with the tiles involved,
  rebuild from a fresh snapshot, and alert.
- **After `state_migrated`** (a board upgrade), reconcile at once.
- **Gaps:** if the data source skips a height, stop and alert. Never jump the cursor.

### 7.3 Cost: the server only pays for itself if it replaces the browsers' polling

The live page reads through the keyed FastNEAR endpoint (the deploy guard in
`docs/ops/fastnear-rpc.md` refuses a bundle without the key), so **every visitor's reads are billed
to the project.** Estimates below count one JSON-RPC request as one credit, per that document;
only the FastNEAR dashboard is a real meter.

**Today, per open wall tab** (stops 10 min after the last touch, `BOARD_IDLE_PAUSE_MS`):

| board state | requests an hour |
|---|---|
| quiet: `get_board_version` every 4 s | ~900 |
| changing, 665 painted (3 `get_pixels` pages per change) | up to ~3,600 |
| changing, full 128 × 128 (65 pages per change) | up to ~59,000 |

**With the indexer, per open tab:** 0 for the first load (`/v1/wall`), 0 for updates (SSE), and
~60 an hour for the once-a-minute trust check. The indexer's own reads are flat, whatever the
number of visitors:

| how the server follows the board | requests a month |
|---|---|
| every block (§4, any source) | ~2.6M |
| FastNEAR's per-account transaction index for the board, every 2 s / 5 s | ~1.3M / ~0.5M, plus one `/v0/transactions` call per batch of up to 20 new paints |
| hourly reconcile (§7.2), full board | ~47k |

**Break-even:** ~2.6M a month is about 2,900 tab-hours of today's quiet-board polling, roughly
four tabs open around the clock. A busy, full wall breaks even with less than one. Above that the
indexer saves money, and the saving grows with traffic: a launch day with a few hundred painters
costs the browsers far more than the server.

**Check at build time (§4):** whether the transaction index returns the event logs (or one more
call per batch does), its lag (2.4–3.4 s measured on 5 Nov), and whether FastNEAR's block data is
billed per request at all. The cheapest source that passes the replay test (§8) wins.

## 8. Acceptance

1. **Replay test:** from a recorded snapshot and a recorded sequence of blocks (including a
   `draw_many` with a repeated tile, a rejected stroke with no log, a failed receipt carrying a log,
   a fake event logged by another contract, and a `board_expanded`), the final `tiles` equals the
   board's `get_pixels` at the last block, and `writes` has exactly the successful entries in order.
2. **Live test on testnet:** run against `board3.metapoo-player1.testnet` for 24 h while painting
   from two browsers. The hourly reconcile finds zero differences.
3. **Fallback test:** with the indexer stopped, the wall behaves exactly as it does without
   `VITE_INDEXER_URL`.
4. **Lag test:** pause the follower for 2 minutes; the wall hides indexer-only features, then shows
   them again after catch-up without a reload.
5. **Cost test:** with the stream healthy, an open, touched wall tab makes at most ~60 chain
   requests an hour (count them in the page's read transport). With the stream stopped, it returns
   to today's numbers.

## 9. Decisions for the owner

| # | question | recommendation |
|---|---|---|
| I1 | build it now, or after the beta round? | before any public launch push: that is when browser polling gets expensive (§7.3). After the beta round's signed-in feedback on PR #87 |
| I2 | data source | the cheapest that passes the replay test: try FastNEAR's transaction index first, block data second (§7.3) |
| I3 | host | the same machine as the keeper for testnet; a small managed host with HTTPS for mainnet |
| I4 | how much history to keep | all of it: about 120 MB per million paints |
| I5 | public API, or for the wall only? | public and read-only: it is all chain data, and others can build on it |

## 10. Out of scope

Notifications (email or push when your tile is covered) are possible later, because §5 has
everything they need, but they bring a user-data question. Also out of scope: a v2.0.0 event,
moderation, and any write path.
