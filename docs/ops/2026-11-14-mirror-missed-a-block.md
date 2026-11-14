# The mirror missed a block, and how it was repaired (14 Nov 2026)

## What was wrong

The launch board mirror (`board.meta-poo-stall.near`, Mac mini stack) showed **50 tiles as never
painted** that the chain has painted — all by `washedrickrosss.near`, at blocks 224363630,
224363639, 224363679, 224363706 and 224363895.

`draw_history` had **no entries at all** for block 224363630: the consumer skipped that event. The
blob and the log agreed with each other (both missing the same 50 tiles), which is why the ordinary
tip check passed and nothing looked wrong — the mirror was consistently wrong, not inconsistently
wrong.

## How it was found

`board-history backfill` refused to write:

```
Error: the replay disagrees with the live log at its entry 174
(replay Some(HistoryEntry { position: 224363630000336, block: 224363630, x: 26, y: 48, … }),
 live  Some(HistoryEntry { position: 224363639000128, block: 224363639, x: 30, y: 47, … }));
nothing written
```

The replay (chain → events → apply) produced a draw the live log did not have. The refusal is the
feature: a backfill that overwrites a log it disagrees with would destroy the evidence.

Cross-checking the chain with `get_pixels` (paged, 256 a page, 1,381 tiles) confirmed the replay:

| check | count |
|---|---|
| chain painted tiles | 1,381 |
| mirror painted tiles | 1,331 |
| chain painted, mirror blank | **50** |
| painted both, wrong colour | 0 |
| mirror painted, chain blank | 0 |

## The repair

Order matters: the log first, then the blob, then the in-memory server.

1. **Back up the log.** `COPY draw_history draw_history:pre117-repair` (1,448 entries).
2. **Rebuild the log from chain.** Delete `draw_history`, then `board-history backfill`. With no live
   log to disagree with, the replay writes every entry from the deploy block and certifies the
   genesis marker (`start_block 224338000`, `initial_side 64`). Result: 1,513 entries.
3. **Repair the blob from the log.** `scripts/repair-blob-from-log.lua` replays the log and writes a
   pixel **only where the stored owner id is 0**, so it can never overwrite paint. It also bumps
   `account_pixel_count`. Ran once: **50 tiles fixed**.
4. **Bump `painted_tiles`** by the same 50 — it is a separate counter key, not derived from the blob.
5. **Restart the server container.** It serves `BoardState` from memory, so a Valkey write is invisible
   until it reloads.

## Proof

```
$ board-history check
log: 1513 entries and 0 board expansions, blocks Some(224353674)..Some(224439764)
start: certified from the deploy block 224338000 (side 64) by the backfill
tip check: the log's tile state equals the stored board        # exit 0
```

Against the chain, re-read afterwards: chain 1,381 / mirror 1,381 / missing 0 / wrong colour 0 /
extra 0. `GET /api/history/head` now answers `"complete": true`, and `/timelapse` says *"The whole
story: every paint since the board went live at block 224,338,000."*

## Still open: why the consumer skipped the block

The repair fixes the state; it does not explain the skip. The consumer's log was lost when the
container was recreated, so the cause is not recoverable from this box. Two candidate causes worth
checking next time it happens (keep logs):

- the indexer's tx-index page missed a transaction, so the event never reached `draw_queue`;
- the consumer dropped the entry as unparseable (it logs `dropping an unparseable queue entry`).

`board-history check` compares the log with the blob, so it **cannot** see this class of fault — both
sides drift together. The only detector is a replay that disagrees, i.e. the backfill's own guard.
Run `board-history check` after any incident, and treat a backfill refusal as a report, not a bug.
