# Wave 1 handoff log

Date: 12 October 2026. Staffing: coordinator (A) + workers B / E / F (first Wave 1 group).

Outcome columns: **implemented** | **fixture-tested** | **live-verified**.

Wave 0 is complete on `main`. This wave implements domain packages; it does **not** claim the full R1 vertical slice (Wave 2) or testnet rehearsal (Wave 3).

**Do not mark B/E/F functionally complete** until post-review P1s land: escrow FT payout + storage charging, schema-3 paid wall wiring, and raw-byte hash encoding goldens (P2 — in progress below).

## First group — scaffolding (local / fixture); functional gaps open

| Task | Owner | implemented | fixture-tested | live-verified |
|---|---|---|---|---|
| Shared history encoder | Coordinator A | yes — raw-byte hashes + goldens | in progress | N/A |
| T1.B1 (+ B2/B3 start) paid board | [Paid board contract B](ced95930-814a-4496-9fca-4b17940b144e) | yes — schema 3 | **39** cargo tests | N/A |
| T1.E bounty escrow | [Bounty escrow contract E](e2c8bd18-c6f9-4020-9090-02de00ac4905) + [Escrow FT claim storage](64244f13-f14d-4f07-9ac1-1596c80cec75) | claim FT + storage meter | **23** cargo tests | N/A — claim-row create still unmetered |
| T1.F paid wall adapters / pressure UI | [Paid wall adapters F](8dfcc777-89f1-40d6-bcf7-65cf0c032762) + [Paid wall schema-3 wire](3e5eed7e-2578-42b3-be45-5879f6caf41d) | schema-3 FunctionCall path | web + F↔B shape test | N/A — needs live nonce + session register |

### Post-review fix track (after `ee0b336`) — local/fixture done
- P1 claim `ft_transfer` + `promise_result` settlement — **done** (fixture-tested)
- P1 storage deposit on create/propose/register_snapshot — **done** (fixture-tested; accept/expire claim rows still unmetered)
- P1 wall ↔ paid contract FunctionCall — **done** (fixture-tested; live nonce/session still open)
- P2 genesis/block hashes as 32 raw bytes (shared TS/Rust goldens) — **done**
- Keep G funding UI cautious until live FT sandbox; payout path now schedules real transfers in unit tests
- Next for C/D: safe to build on hash encoding; still no live-verified escrow or paid paint

### Board (B) notes
- Fresh paid `new(...)`; **do not** call `new` over schema-2 state. Free `draw` only in `legacy_free` tests.
- Open wall preserved; same-artist/same-color no-op; v2 events; sessions + TOILET stub packs.
- Remaining: live FT sandbox, pause/config migration, production packs.

### Escrow (E) notes
- DRAFT→ACTIVE→REVIEW→AWARDED|EXPIRED; consent digests; split dust rule; stub claims.
- Remaining: print mint callback, real NEP-141 sandbox.

### Frontend (F) notes
- Paid mode off by default (`VITE_PAID_PAINT` or paid schema). Mock quotes labelled demo.
- Can wire live `get_quote` / paid draw once board methods are adapted in the client.

## Deferred to next Wave 1 slots (C/D/G then H)

- T1.C history service
- T1.D1 / T1.D2 registry + prints
- T1.G live bounty adapters (after E)
- T1.H history/prints/account pages
- T.L* large-board capacity (parallel)

## Rules

Preserve Open wall. Report implemented / fixture-tested / live-verified separately. No mainnet deploy.
