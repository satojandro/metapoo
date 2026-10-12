# Wave 0 handoff log

Date: 12 October 2026. Staffing: coordinator (A) + workers B / F / G.

Outcome columns: **implemented** | **fixture-tested** | **live-verified**.

## Wave 0 exit summary

| Task | implemented | fixture-tested | live-verified |
|---|---|---|---|
| T0.A protocol freeze | yes | yes (21 shared tests) | N/A |
| T0.B pressure sim | yes | yes (18 Node + 4 Rust) | N/A |
| T0.F route shell | yes | yes (109 web tests + build) | N/A |
| T0.G bounty fixtures | yes | yes (19 bounty unit tests) | N/A |

**Exit criteria met for local Wave 0:** interface freeze exists; route disposal tested; pressure scenarios reported; free board still the development baseline; no live money path claimed.

**Not done (later waves):** paid on-chain board, escrow, history service, prints, live adapters, testnet rehearsal.

---

## T0.A — Protocol freeze (coordinator)

| Column | Status |
|---|---|
| implemented | Yes — `shared/protocol/{errors,board,bounties,history,prints,operations,index}.ts`, `shared/fixtures/**` |
| fixture-tested | Yes — `node --experimental-strip-types --test shared/protocol/protocol.test.ts` (with board-rules) |
| live-verified | N/A |

Freeze id: `mpoo-protocol-r0-2026-10-12`. Compatibility: `shared/types.ts` remains free-schema layer.

## T0.B — Pressure simulation ([Pressure sim golden vectors](235fa46e-66f5-4629-bb17-ac084b9d32a1))

| Column | Status |
|---|---|
| implemented | Yes — `simulations/pressure/` TS math/sim/report + Rust stub |
| fixture-tested | Yes — re-verified: 18 Node + 4 Rust tests pass |
| live-verified | N/A |

Documented vectors: cold 10 → same-second 11 → cool-to-10 cost 11 → cap 50. Run: `cd simulations/pressure && npm test` / `cd rust && cargo test`.

## T0.F — Route shell ([Route shell mountWall](eecdf1be-2bd5-4fad-87ec-23fd80b1355b))

| Column | Status |
|---|---|
| implemented | Yes — History API routes, `mountWall→dispose`, shared ops/wallet chrome, page registry |
| fixture-tested | Yes — re-verified: 109 web tests + `npm run build` |
| live-verified | N/A |

F owns shell/wall/wallet. Leaving a page disposes polls/listeners; `services.operations` survives navigation. `/` is stall overview → `/wall`.

## T0.G — Fixture bounty pages ([Fixture bounty pages](4e6cd1b8-f9fc-419d-bb10-5670c41bc021))

| Column | Status |
|---|---|
| implemented | Yes — `web/src/pages/bounties/**` browse/create/detail + demo banner |
| fixture-tested | Yes — re-verified Vitest under `src/pages/bounties` |
| live-verified | N/A |

Registers via `registerBountyPageStubs()` into F’s `registerPageMount`. Does not own `main.ts`/wallet/global CSS.

## Ownership reminder

No silent F↔G handoff. Large-board workstream (T.L*) and Wave 1 domain tasks remain separate owned packages — not collapsed into “wire the slice.”
