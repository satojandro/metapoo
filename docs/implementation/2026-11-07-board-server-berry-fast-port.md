# Board server: a port of Berry Fast

Status: **draft for owner review, 7 Nov 2026. Nothing is built.** Replaces the first draft
(`2026-11-07-board-indexer-spec.md`, removed), which designed a server from scratch (SQLite, SSE,
a `get_pixels` snapshot, its own cost model). The owner was right: Berry Fast already solved this.
This spec copies it and changes only what Meta Poo's contract forces. Background:
`docs/learning/2026-11-05-board-version-polling.md`.

Source read for this spec: [`fastnear/berry-fast`](https://github.com/fastnear/berry-fast) at
`31f1695`, the same commit that note cites. File references below are to that repo.

## 1. Where we are, honestly

| | Berry Club (2020) | Berry Fast (2026) | Meta Poo today |
|---|---|---|---|
| change check | per-row counters (`get_line_versions`) | server push | **one board-wide counter** (`get_board_version`, R2.2) |
| on a change | fetch only the changed rows | apply the pushed paint | **re-read every painted tile** |
| who reads the chain | every browser | one indexer | every browser |

R2.2 copied Berry Club's idle pause and its cheap unchanged-poll check. It did not copy per-row
fetching: `get_pixels` pages in storage order, not by row, so rows would also need a new contract
view. A busy board therefore still costs every open tab a full re-read per change. This server
removes that, the same way Berry Fast does.

## 2. How Berry Fast works (what we copy)

1. **Indexer** (`backend/indexer/`): streams **every final block** with
   `fastnear-neardata-fetcher` (FastNEAR's NEAR Data block stream, optional `AUTH_BEARER_TOKEN`).
   It resumes at `last_processed_block + 1`, or at `START_BLOCK_HEIGHT` the first time. For each
   block, in shard order, it takes `receipt_execution_outcomes` whose receiver is the contract and
   pulls the `draw` calls out. Each becomes a `DrawEvent {predecessor_id, block_height,
   block_timestamp_ms, pixels}`, which it `LPUSH`es to a Valkey list (`draw_queue`). Then it
   sets `last_processed_block`. Processing is serial, so blocks are applied in order.
2. **Valkey** (`docker-compose.yml`, `valkey.conf`): the only store. RDB snapshots every 60 s;
   `noeviction`.
3. **Server** (`backend/server/`, Axum): a consumer moves each event off the queue with
   `RPOPLPUSH` to `processing_queue`, so a crash never loses one. It applies the event to the
   board, then in one pipeline:
   - records it in a sorted set `draw_events` (scored by block time, trimmed to 2 h) for catch-up;
   - removes it from `processing_queue`;
   - broadcasts it to every WebSocket.
4. **Board storage** (`common/src/region.rs`, `valkey.rs`):
   - each 128 × 128 region is **one binary blob of 98,304 bytes**: 6 bytes a pixel, RGB plus a u24
     owner id;
   - `region_meta:{rx}:{ry}.last_updated` holds the region's last write;
   - `account_to_id` / `id_to_account` map owner ids to account names;
   - `pixel_ts:{rx}:{ry}` holds recent per-pixel timestamps;
   - `account_pixel_count` holds tiles per account.
5. **HTTP** (`API.md`, `server/src/api.rs`):
   - `GET /api/region/{rx}/{ry}` returns the blob, with `x-last-updated`;
   - `/meta` and `GET /api/regions?coords=…` return `last_updated` only;
   - `/timestamps` returns pixels written in the last hour;
   - `GET /api/account/{id}` returns the name, immutable and cached for a year;
   - `GET /api/stats/accounts` returns tiles per account;
   - `GET /api/health` returns `last_processed_block` and the queue length.
6. **WebSocket** (`/ws`, `server/src/ws.rs`): the server pushes
   `{"type":"draw","signer","block_timestamp_ms","pixels":[{x,y,color,owner_id}]}`. A client
   that reconnects sends `{"type":"catch_up","since_timestamp_ms":…}` and receives everything
   since then from `draw_events`.
7. **Browser** (`frontend/src/hooks/useBoard.ts`, `lib/region-cache.ts`):
   - caches each region blob and its `last_updated` in IndexedDB;
   - on load, asks for the batch meta and re-fetches only regions newer than its cache;
   - from then on, applies WebSocket draws to the cached blob;
   - never reads board state from the chain.

## 3. What changes for Meta Poo, and why

Berry Fast's contract is an empty `draw()` (`contract/src/lib.rs`). Its server decides who owns a
pixel. Ours is the reverse: the contract charges credits, enforces the rules, and can **reject** a
stroke. That forces four changes and allows one simplification.

| Berry Fast | Meta Poo | why |
|---|---|---|
| reads the `draw` **arguments** from the receipt | reads the board's **`EVENT_JSON` log** (`mpoo_board` `draw` / `draw_many`, `contracts/paid-board/src/lib.rs` `paint()`), and only from an outcome whose status is success | our `draw` can fail (price rose, not enough credits, paused, bad cell). The arguments say what was asked; the log says what the contract stored, with `credits` and `free`. The executor must be the board account, because any contract can log text that looks like this event. |
| one method, `draw(pixels)` | `draw` and `draw_many`; one event per call, entries in applied order | apply entries in order: a tile listed twice ends with the last entry, as on chain |
| the server applies ownership rules (1-hour lock) | the server applies **no rules**; it mirrors what the event says | the contract already enforced them; a second copy of the rules could only disagree |
| RGB per pixel | keep Berry Fast's 6-byte format; RGB from the palette index (`shared/palette.ts`) | the wall's renderer can read the blob as Berry Fast's does; the palette is fixed |
| infinite board, regions open at 20 % fill | **one region, `(0,0)`**: the whole 128 × 128 wall is one 98,304-byte blob | `region_key(0,0)`; the open-regions logic is dropped |

Everything else is copied as is: the neardata fetcher, the Valkey queue with `RPOPLPUSH`, the region
blob, the owner-id maps, the meta endpoints, the WebSocket with 2-hour catch-up, IndexedDB on the
client.

**Start block:** the event format, `credits` and `free` included, has been in the contract since
`203298b` (2 Nov), before the mainnet testing board was deployed (5 Nov). So
`START_BLOCK_HEIGHT` is the board's deploy block (from
`docs/payments/mainnet-test-deployment-2026-11-05.md`), and the server rebuilds the wall from
history. No `get_pixels` snapshot is needed, the same as Berry Fast.

Other board events: `board_expanded` changes the side (blank tiles appear); `state_migrated`
marks an upgrade, which is logged and changes nothing. Unknown events are skipped.

## 4. Additions beyond Berry Fast (each optional, each small)

| addition | Berry Fast has | we add | for |
|---|---|---|---|
| previous holder per write | already read: `apply_event` counts `stolen_from` per owner to keep `account_pixel_count` right (`server/src/board.rs`), but does not broadcast it | add `previous_owner_id` to each broadcast pixel | Right now: "covered 9 of sunny.near's" |
| longer history | 2 h trim | keep `draw_events` 30 days, or a second unbounded list | Since you last looked across devices; tile history |
| earning per account | `account_pixel_count` | `account_earning_count`, from each entry's `free` flag | TOILET a day per holder without `get_earning_cells` calls |

None of these needs a contract change.

## 5. The wall, using it

Behind `VITE_BOARD_SERVER_URL`; empty means today's behaviour.

- **Load:** IndexedDB blob → `GET /api/regions?coords=0,0` → fetch the blob only if newer
  (Berry Fast's `useBoard.ts`, phases 1–4).
- **Live:** WebSocket draws update the blob and the canvas. On reconnect, `catch_up` from the last
  `block_timestamp_ms` seen.
- **Stop polling:** while the socket is open, the 4 s `get_board_version` poll and the `get_pixels`
  walks do not run. A once-a-minute `get_board_version` read stays as a trust check. If the server
  falls behind (`/api/health` block well behind the chain's), or the socket drops, the page goes
  back to today's poll.
- **Unchanged:** prices, credits, stroke quotes, `max_credits`, claims and the drawing key keep
  their chain reads. The server never touches money.

## 6. What it costs, and what it saves

- **Browsers:** today every open, touched tab sends ~900 RPC requests an hour on a quiet wall.
  On a busy, full wall it can send up to ~59,000, because each change is a full re-read through the
  keyed FastNEAR endpoint. With the server, a tab sends about 60 an hour (the trust check). The
  blob is one HTTP fetch, often a cache hit. Updates arrive over the WebSocket.
- **The server:** it streams blocks from NEAR Data, not JSON-RPC. The first draft priced that as
  ~2.6M RPC requests a month, which was wrong. NEAR Data is FastNEAR's block stream, and the
  fetcher takes an optional bearer token. **Ask FastNEAR how it is billed before building.** They
  run Berry Fast on it, so they can say what one board costs.
- **Hosting:** one small machine with Docker (Valkey, indexer, server) and HTTPS, as Berry Fast
  runs. Valkey for one 128 × 128 board holds well under 10 MB, plus the draw history.

## 7. Done when

1. **Replay:** from the deploy block to now, the server's blob equals the chain's `get_pixels`
   tile for tile. The run covers a `draw_many` with a repeated tile, a rejected stroke, and a fake
   event from another account.
2. **Live:** paint from two browsers on testnet; each sees the other's stroke over the WebSocket
   without a `get_pixels` walk.
3. **Fallback:** stop the server; the wall behaves exactly as today.
4. **Cost:** with the socket open, a touched tab makes ≤ ~60 chain requests an hour, counted in
   `read-rpc.ts`.

## 8. Owner decisions

| # | question | recommendation |
|---|---|---|
| B1 | port Berry Fast's Rust backend, or rewrite it in TypeScript like `ops/keeper`? | **Decided (owner, 7 Nov): port the Rust.** About 1,200 lines (indexer, server, common), runs in production, and the neardata fetcher crate is Rust |
| B2 | which additions from §4 | previous holder and 30-day history; earning count when the per-holder figure ships |
| B3 | NEAR Data access and billing | ask FastNEAR first (§6) |
| B4 | when | before any public launch push; after the beta round's signed-in feedback on PR #87 |

## 9. Per-row reads (the open half of R2.2): not planned

R2.2's open item proposed per-row or per-region versions, Berry Club's approach, as an alternative
to this server. With the server, browsers stop reading board state from the chain, so per-row reads
would only help the fallback path (server down or behind). That would need:

- a contract change: per-row counters, plus a row-read view, because `get_pixels` pages in storage
  order;
- a board upgrade;
- a new client loader.

All of that for a path that should rarely run. Per-row stays shelved **unless** the server slips
past a public launch push. In that case, ship per-row counters and the row view in the same upgrade
as `get_earning_cells`, so the board is upgraded once.

## 10. What this draft corrects in the first one

- It invented a server instead of porting Berry Fast.
- It priced NEAR Data block streaming as JSON-RPC requests.
- It added a `get_pixels` snapshot that replay from the deploy block makes unnecessary.
- It proposed SSE and SQLite where Berry Fast's WebSocket and Valkey already work.
