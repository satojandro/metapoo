# Meta Poo history service (`services/history`)

Fixture-first finalized ingest, pixel materialization, checkpoint / reconstruction, and HTTP-shaped query handlers for canonical board history.

## Status (three-way)

| Claim | Status |
|---|---|
| **implemented** | Yes — in-memory store, ingest rules, checkpoints, reconstruction, snapshot encoding via `shared/history`, handlers matching `shared/protocol/history.ts` |
| **fixture-tested** | Yes — `npm test` (replay, crash/resume, gap, empty-vs-Ink, same-block order, overwrite) |
| **live-verified** | **N/A** — live NEAR Lake / archival provider is **not wired**. Ingest is from saved execution fixtures only. |

## What this package does

1. Accepts archived execution records (success-only) containing `mpoo_board/2.0.0/draw` events.
2. Enforces unique ingest identity `(chain, block_hash, receipt_id, log_index, data_index)` and contiguous `revision` strings.
3. Duplicate identical events are no-ops; conflicting duplicates **halt** certification.
4. Materializes pixels, writes checkpoints every `N` revisions (config), and reconstructs any covered revision from checkpoint + ordered events.
5. Exposes pure query functions shaped like the HTTP API in `shared/protocol/history.ts`.
6. Encodes canonical state / snapshot bytes with `shared/history` (raw-byte genesis/block hashes).

## What it does **not** do

- Connect to NEAR Lake, RPC, or any archival provider.
- Hold spending / attester credentials.
- Claim live-verified ingest or mainnet coverage.
- Run PostgreSQL yet (store is in-memory for fixtures; SQL migrations are deferred).

## Layout

```
services/history/
  src/           # ingest, store, reconstruct, handlers, snapshot
  fixtures/      # execution streams + Worker D manifest handoff
  test/          # node:test suite
  scripts/       # regenerate manifest fixture hashes
```

## Run tests

```bash
cd services/history
npm test
```

Regenerate Worker D handoff (canonical hashes):

```bash
npm run generate-fixtures
```

## Fixtures for Worker D (prints / registry)

| Path | Purpose |
|---|---|
| `fixtures/manifest-for-worker-d.json` | Snapshot manifest + `stateHash` / `snapshotId` + hex of canonical bytes |
| `fixtures/baseline-empty-board.json` | Baseline empty board (absence ≠ Ink) |
| `fixtures/execution-stream.json` | Contiguous draw events including same-block multi-draw |
| `fixtures/overwrite-scenario.json` | Paint then overwrite; earlier revision reconstructable |

## Coverage status values

`healthy` | `lagging` | `gap` | `halted` — see `src/coverage.ts`. Existing covered history stays queryable when status is `gap` or `halted`, but **snapshot / manifest certification is refused while `halted`** (handler returns `status: "halted"`; `buildManifestForWorkerD` throws).
