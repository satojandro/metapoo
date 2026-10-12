# Regional pressure simulation (Wave 0 / T0.B)

Deterministic **TOILET** placement-cost math for Meta Poo’s regional heat model. This package is a pure simulator and golden-vector lock — it does **not** implement the paid on-chain board.

Spec: [`docs/implementation/pressure-and-paint.md`](../../docs/implementation/pressure-and-paint.md). Geometry fixture: 128×128 board, 8×8 regions → 256 regions (Open wall preserved).

## Layout

| Path | Role |
|---|---|
| `src/math.ts` | Cool → quote → heat update |
| `src/geometry.ts` | `region_id = floor(y/size)*cols + floor(x/size)` |
| `src/simulate.ts` | Seeded scenario runner (noop reject, Open wall) |
| `src/report.ts` / `src/cli-report.ts` | JSON + markdown summary |
| `fixtures/config.json` | Fixture economics (not production) |
| `fixtures/golden/*.json` | Shared golden vectors |
| `rust/` | Matching pure-Rust math stub + golden tests |

Money at JSON boundaries is integer **TOILET** units as decimal strings.

## How to run

From this directory (Node 22+ recommended; tested on Node 26):

```bash
# Lock golden vectors (TypeScript)
npm test

# Regenerate golden JSON after intentional scenario edits
npm run generate-fixtures

# Human report for one scenario (writes fixtures/reports/)
npm run report -- quiet-artist
npm run report -- wealthy-warmer
```

Rust stub (optional; does not touch `contracts/board`):

```bash
cd rust && cargo test
```

These scripts are **not** wired into the root/web/`shared` test entrypoints yet — there was no natural monorepo script for `simulations/`. Run them from `simulations/pressure/` as above.

## Golden vector summary

| Fixture | What it locks |
|---|---|
| `documented-examples` | Spec numbers: cold cost 10; same-second second paint 11; after 10s heat 20→10 cost 11; heat-cap cost 50; long cool; overflow-safe decay |
| `quiet-artist` | Sparse painter; each placement costs base `10`; spend `50` / 5 success |
| `two-crews` | Alternating crews in one region; rising heat/spend + concentration by operator |
| `wealthy-warmer` | Whale heats region; restoration cost ≫ base (obstruction report) |
| `region-boundary` | Boundary coordinates → region IDs; adjacent regions do not share heat |
| `same-second-ordering` | Same `t` ordering changes each payer’s cooled heat |
| `long-inactivity` | After long idle, cost returns to base |
| `heat-cap` | Heat clamps at 400; cost clamps at 50 |
| `noop-same-artist-same-color` | Reject before charge; heat/`updated_at` unchanged |
| `fixed-price-control` | Note comparing contested spend vs base×placements |

## Outcome report (T0.B)

| Label | Status |
|---|---|
| **implemented** | Pure TS (+ Rust stub) pressure math, simulator, report CLI under `simulations/pressure/` |
| **fixture-tested** | 18 Node tests + Rust golden tests against shared JSON |
| **live-verified** | N/A (no paid board deploy / chain exercise in this task) |
