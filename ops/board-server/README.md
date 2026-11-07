# Board server

A port of FastNEAR's [Berry Fast](https://github.com/fastnear/berry-fast) backend (read at
`31f1695`) for the Meta Poo wall. Spec and the reasons for every difference:
[`docs/implementation/2026-11-07-board-server-berry-fast-port.md`](../../docs/implementation/2026-11-07-board-server-berry-fast-port.md).

Berry Fast has no LICENSE file, so nothing here is copied verbatim. The structure, the Valkey
key names, the region blob, the HTTP paths and the WebSocket messages follow it; the code is new.

```
NEAR Data (final blocks) ──► indexer ──LPUSH──► Valkey draw_queue ──LMOVE──► server ──► HTTP + /ws
```

- **`common/`**: the 6-byte-per-pixel region blob, the `mpoo_board` event parser, and
  `BoardState::apply_draw`. It is pure code, and it is where the tests for the board rules live.
- **`indexer/`**: streams every final block. It takes `EVENT_JSON` logs only from **successful**
  outcomes **executed by the board**, and queues them in chain order. A block's events and
  `last_processed_block` are written in one transaction.
- **`server/`**: applies queued events and serves the mirror.
  - Each event is one `MULTI`/`EXEC`: board, counts, catch-up history, `last_applied_position`
    and the `LREM` all commit together.
  - An event at or below `last_applied_position` is dropped, so a re-delivered block cannot
    double-count.
  - On start, an event stranded in `processing_queue` goes back to the head of the queue.
  - A failed apply is **retried** with backoff, on a reconnecting connection, rather than
    ending the consumer: skipping would leave a permanent gap, and exiting would freeze the
    mirror. `/api/health` reports the consumer's liveness, so a stuck one is visible.

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
| `GET /api/health` | `status` (`ok` / `degraded` while retrying / `stalled` when the consumer has not ticked for a minute), `last_processed_block`, `last_applied_block`, `queue_length`, `side`, `painted_tiles`, `consumer_last_tick_ms`, `consumer_failures` |
| `GET /ws` | pushes `{"type":"draw",…}` and `{"type":"board_expanded",…}`. Send `{"type":"catch_up","since_timestamp_ms":n}` after a reconnect |

## Run

```bash
cp .env.example .env    # board id, deploy block, side
docker compose up -d --build
```

The first run needs `START_BLOCK_HEIGHT`. For the mainnet testing board that is
`223113576`, the block that included the deploy tx. With it, the server rebuilds the wall from
history, with no snapshot.

**NEAR Data rate-limits anonymous archive fetches.** Measured 7 Nov:

- 4 threads: about 40 blocks/s.
- 32 threads: about 280 blocks/s, then HTTP 429s.
- 8 threads after the 429s: about 25–35 blocks/s.

Replaying the testing board's ~320k blocks without a token therefore takes hours. Spec B3:
ask FastNEAR about `AUTH_BEARER_TOKEN` and billing.

## Check

```bash
cargo test -- --test-threads=1          # Valkey tests are skipped unless TEST_VALKEY_URL is set
cargo clippy --all-targets -- -D warnings
```

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
