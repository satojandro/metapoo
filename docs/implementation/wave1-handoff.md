# Wave 1 handoff log

Date: 12 October 2026. Staffing: coordinator (A) + workers B / E / F (first Wave 1 group).

Outcome columns: **implemented** | **fixture-tested** | **live-verified**.

Wave 0 is complete on `main`. This wave implements domain packages; it does **not** claim the full R1 vertical slice (Wave 2) or testnet rehearsal (Wave 3).

## First group — complete (local / fixture)

| Task | Owner | implemented | fixture-tested | live-verified |
|---|---|---|---|---|
| Shared history encoder stub | Coordinator A | yes — `shared/history/**` | yes | N/A |
| T1.B1 (+ B2/B3 start) paid board | [Paid board contract B](ced95930-814a-4496-9fca-4b17940b144e) | yes — schema 3 | **39** cargo tests | N/A |
| T1.E bounty escrow | [Bounty escrow contract E](e2c8bd18-c6f9-4020-9090-02de00ac4905) | yes — `contracts/bounties/**` | **21** cargo tests | N/A |
| T1.F paid wall adapters / pressure UI | [Paid wall adapters F](8dfcc777-89f1-40d6-bcf7-65cf0c032762) | yes — flag/mocks | **139** web tests | N/A |

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
