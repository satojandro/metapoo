# Work queue — 2026-10-28 (post-merge)

**Baseline:** `main` = `0a3e284`, tree `eac81d53` — the same tree that passed 54 contract tests,
284 web tests, both builds. The paid board, recency pricing, tunables, counters and upgrade path are
now on main. Nothing is deployed.

**MVP definition still in force:** a stranger connects a wallet, understands the price, buys credits,
paints, and the paint is visible to someone else — on **testnet** first, then mainnet with money.

---

## Assignment

| # | Task | File | Owner | Why this owner | Blocked by |
|---|---|---|---|---|---|
| 1 | Schema-4 cleanup: accept schema 4, delete schema-3 mock path + `payment-provider.ts` | this doc, §Hermes | **Hermes** | Small, deletion-shaped, needs a reviewer who remembers why schema 3 is dead | nothing |
| 2 | `pay-recency-ui` — per-cell price, stroke total, legend, paint wired to schema 4 | `pay-recency-ui.task.json` | **Cursor** | Multi-file frontend state work; Cursor's lane | #1 |
| 3 | `pay-checkout` — quantity, NEAR/mPOO purchase, receipt-driven confirmation | `pay-checkout.task.json` | **Cursor** | Same lane; the largest single UI surface | #1 |
| 4 | `paid-board-safety` — pause, treasury withdrawal with reserve floor, bounded price change | `paid-board-safety.task.json` | **Codex** | Contract-internal invariants and arithmetic; good fit for a long, test-first run | nothing |
| 5 | `toilet-token` — capped NEP-141, emitter-gated mint, venue tax | `toilet-token.task.json` | **Codex** | New crate, no dependencies, large but self-contained | nothing |
| 6 | `payments.rs` security review | this doc, §Hermes | **Hermes** | Independent of whoever wrote it | nothing |
| 7 | Testnet paid deployment rehearsal | this doc, §Hermes | **Hermes** | Scripts, keys, RPC, receipts — ops lane | #2, #3 |

Two Codex tasks are deliberately independent of each other and of the frontend, so they can run in
parallel with Cursor rather than queueing behind it.

## Review status — 2026-10-28

Codex delivered both contract tasks on `codex/paid-board-safety-toilet-token` → **PR #15**. Verified
locally: 63 paid-board tests (was 54), 18 TOILET tests, both release wasms build, `web/` untouched.

**Merge gate — one should-fix, one decided change, one process decision:**

1. `ft_resolve_transfer` returns `used + tax`, mixing protocol-retained tax into a field that means
   "consumed by the receiver": it exceeds the net `amount` argument when everything is consumed, and it
   returns the tax when nothing is. Return `used`; report gross in the event. *An earlier version of this
   note claimed a full rejection returned the full gross — that was wrong; `tests.rs:183` shows the tax.*
2. **Decided 2026-10-28 (owner): TOILET is immutable at launch, with no owner.** Rates, split, treasury and
   the exempt list are set in `new()` with no setter; `set_emitter` and `set_paused` become emitter-only;
   no upgrade entrypoint. Consequence: the AMM/sandbox tax test must happen **before** the token deploy,
   because the rates are frozen at deploy.
3. Payout registration is a **process decision, not a code defect** (requiring registration is intentional
   and documented). Choose emitter-funded auto-registration, registration at first paint, or a
   pre-registration step in the payout job — and write it into the token README and the payout job.

The branch was cut before the documentation cut, so `main` was merged into it (`3d214b8`) with the
`docs/README.md` conflict resolved — its two rows folded into the one-page map. No code conflicts.

## What Hermes takes now

**6 — `payments.rs` review.** Written up as `docs/payments/2026-10-28-payments-review.md` with each
finding classified (blocker / should-fix / note) and a test or a diff attached. Not a summary.

**1 — Schema-4 cleanup.** `contract-meta.ts` accepts 2 and 4 only; delete `paid-mode.ts`,
`features/pressure/*` mock paths and `payment-provider.ts`; update the tests that assert schema 3 is
valid. Test-first: the current tree must fail the new assertions before the deletion.

**7 — Testnet rehearsal.** Create the test FT and paid-board accounts, deploy, register the board on the
token (0.00125 NEAR), seed a small mural, and record account ids + receipts in
`docs/payments/testnet-deployment-2026-10.md`. This is what makes task 3's acceptance criteria real.

## What Hermes does NOT take

- The wall page's price rendering and the checkout UI (tasks 2, 3) — Cursor.
- Any contract arithmetic (tasks 4, 5) — Codex, then reviewed by me before merge.

## Order of operations

1. **Codex** starts 4 and 5 immediately (independent).
2. **Hermes** lands 1, then 6, then 7 (7 needs a test FT; it can start as soon as 1 is in).
3. **Cursor** starts 2 as soon as 1 is on main, then 3.
4. When 2 + 3 + 7 are green: one recorded testnet journey, connect → buy → paint → refresh, with hashes.
   That is the MVP exit criterion.

## Still waiting on the owner (blocks pricing, not code)

- **Launch price**: 0.0025 or 0.0069 NEAR per pixel. Every table in the economy doc moves with it.
- **Staking asset**: TOILET holds the revenue claim (recommended) or a split with mPOO.
- **Emission model**: revenue-keyed with the 1B cap (recommended) or a calendar schedule.
- **TOILET tradeability**: internal ledger or NEP-141. Task 5 assumes NEP-141.

## Local implementation handoff — 2026-10-28

Tasks 4 and 5 are implemented on `codex/paid-board-safety-toilet-token`, based on
`e745942`, pending independent review. Paid board: 63 tests; TOILET: 18 tests; both release
WASM builds pass. Frontend baseline: 284 tests and build pass, with existing `util`
externalization and mixed-import warnings. No deployment, signing or live token
transfer was performed. [Evidence and lessons](../learning/2026-10-28-contract-safety-and-token.md).

Correction to task 4's premise: its four safety fields were absent from `Tunables`
at the baseline. They have been added only there, but that **still changes persisted
Borsh state**. This is fresh-initialization code, not a migration-free upgrade.
An existing initialized board needs an explicit migration and rehearsal.

Task 5's tax is settled at transfer time; a receiver failure refunds only the net
delivery, without a second tax. This policy and fee-on-transfer venue risks are
documented in [the TOILET README](../../contracts/toilet/README.md).
