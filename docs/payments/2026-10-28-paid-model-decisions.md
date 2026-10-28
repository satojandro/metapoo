# Paid model v1 — ratifications and contradictions resolved

**Date:** 2026-10-28 · Status: **ratified by the owner** (Alejandro) this session.
This document is the single source of truth for the payment stage. Where an older
document disagrees, this one wins and the older one carries a pointer here.

---

## 1. Ratified decisions

**D1 — One paid model: prepaid credits, schema 4.**
The schema-3 pressure/TOILET model and its mock-quote UI are **deleted**, not deferred
silently. `web/src/paid-mode.ts`, `web/src/features/pressure/*` mock paths and
`web/src/payment-provider.ts` are removed; `contract-meta.ts` accepts **schema 2
(legacy free board) and schema 4 (paid board)** only. Credits: one credit = one pixel
placement, no expiry, non-transferable, bought with native NEAR or direct mPOO.

**D2 — One paid board, on mainnet.**
There is no second product board. `contracts/board` (schema 2) is retired as a product;
its testnet deployment stays as a demo fixture. `contracts/paid-board` (schema 4) is the
wall. Testnet deployments of the paid board exist only as rehearsal for the mainnet
launch. Consequence accepted: **the 2,301-pixel testnet mural cannot move to mainnet**
(testnet art is not mainnet art). The mainnet wall starts empty and is seeded
deliberately — mechanism still open, see §4.

**D3 — Pricing unit: per pixel stays.**
Owner asked what "per stroke" means and whether a drag should cost the same as a tap.
Answer and arithmetic in §3. Per-pixel accounting stays because storage is charged per
pixel; a flat per-stroke price cannot cover a full-length drag. The **price** and the
**free-paint window** are the two levers that fix the "a drag costs $2" feeling.

---

## 2. Verified facts behind these decisions (primary sources, 2026-10-28)

| Fact | Evidence |
|---|---|
| mPOO implements `ft_transfer_call` | RPC view-probe returns `Requires attached deposit of exactly 1 yoctoNEAR`, **not** `MethodNotFound` (`definitely_not_a_method` returns `MethodNotFound` as control) |
| mPOO `storage_balance_bounds` = exact 0.00125 NEAR | `storage_balance_bounds` → `{'min': '1250000000000000000000', 'max': same}`; the board must be registered with exactly that |
| mPOO is 18 decimals, symbol MPOO | `ft_metadata` |
| Storage is charged per pixel, permanently | live free board: 152,724 B state / 2,301 painted px = **66.4 B/px** → **0.000664 NEAR ≈ $0.0031 per pixel** locked (NEAR $4.63) |
| Mainnet deploy storage | paid-board wasm 304,347 B = **3.04 NEAR**; plus 0.00125 NEAR mPOO registration; full-board state ≈ 10.9 NEAR locked |
| Paid contract has no money exit / no upgrade / no pause | `pub fn` inventory: `new, get_board, get_pixel, get_pixels, draw, draw_many, set_credit_prices, get_payment_config, get_credits, register_credit_account, buy_credits_near, ft_on_transfer` |

---

## 3. The pricing question, answered

"Per stroke" means **one drag gesture** — one pointer-down to pointer-up. The stroke
engine caps a transaction at `MAX_DRAW_BATCH = 64` cells and splits longer drags into
several strokes. So today a 64-cell drag is 64 credits.

Flat-per-stroke pricing is **arithmetically impossible** here: 64 cells of permanent
storage costs `64 × 0.000664 = 0.0425 NEAR ≈ $0.197`. Any flat stroke price above that
makes a one-pixel tap cost the same as sixty-four pixels. So the unit must be the pixel.

What changes the feel is the price:

| price/pixel (NEAR) | 1 tap | 64-cell drag | 256-px mural | whole board | storage share |
|---|---|---|---|---|---|
| **0.0069** (current) | $0.032 | **$2.04** | $8.18 | $523 | 10 % |
| 0.005 | $0.023 | $1.48 | $5.93 | $379 | 13 % |
| **0.0025** (recommended) | $0.012 | **$0.74** | $2.96 | $190 | 27 % |
| 0.0019 | $0.009 | $0.56 | $2.25 | $144 | 35 % |
| 0.0013 | $0.006 | $0.39 | $1.54 | $99 | 51 % |
| 0.00069 | $0.003 | $0.20 | $0.82 | $52 | **96 %** |

The floor is real: below ~0.0013 NEAR/pixel the contract loses money on every pixel.
**Recommendation: 0.0025 NEAR/pixel at launch**, revisit after 100 purchases.

### Free-paint window (owner's optional idea) — the safe shape

A free hour where **anyone can paint anything** would let bots overwrite paid art for
free, which devalues every paid pixel. Two constraints make it work:

1. **Free window paints only empty cells** (no overwrites). Free play adds art and never
   destroys paid art — and it doubles as the mural seeding mechanism for a new wall.
2. **Per-account cap per window** (e.g. 32 cells), so one account cannot fill the board.

Contract shape: one owner-settable field, e.g. `free_window: Option<{start_ns, end_ns}>`
(one-shot) or a daily recurring window derived from `block_timestamp`; `spend()` is
skipped only when the window is open **and** the target cell is empty **and** the
account is under the cap. That is a schema-4.1 change, not a v1 launch requirement.

---

## 4. Open consequences this decision creates

1. **Seeding an empty mainnet wall.** Options: (a) free window limited to empty cells,
   (b) a one-time owner seed function, (c) owner buys credits (a 256-px mural = 0.64 NEAR
   at 0.0025). Recommend (a) as the launch event.
2. **Free board retirement date.** It stays deployed on testnet as a fixture; the repo
   keeps the crate (it is the reference free implementation) but the product stops
   pointing at it.
3. **Session key spends credits.** `DRAWING_SESSION_METHODS = ["draw","draw_many"]` and
   both debit credits on the paid board. A browser-held key therefore holds spending
   authority. Needs a cap before real credits exist (client-side cap now, contract field
   later).
4. **Money cannot leave the contract.** No withdraw/treasury method exists. This is a
   mainnet blocker, not a follow-up.
5. **No upgrade/migration/pause.** A bug in the paid contract strands all credits and
   pixels. Rehearse an upgrade on testnet state before mainnet money.

---

## 5. Contradictions found across the docs, and their resolution

Each row was a real assertion in the repo that the ratifications above make false.

| # | Document | What it asserts | Resolution |
|---|---|---|---|
| 1 | `docs/2026-10-12-paint-economy-and-swap-plan.md:14` and the "Confirmed by the user" bullet list | "Paid paint purchases accept **MPOO only**. NEAR is not an alternative paint-payment asset." | Inline-superseded: NEAR **and** direct mPOO are both accepted. The override block at the top already says so; the bullets now carry a marker. |
| 2 | same file `:16, :41–43, :95–99, :105, :123, :127–129, :145` | TOILET is the paint unit — earned by longevity, spent/burned to paint | Superseded for this stage by non-expiring credits. TOILET returns only as an M4 design, and only if purchase data justifies it. |
| 3 | same file `:21` | "the earlier NEAR-versus-MPOO 20 % paint discount is obsolete" | Re-opened: NEAR is a payment path again. It is a currency choice, not a discount; no 20 % comparison is revived. |
| 4 | `docs/00-shared-decisions.md:77–79` | MPOO-only purchases, TOILET earn/burn, MPOO staking revenue | Payment lines marked superseded; staking/revenue remain later-phase and are untouched by this stage. |
| 5 | `docs/00-shared-decisions.md:9` | Pillar 1 is "demand-sensitive placement pricing" | Pillar survives as later work; the current stage is **fixed-price credits**. Demand-sensitive pricing is no longer the first payment slice. |
| 6 | `docs/2026-10-12-product-prd.md:11` | "Economy plan remains authoritative for MPOO purchases, TOILET issuance/rewards…" | Pointer added: purchases now live in this decision doc. |
| 7 | `docs/2026-10-12-product-prd.md:31` | "Payment provider is an unused placeholder" | True today but being deleted (D1); row updated. |
| 8 | `docs/2026-10-12-product-prd.md:56` | "Preserve the existing free board until the paid schema is ready" | Resolved: free board retired as a product (D2); testnet kept as fixture. |
| 9 | `docs/2026-10-12-product-prd.md:60, :62` | "variable TOILET placement costs", "TOILET is an internal paint ledger in R1" | Superseded (D1) for the payment stage; kept as M4 reference. |
| 10 | `docs/2026-10-12-palette-proposal.md:5` | "Proposed schema 3 swatches" | Schema 3 no longer exists. Palette indices/hexes are unchanged; a future palette change is a schema **5** bump. |
| 11 | `docs/implementation/pressure-and-paint.md` (whole) | Pressure-pricing + TOILET protocol, region heat, surcharge curve | Marked superseded for this stage; retained as the M4 pressure design. |
| 12 | `docs/2026-10-14-product-judgment.md:18` | "blockchain-native features (pressure pricing, …)" | Still a pillar, not this slice. No edit needed beyond the pointer. |
| 13 | `contracts/paid-board/README.md` | "Experimental schema 4, **separate** from `contracts/board` … The web app **still targets the free board**" | Reframed: schema 4 **is** the product board; the free board is the retired fixture. |
| 14 | `docs/backlog.md` (payment stage) | "`contracts/board` remains the free schema-2 contract; `payment-provider.ts` remains an unused placeholder" | Updated to the ratified model and the deletion scope. |
| 15 | `web/src/paid-mode.ts`, `web/src/contract-meta.ts` comments | "paid schema 3", mock pressure quotes as paid UI | Code-level contradiction — dies with the code in D1's PR. |

Two contradictions were **inside Codex's own additions** and are worth naming because they
are the failure mode to avoid: the branch README said the web app "still targets the free
board" while `docs/payments/frontend-handoff.md` said it "applies to the separate schema-4
paid board"; and `docs/00-shared-decisions.md` labelled the payment stage "accepted"
before the owner had ratified anything. Both are now consistent.

---

## 6. What this changes in the roadmap

- M0 shrinks: the schema decision is made, so the schema-alignment PR is now a deletion
  task (schema 3 out, schema 4 in) rather than a design debate.
- M1 gains one item: decide the seeding mechanism (§4.1) because the mainnet wall starts
  empty by decision.
- M1 loses one item: no testnet "free vs paid" comparison build is needed.
- M2 is unchanged and is now the critical path: money-out, upgrade rehearsal, pause,
  split keys, cost matrix.
- M3 is unchanged: bounded mainnet launch.
- M4 explicitly includes the retired pressure design and any TOILET mechanics, as
  options — not commitments.

---

## 7. Capping the credit float (owner proposal, 2026-10-28)

Owner's idea: put a ceiling on how many credits can exist at once, so scarcity makes people buy ahead
of need. Worth doing, with one correction to the reasoning and two guardrails.

### The correction: outstanding credits are not a cash liability

Credits are **prepaid, non-refundable service**. The contract does not owe a refund; it owes a pixel,
whose real cost is storage (0.000664 NEAR) plus gas. So 1 M outstanding credits are ~660 NEAR of future
cost against 2,500 NEAR already collected. **A cap is a game mechanic, not a solvency tool** — which is
good news, because hoarding is cash-positive for the treasury rather than a risk to it.

### What a cap can and cannot do

| | |
|---|---|
| ✅ creates urgency, seasonal sell-outs, a visible "sold out" state | ❌ cannot create resale value: credits are non-transferable, so scarcity buys *access*, not profit |
| ✅ caps how much of the board one wallet can pre-buy | ❌ does not stop a whale cornering the float to deny others |
| ✅ adds a headline number to the transparency page | ❌ becomes a growth ceiling the moment it binds in a real rush |

### Design

- **Cap the outstanding float**, not lifetime issuance: purchases are blocked while
  `outstanding_credits ≥ cap`, and painting drains the float, so buying resumes naturally. It binds only
  during a rush — exactly the intended dynamic.
- **Size it at ~90 days of consumption.** At 100 users × 128 paints/day = 12,800/day that is
  **≈1.15 M credits** (≈2,875 NEAR, ≈$13.3 k of prepaid paint). Revisit monthly; publish the number.
- **Per-account holding cap** (e.g. 20,000 credits ≈ 50 NEAR ≈ $232) so one wallet cannot empty the
  float and strand everyone else.
- **Seasonal variant** if you want launch moments: reset the cap each season and announce it.
- Contract state: `outstanding_credits` (increment on purchase, decrement on spend) beside the existing
  `balances` map — two lines in `payments.rs` plus one test per boundary.

Pairs with the repaint multiplier in the economy doc §13: the cap makes *credits* scarce; recency
pricing makes *cells* scarce. Different shortages — do not blur them in UI copy.
