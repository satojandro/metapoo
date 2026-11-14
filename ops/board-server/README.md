# Board server

A port of FastNEAR's [Berry Fast](https://github.com/fastnear/berry-fast) backend (read at
`31f1695`) for the Meta Poo wall. Spec and the reasons for every difference:
[`docs/implementation/2026-11-07-board-server-berry-fast-port.md`](../../docs/implementation/2026-11-07-board-server-berry-fast-port.md).

Berry Fast has no LICENSE file, so nothing here is copied verbatim. The structure, the Valkey
key names, the region blob, the HTTP paths and the WebSocket messages follow it; the code is new.

```
FastNEAR tx index (board's transactions) ──► indexer ──LPUSH──► Valkey draw_queue ──LMOVE──► server ──► HTTP + /ws
        ▲ polls only while someone watches, or right after a paint hint ◄── server (viewers, POST /api/hint)
```

## What it costs

Berry Fast's indexer reads **every final block**. On mainnet (600 ms blocks) that is
~6,200 requests an hour, whether or not anyone paints or looks. The first deploy (`183efa9`)
ran it that way, and the owner's FastNEAR dashboard showed ~6,000 an hour on a board that had
been idle for nine hours. The old browser-only polling cost **zero** with no tab open.

The indexer now reads FastNEAR's **transaction index** for the board's own transactions
(`INDEX_MODE=txindex`, the default). It polls only when that is useful (`common/src/demand.rs`).
Measured against mainnet on 7 Nov:

| situation | indexer requests |
|---|---|
| nobody watching (no WebSocket open) | **0** |
| someone watching, nothing painted | 2 per poll; at `POLL_MS=30000`, **240/hour** |
| a tab paints | its `POST /api/hint` makes the indexer poll within ~1 s, then every 2 s for up to 12 s until the paint shows: ≤ 12 requests |
| new paint found | + 1 per 20 new transactions |
| cold start (whole history) | **20 requests** for the testing board's 274 board events, 666 tiles |

The index is read **without a key** unless `FASTNEAR_API_KEY` is set, so none of this lands on
the RPC key's dashboard. The wall closes its socket when its tab is hidden or idle
(`BOARD_IDLE_PAUSE_MS`), so an abandoned tab does not keep anyone "watching".

A viewer who arrives after a quiet spell gets a catch-up poll at once. It reads only the
board's transactions since the watermark, however long the gap.

- **`common/`**: the 6-byte-per-pixel region blob, the `mpoo_board` event parser, and
  `BoardState::apply_draw`. It is pure code, and it is where the tests for the board rules live.
- **`indexer/`**: finds the board's `EVENT_JSON` logs, only from **successful** outcomes
  **executed by the board**, and queues them in chain order.
  - Events and `last_processed_block` are written in one transaction.
  - `txindex` mode (default, `indexer/src/txindex.rs`) queues an event only from a final
    transaction, and only up to a cut below any unfinished one, so nothing is queued twice or
    out of order.
  - `stream` mode (Berry Fast's every-block reader) is kept for bounded replays
    (`END_BLOCK_HEIGHT`). Do not leave it running: it is the ~6,200/hour mode.
- **`server/`**: applies queued events and serves the mirror.
  - Each event is one `MULTI`/`EXEC`: board, counts, catch-up history, `last_applied_position`
    and the `LREM` all commit together.
  - An event at or below `last_applied_position` is dropped, so a re-delivered block cannot
    double-count.
  - The same transaction appends each applied tile to the **draw log** (`draw_history`) and
    records **cover events** for the account whose tile was painted over. See "History and
    covers" below.
  - On start, an event stranded in `processing_queue` goes back to the head of the queue.
  - A failed apply is **retried** with backoff, on a reconnecting connection, rather than
    ending the consumer: skipping would leave a permanent gap, and exiting would freeze the
    mirror. `/api/health` reports the consumer's liveness, so a stuck one is visible.
  - **A Valkey outage heals by itself.** `common/src/valkey.rs` bounds every reply (5 s) and
    every connect (2 s), and caps the reconnect backoff at 1 s.
    - With redis 0.27's defaults, an outage blocked every command for minutes after Valkey was
      back: the reconnect backoff multiplies by 100.
    - `server/tests/outage.rs` SIGKILLs Valkey under a running consumer and restarts it. The
      next event must apply without a server restart; it now does in under a second.

## Differences from Berry Fast (spec §3–§4)

| Berry Fast | here |
|---|---|
| reads `draw` call args | reads the board's `EVENT_JSON` log (`draw`, `draw_many`, `board_expanded`; `state_migrated` is noted and skipped) |
| server enforces the 1-hour lock | **no rules**: the contract already decided; entries it would have rejected are logged as divergence, not applied |
| infinite board, regions open at 20 % | one region `(0,0)` = the whole 128 × 128 wall; `INITIAL_SIDE` and `board_expanded` set the paintable side |
| RGB from the hex arg | RGB from the palette index, palette read from `shared/board.json` at compile time |
| `account_pixel_count` | the same, plus `account_earning_count` from each entry's `free` flag. Both mirror `paint()`'s holder bookkeeping, so they equal `get_cells_owned` / `get_earning_cells` |
| broadcast `{x,y,color,owner_id}` | also `previous_owner_id`, both account names, `free`, `credits`, `written_at_ns`, `receipt_id` |
| — | `GET /api/region/0/0/written-at`: u64 LE `written_at_ns` per tile (131,072 B) |
| processing queue never recovered; apply not atomic | recovered on start; apply is one transaction with a position guard; a failed apply retries instead of ending the consumer |
| catch-up history ordered by score only | member prefixed with the event position, so draws in one block still replay in applied order |

## API

| route | returns |
|---|---|
| `GET /api/region/0/0` | 98,304 B blob. Pixel `(x,y)` is at `(y*128+x)*6`: R, G, B, owner id (u24 LE, 0 = empty). Headers `x-last-updated` (ms), `x-last-block`, `x-board-side` |
| `GET /api/region/0/0/written-at` | 131,072 B, u64 LE per tile, same order and headers |
| `GET /api/regions?coords=0,0` / `GET /api/region/0/0/meta` | `last_updated` only |
| `GET /api/region/0/0/timestamps` | `[[x, y, ms], …]` for tiles written in the last hour |
| `GET /api/account/{owner_id}` | the account name (immutable, cached for a year) |
| `GET /api/stats/accounts` | `[{account_id, pixel_count, earning_count}]`, largest first |
| `GET /api/account-covers?account=<id>&since_ms=<ms>` | AWAY-A (return-and-growth spec §1.2). `{"count": n, "by": [{"account": id, "tiles": n}], "first": {"x": x, "y": y}}`: how many of `account`'s tiles other accounts painted over since `since_ms`. `count` and each `tiles` count **distinct** tiles (a tile covered, won back and covered again counts once; one tile covered by two accounts counts once in `count` and once for each of them). `by` is most tiles first, ties by account id. `first` is the earliest covered tile in the window, and **`null` when `count` is 0** (also for an account never covered). The window never starts earlier than 30 days ago (the sets keep no more). `account` is trimmed and lowercased; a missing or invalid account id, or a `since_ms` that is missing or not a whole number, is **400**. 503 if Valkey does not answer in 2 s. `Cache-Control: no-cache, must-revalidate` |
| `GET /api/health` | `status` (`ok` / `degraded` while retrying / `stalled` when the consumer has not ticked for a minute), `last_processed_block`, `last_applied_block` (with nothing queued or in processing, everything through `last_processed_block` is applied, so it reports that; otherwise the last applied event's block), `queue_length`, `side`, `painted_tiles`, `consumer_last_tick_ms`, `consumer_failures` |
| `POST /api/hint` | 202: poll the index now, a tab just painted. 429 within 2 s of the last accepted hint. Carries no data |
| `GET /ws` | pushes `{"type":"draw",…}` and `{"type":"board_expanded",…}`. Send `{"type":"catch_up","since_timestamp_ms":n}` after a reconnect |

## History and covers

`draw_events` is the WebSocket catch-up buffer: a sorted set trimmed to `CATCHUP_RETENTION_MS`
(2 h by default) on every write. It is not a history. Two keys are (`common/src/history.rs`):

| key | what | kept |
|---|---|---|
| `draw_history` | Stream. One entry per applied tile, fields `block, at_ms, x, y, color, by, free` (spec §4.2). Id `<position>-<index>`: the event's `block × 10⁶ + place in block`, then the tile's place in the event, so ids are fixed by the chain and a timelapse can page by block with `XRANGE draw_history <block × 10⁶> +`. Tiles the contract rejected are not in it. **`board_expanded` is in it** as a second kind of entry, in order with the draws: id `<position>-0`, fields `kind = expand, block, at_ms, from, to`. Draw entries have no `kind` field and did not change, so a stream written before expansions were logged reads as before. | **forever**: no `MAXLEN`, nothing trims it |
| `draw_history:genesis` | Hash `{start_block, initial_side}`, written by the backfill once it has certified that the log starts at the deploy block. Absent, the log starts where the consumer began writing it. | until the mirror is wiped |
| `draw_history:epoch` | A number naming this copy of the log: the ms at which it was first read, replaced whenever the backfill rewrites the stream. Part of every cacheable history URL. | — |
| `covers:<account>` | Sorted set per account whose tile someone else painted over, scored by `at_ms`. Member `<position>:<index>:{"x","y","by","at_ms"}`, so writing the same cover twice is one member. Painting over your own tile is not a cover. | 30 days: trimmed on each write, the key expires 30 days after its last write, covers already older than that are never written |

Both are written in the consumer's `MULTI`/`EXEC` with the board, so they cannot disagree
with it. They are as durable as the board itself: `valkey.conf` snapshots (RDB) every 60 s, so
a Valkey crash can lose up to a minute of board, log and `last_processed_block` **together**,
and the indexer re-queues that minute. Turning on AOF would narrow that window for all three;
it is not done here.

**Backfill, once.** The log starts when this version is deployed. To fill it from the deploy
block (spec §4.2), with the server and indexer running:

```bash
docker compose run --rm indexer board-history backfill   # uses .env: CONTRACT_ID, START_BLOCK_HEIGHT, INITIAL_SIDE
```

It reads the board's events from `START_BLOCK_HEIGHT` through the mirror's
`last_applied_position` from the transaction index (~20 requests for the testing board's
history), replays them on an empty board with the consumer's rules, and **writes nothing**
unless the replay equals what the consumer has already logged up to that point. It then
builds the log in `draw_history:backfill`, and one Lua script copies across the live entries
newer than the replay and renames it over `draw_history` (the consumer cannot append in
between). It re-adds the last 30 days of covers and ends with the tip check. Running it twice
changes nothing: the second run finds the log equal to the replay and does not rewrite it.

It replays `board_expanded` too. A log written by a server from before expansions were logged
holds the draws but not the growth; the backfill adds the missing expansions (so **a deploy
that already ran the backfill with the older version should run it once more** if its board
has ever grown; on a board that never grew a second run only writes the marker). When it
succeeds it writes `draw_history:genesis`, which is what lets `/api/history/head` say
`complete: true`, and a rewrite replaces `draw_history:epoch`.

The replay numbers events the way the `txindex` indexer does. A mirror built by the `stream`
indexer numbers events within a block differently, and the backfill will refuse rather than
merge mismatched ids.

**Tip check.** `board-history check` rebuilds each tile's latest colour, holder and free bit
from the log and compares it with the stored blob (the same comparison `replay-check.py` makes
against the chain). It also follows the log's `board_expanded` entries: each must start from
the side the one before left, the last must end at the stored `board_side`, with a genesis
marker the chain must start at its `initial_side`, and no draw may lie outside the side in
force when it was applied. Exit 0 when all of that holds, 1 with the differences when not. It
prints whether the start is certified. Before the backfill it fails, because the log does not
yet hold the tiles painted before it started.

**Reading it: `GET /api/history/head` and `GET /api/history`** (`server/src/history_api.rs`,
TIMELAPSE, spec §4.3).

- `/api/history/head` → `{epoch, complete, start_block, initial_side, entries, first, last,
  side, page_limit}`, `no-cache`. `complete` is true only with the genesis marker; until then
  the log starts at `first` (`{block, at_ms}`), and the `/timelapse` page says so instead of
  presenting a partial log as the whole story. Six O(1) Valkey commands.
- `/api/history?epoch=<n>&after=<cursor>` → one page of up to 20,000 stream rows, oldest
  first, as a compact binary (`common/src/history_wire.rs`, magic `MPH1`): paints that share a
  block and a time share a header, and each tile is 3 bytes (x, y, colour index). Painters and
  the free bit are not sent. `after` is the cursor the previous page returned; `from_block=`
  starts at a block instead; `limit=` (1–20,000) asks for less.
- **A full page is immutable** (`Cache-Control: public, max-age=31536000, immutable`): the log
  only grows above its last id, so `(epoch, after)` names the same bytes forever. The last,
  partial page is `no-cache`. A request for another epoch answers **409**: the backfill
  rewrote the log, read the head again. 400 for a parameter that does not parse, 503 if
  Valkey does not answer in 5 s.
- Cost: one request per 20,000 tiles painted plus the head, about 3.3 bytes a tile. 2,000
  tiles is 2 requests and ~7 KB; 100,000 is 7 requests and ~330 KB; 1,000,000 is 52 requests
  and ~3.3 MB, all but the last cacheable for good. Per request Valkey does one
  `XRANGE … COUNT 20000` at most, and a full page is packed once per server process and then
  served from memory. There is no compression middleware here; a proxy in front may add gzip.

## Telegram alerts

AWAY-B (return-and-growth spec §1.3). A player links their NEAR account to a Telegram chat and
gets "9 of your tiles were covered by X. [Open the wall]", at most once an hour. It is a fourth
container, `telegram-bot`, in the compose **profile `telegram`**: a plain `docker compose up`
does not start it, and with `TELEGRAM_BOT_TOKEN` empty the server serves no `/api/telegram/*`
route, so nothing changes until the bot exists.

**How a link is made.** The bot has no public endpoint (it long-polls `getUpdates`), so the
page talks to the **server**, which is the one place the wallet's signature is verified:

1. Wallet panel → "Get alerts on Telegram". The page `POST`s `/api/telegram/challenge` and
   shows a one-time code (ten minutes, one use) and `https://t.me/<bot>?start=<code>`.
2. The player taps the link; the bot records their chat on the code.
3. The wallet signs the challenge text (NEP-413: no transaction, no fee) and the page `POST`s
   it to `/api/telegram/link`. The server checks the code, the ed25519 signature over the
   exact NEP-413 payload (stored text, stored nonce, this server's recipient), and asks the
   chain (`view_access_key`) that the key is a **full-access** key of that account. A
   function-call key, such as the painting key, is refused.

Steps 2 and 3 work in either order; the second one writes `account → chat id`.

**What is stored**, all under `telegram:*` in Valkey: `telegram:links` (account → chat id) and
`telegram:chat:<id>` (its reverse) are the only personal data. No route returns a chat id. No
route tells a caller whether an account is linked unless it holds that account's *status
token*, a random value the server issues after a verified signature and the page keeps in
localStorage (the server keeps its SHA-256). `/stop` in the chat, "Stop Telegram alerts" in
the wallet panel (signed, like linking), or the player blocking the bot (Telegram answers 403)
deletes the link, the cursor and the tokens.

**Alerts.** The bot reads `covers:<account>` (see "History and covers") from a cursor kept per
account in `telegram:alert_state`. The cursor is a position in the set, not a time, and is
written after Telegram accepts the message, so a restart resumes exactly where it stopped. A
new link starts at the moment of linking: it never reports the 30 days already in the set.
Covers wait two minutes to collect a whole stroke, then one message goes out, and no more for
that account for an hour. Messages carry tile counts and account names, never balances.
Covers reach Valkey only when the indexer polls, so with nobody watching the wall an alert
waits until someone opens it (see "What it costs").

**What it costs.** Telegram: one `getUpdates` every 25 s while idle (about 144 an hour, free)
and one `sendMessage` per alert. FastNEAR: one `view_access_key` per link or unlink attempt
that carries a valid signature, capped at 60 a minute; nothing otherwise. Valkey: one small
read per linked account every 15 s.

### Set it up

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather): `/newbot`,
   give it a name and a username ending in `bot`. BotFather answers with a token like
   `123456789:AA…`. Optional but worth doing: `/setdescription` ("Tells you when your Meta Poo
   tiles are covered") and `/setcommands` with `stop - Turn alerts off`. Do **not** set a
   webhook: long polling and a webhook cannot both be on.
2. **Configure the box.** In `ops/board-server/.env` (never in git):

   | variable | value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | the token from BotFather |
   | `WALL_URL` | the wall's public address, e.g. `https://<site>/wall`. The alert button opens it, and its host name is the NEP-413 `recipient` the wallet shows |
   | `NEAR_RPC_URL`, `NEAR_RPC_API_KEY` | optional; default is FastNEAR's public RPC for `CHAIN_ID` |
   | `COMPOSE_PROFILES=telegram` | optional; makes a plain `docker compose up -d` include the bot |

3. **Start it.** `docker compose --profile telegram up -d --build`. The **server** must be
   restarted too (the same command does it): it reads `TELEGRAM_BOT_TOKEN` at start to decide
   whether to serve the link routes.
4. **Tell the page.** Set `VITE_TELEGRAM_BOT=<username without @>` in Vercel beside
   `VITE_BOARD_SERVER_URL`, and redeploy. Until both are set the wallet panel shows nothing.

### Check it works

```bash
docker compose logs telegram-bot | grep "signed in"      # signed in to Telegram as @<your bot>
curl -s -X POST localhost:3000/api/telegram/challenge -H 'content-type: application/json' \
  -d '{"account":"alice.near","action":"link"}'            # {"code":"…","message":"…","recipient":"<site host>",…}
```

Then the real path, which no test in this repo can make (they use a fake Telegram and a fake
chain):

1. In Telegram, send the bot `/start`. It explains how to link.
2. On the site, connect a NEAR wallet (not Google/email), open the wallet panel, "Get alerts on
   Telegram", tap "Open @bot", press Start in Telegram, then "Approve in wallet". The panel
   says "Alerts are on" and the bot says "Linked."
3. From a second account, paint over one of the first account's tiles, with the wall open.
   Within about three minutes the bot sends "One of your tiles was covered by …" with an
   "Open the wall" button that opens the wall at that tile. Paint over another: nothing more
   arrives for an hour.
4. Send `/stop`: the bot confirms, `docker compose exec valkey valkey-cli hgetall telegram:links`
   is empty, and the wallet panel offers "Get alerts on Telegram" again after a reload.

If the log says `409 from getUpdates`, a webhook is set or a second copy is running with the
same token (`curl https://api.telegram.org/bot<token>/deleteWebhook` clears a webhook). If it
says Telegram refuses the token, the token in `.env` is wrong. The token is in the URL of every
Bot API call; the bot strips URLs from the errors it logs.

**Not available to Google/email (Privy) sign-ins:** that wallet declares it cannot sign
messages, so the panel says so and offers no control.

## Run

```bash
cp .env.example .env    # board id, deploy block, side
docker compose up -d --build
```

The first run needs `START_BLOCK_HEIGHT`. For the mainnet testing board that is
`223113576`, the block that included the deploy tx. With it, the server rebuilds the wall from
history, with no snapshot. The first poll happens when the first viewer connects.

**Switching an existing deploy from `stream` to `txindex`** needs nothing: the indexer resumes
from `last_processed_block`.

**`stream` mode only: NEAR Data rate-limits anonymous archive fetches.** Measured 7 Nov:

- 4 threads: about 40 blocks/s.
- 32 threads: about 280 blocks/s, then HTTP 429s.
- 8 threads after the 429s: about 25–35 blocks/s.

Replaying the testing board's ~320k blocks without a token therefore takes hours. With a token
it is billed per block. `txindex` mode needs neither.

## Check

```bash
cargo test -- --test-threads=1          # Valkey tests are skipped unless TEST_VALKEY_URL is set;
                                        # the outage test needs valkey-server/redis-server or Docker
cargo clippy --all-targets -- -D warnings
```

The log and covers are tested in `server/tests/history.rs` (consumer and endpoint),
`server/tests/timelapse.rs` (`board_expanded` in the log, the head and the pages) and
`indexer/tests/backfill.rs` (backfill with a scripted index, the real consumer and Valkey).

Spec §7.1, a replay that matches the chain tile for tile:

1. Stop the indexer.
2. Wait for `queue_length` to reach 0.
3. Run the script against `last_processed_block`:

```bash
scripts/replay-check.py http://127.0.0.1:3000 <board> <last_processed_block>
```

It exits **2** without comparing when the mirror's `x-last-block` is not the block you named: a
mirror ahead of it holds paint the chain did not have yet, which would read as false differences.

The script compares colour, artist and `written_at_ns` for every tile against `get_pixels`
pinned to that block. It also compares each holder's tiles against `get_cells_owned`, and
earning tiles against `get_earning_cells` when the board has that view.
