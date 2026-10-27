# Roadmap — open product decisions

[Design assumption] / [Open question] / [Verified research] labels follow the convention
in `README.md`. This file holds decisions and work that are **not yet scheduled**.
Scheduled implementation tasks live in the orchestrator backlog, not here.

Last reviewed: 2026-10-27.

---

## R1. "Sign once, paint forever" — [Open question]

**Today.** One approval creates a NEAR **function-call access key** held by the browser,
scoped to `["draw", "draw_many"]` on the wall contract, with a lifetime gas allowance
(observed on chain: 0.25 NEAR, `DRAWING_SESSION_METHODS` in `web/src/drawing-session.ts`).
It survives reloads in that browser profile. It does **not** survive a different browser,
cleared storage, allowance exhaustion, or a contract redeploy.

**What "forever" has to decide:**

| question | options | note |
|---|---|---|
| Scope | key never expires vs re-approve on expiry | a non-expiring signing capability is a real decision on mainnet |
| Portability | per-browser (today) vs a user-carried delegation | portability means the secret lives somewhere movable — a wallet-embedded key, not localStorage |
| Renewal | explicit prompt vs silent re-request when allowance empties | silent renewal of a signing capability is a consent problem |
| Revocation | present: "Revoke on-chain" in About / details | needs to be reachable at the moment the user thinks of it |
| Multi-device | one key per device, or one shared | the contract only checks the signer account |

**Recommendation:** on testnet, key-never-expires + visible remaining allowance +
one-tap renew. Postpone portability until a real user complains. Do **not** add
silent renewal.

---

## R2. Board freshness cost — [Verified research] partly shipped

A full board read pages `get_pixels` at 256 cells per request. At 1,463 cells that is
6 sequential requests; at the board's 16,384-cell maximum it is **64 requests**, and the
visible-tab poll repeats that every 4 s (`BOARD_POLL_BASE_MS` in `web/src/board-sync.ts`).
It degrades linearly with success.

- **Shipped 2026-10-27 (`c547bcd`):** a confirmed stroke's executed block is kept from the
  transaction receipt and its cells are stamped in the cache at that block, so a painter
  no longer waits for a full read to see their own paint. The periodic read remains the
  reconciler.
- **Open:** cheap change detection before paging — poll an O(1) signal (painted count or
  last-write block) and only page when it moves. Needs either an existing view or a
  contract addition. **Contract changes are ask-first** in this repo.

---

## R3. Post — "How NEAR lets you paint without signing every pixel" — [Design assumption]

Educational asset, written from this codebase's failures rather than from docs.

1. The problem: one wallet popup per pixel is fatal for a drawing game. Measured baseline
   in this project: 16–18 s per pixel through wallet approval.
2. NEAR accounts are contracts with **multiple keys**, not one private key.
3. A **FunctionCall access key**: one contract, optional method list, optional gas
   allowance, held by the app.
4. What it buys: `draw_many`, one transaction per 64 cells, signed in the browser.
5. What it does not buy: the key can paint and nothing else. Show the on-chain key row.
6. The honest parts: browsers have no `Buffer` (see `docs/learning/traps.md`), allowance
   exhaustion is a UX problem, and the allowance delta is the only reliable way to tell
   "sent" from "never left the machine".
7. Counterfactual: a chain without scoped keys.

---

## R4. Post — "Berry Club 2021 → 2026: what actually changed" — [Open question]

**Product delta.** Berry Club (NEAR, 2020–21): 16 colours, one pixel per transaction,
on-chain `buy_tokens`/`sell_tokens` ASM curves, one canvas. This rebuild: 128×128 schema 2,
8-colour palette, `draw_many` batched strokes, drawing-session keys, `open_wall` rule,
with pressure pricing, bounties and prints planned.

**Protocol delta — must be researched at write time, never from memory.** At minimum:
`near-sdk` version changes and NEP-330 contract metadata; NEP-366 delegate actions and
sponsored gas; account-id rules and implicit accounts; global contract identifiers (the
`@near-js/transactions` version here already exposes `GlobalContractIdentifier`);
function-call key allowances as a first-class pattern; fee/gas-market changes and
`EXECUTED_OPTIMISTIC`; what a 2021 wallet versus a 2026 wallet selector gives you free.

> Rule: every claim checked against `near-sdk` changelogs and nomicon NEPs at write time.
> A "protocol upgrades" post assembled from memory is the easiest way to embarrass the project.

---

## R5. Learning records — [Verified research] currently unmaintained

`README.md` item 9 and `09-learning-journal.md` define a learning record. `docs/learning/`
held two files, both dated 2026-10-11 (the day the scaffold was written), until
2026-10-27 — sixteen days of work with no record. See `docs/learning/README.md` for the
rule and `docs/learning/2026-10-27-paint-session.md` for the first real entry.
