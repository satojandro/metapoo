# Backlog — verified state

> **Agents own this file. Keep it current.**
> Any change that alters a status updates this file **in the same PR**. A stale backlog is not
> a cosmetic problem: on 2026-10-27 it had six rows wrong, and dispatching from it would have
> had agents rebuild working code.
>
> The rule is not "don't write it" — it is **prove it**. Every row carries the commit, file,
> grep or command that establishes it. Never carry a status forward. Re-derive it every time.

## How to update this file

1. Run the check, do not recall the answer:
   `git log --oneline origin/main -- <the paths involved>` and grep for the artefact itself
   (e.g. `grep -rn "devicePixelRatio" web/src` for T1).
2. Move the row between sections. Keep the commit id that proves it in the Delivered row — that
   is what stops the next agent from re-dispatching it.
3. If you cannot establish a row this revision, mark it **unverified** with what is missing.
   Never guess, and never downgrade a delivered row because you did not look.
4. If you find a row wrong, fix it and say which commit proved you wrong, as the table below does.

## The incident this rewrite fixes

On 2026-10-27 the previous backlog claimed six items were "NOT delivered" or "PARTIAL".
Three of them were already shipped, by commits inside that document's own ancestry:

| claimed by the 2026-10-26 refresh | actually delivered by |
|---|---|
| T2 keyboard/a11y operability — "NOT delivered" | `6080412 feat: wall-controls-a11y-keyboard` |
| T3 mobile 390 px ergonomics — "PARTIAL" | `db4d50a feat: wall-mobile-paint-ergonomics-r2` |
| T4 stall composition — "PARTIAL" | `ff08ccf feat: stall scenery framing layers…` |
| T8 orientation — "not captured" | `2615cef feat: wall zoom controls + first-visit hint` |
| zoom readout — "does not exist" (my claim) | `b8a0861 feat: always-reachable wall position readout (zoom %)` |

**A status line is a claim, not evidence.** Every row below carries the command, file or commit
that proves it, and anything that cannot be proved that way is marked *unverified*.

To re-check any row:

```bash
git log --oneline origin/main -- web/src/pages/wall web/src/style.css web/src/wall-design.css
grep -rn "devicePixelRatio" web/src     # the T1 check, as an example
```

Baseline for this revision: `origin/main = 5b40b63`, 263 tests / 39 files, build clean.

---

## Delivered — do not dispatch

| id | item | evidence |
|---|---|---|
| T2 | Keyboard/a11y operability of wall controls | `6080412`. Swatches are `<button>` with `aria-pressed`, updated on click (`mount-wall.ts:2319-2339`); `.focus-visible` rings (`style.css:656,839`); arrow-key selection on the board (`mount-wall.ts:552`) |
| T3 | Mobile paint ergonomics | `db4d50a`. `@media (max-width:600px)` block in `wall-design.css:110` sizes the dock, flexes swatches, keeps a 44 px target |
| T4a | Stall scenery/composition layers | `ff08ccf`. Ceiling, side walls, back-wall art, toilet, floor, bezel and scene labels in `wall-template.ts:7-33` |
| T6 | Session discoverability (unlock in dock, plain copy) | `499c42f` |
| T7 | Pending-cell marker no longer repaints the cell | `a351516` |
| T11a | Drag paints at any zoom; pan is an explicit gesture | `9d13412` |
| T11b | Zoom floor at fit; wheel scaled by delta | `2322c84` |
| T11c | Duplicate zoom readout I introduced removed | `5b40b63` |
| R2.1 | Stroke cells stamped from the transaction receipt | `c547bcd` |
| R5 | Learning records + traps in the repo | `6860508` |
| — | Second tap queued while a paint confirms | `993842d` |
| — | Place button hidden while painting is armed | `c7f5af0` |
| — | Browser `Buffer` polyfill (strokes never reached the chain) | `4152d73` |
| — | Zoom controls + first-visit hint | `2615cef` |
| — | Always-reachable zoom % + cell coords readout | `b8a0861` |
| **T1** | Device-resolution canvas (DPR clamped 1–3, whole-block cells, bitmapHex read seam) | `19e95bd`. **Manual visual gate still open** — see below |
| **T9** | Drag preconditions named individually | `34eb5a1` (`strokeBlockedReason`) |
| **T8r** | Plain-language contract line + state legend | `34eb5a1` |

## Open — verified not done

| id | item | evidence that it is missing | size |
|---|---|---|---|
| **T5** | Schema-driven board dimensions | `mount-wall.ts:4` imports `BOARD_WIDTH/HEIGHT` and *validates* the contract against them (`contract-meta.ts`) rather than adopting contract values. Deliberate, but it means a differently-sized board is rejected instead of rendered | **S/M** |
| **R2.2** | Cheap change detection before paging | Full read is 6 requests today, 64 at 16,384 cells, every 4 s. Needs an O(1) view → **contract change = ask-first** | **M** |
| **T2b** | *(unverified)* roving tabindex over swatches | Not checked this revision. Tab moves through all 8 swatches rather than arrow keys within the group — cosmetic a11y, not a blocker | **S** |

## Blocked on a human decision

| id | item | what is needed |
|---|---|---|
| **T4b** | Board-dominant presentation | the visual direction decision (deferred by owner to the visual phase) |
| **T10** | Berry Club parity remainder | default-on shipped; single-tap-always is a consent decision |
| **R1** | Sign once, paint forever | four decisions listed in `roadmap.md` R1 |

## Payment stage — local work, deployment and UI pending (2026-10-28)

Evidence: branch source `contracts/paid-board/src/lib.rs` and `payments.rs` on
`codex/paint-credit-payments`; `new`, `buy_credits_near`, `ft_on_transfer`,
`get_credits`, `get_payment_config` and `set_credit_prices` exist. Baseline contract commits:
`0e4eae5` and `34b1a84`. The `codex/paid-board-safety-toilet-token` safety implementation has 63 local
tests and a passing release WASM build; see [contract verification](learning/2026-10-28-contract-safety-and-token.md).
not a live settlement or cost result. `contracts/board` (schema 2) is **retired as a product**
and kept only as the testnet fixture; deletion of `web/src/payment-provider.ts` and the
schema-3 mock path is assigned in [the work queue](implementation/2026-10-28-work-queue.md). Existing
pressure quotes do not implement this new payment UI. Mainnet deployment: none,
confirmed by owner. A testnet token is needed for the first paid rehearsal.

| ID | Pending work | Evidence / completion gate |
|---|---|---|
| PAY-UI | Read-only display locally implemented; live paid-wallet verification and mobile visual review pending | `web/src/paint-wallet.ts`, `app/paint-wallet-panel.ts`; 9 focused tests, full 284 tests/build passed. Browser checked against free testnet board. Checkout not implemented. |
| PAY-INTEGRATION | Paid schema-4 frontend and real testnet purchase → paint → refreshed balances | Local methods exist; no full-loop receipt evidence |
| **PAY-RECENCY-UI** | Show the repaint price before the user commits: per-cell cost, stroke total, one-line legend | **Contract shipped 2026-10-28** (`get_cell_cost`, `get_tunables`); the page still shows a flat price |
| **PAY-COST** | **Reopen immediately after first mainnet paid-board deployment** | [Required cost matrix](payments/mainnet-cost-validation.md); all mainnet cases pending, keep open through owner acceptance |
| PAY-SAFETY | Local implementation ready for review; chain rehearsal pending | Branch implementation in `contracts/paid-board/src/safety.rs`, price bounds and checked credit counters; 63 contract tests and release build pass. Pause, native withdrawals and price events implemented. Storage estimate still needs paid-board measurement. |
| PAY-UPGRADE | Select deployment authority and rehearse state-preserving upgrades before public paid launch | Owner-only `upgrade()` in `34b1a84`; pause now local. New safety fields change the stored layout: migration and testnet rehearsal remain open. |
| TOILET-TOKEN | Local implementation ready for review; deployment and venue compatibility unverified | Branch implementation in `contracts/toilet`: 18 tests and release build pass. Capped issuer, token/storage APIs, venue tax and supply views; no live cross-contract receipts. |
| ECONOMY-LATER | Staking, longevity rewards, board-to-token issuance, swaps, inventory shop | Still deferred. Standalone TOILET token code does not implement an emission schedule, vault or revenue distribution. |

## Open gates and scoped work

### T1 manual visual gate — **human, open**
`19e95bd` is tested but not seen. At paint zoom a single painted cell must be a solid square
with no halo or seam, compared side by side against the previous build. Until that is done, T1
is implemented, not accepted.

### T5 — scoped, **not started**
Adopting contract-reported board dimensions instead of validating against `BOARD_WIDTH`/`HEIGHT`
constants is not a small change: those constants are read by the camera (`fitCamera`, `clampPan`,
`zoomAt`, `boardScreenSize`), the renderer, selection and the template. Doing it properly means
board geometry becoming runtime state that the camera is rebuilt against after `get_board`.
File set for a dispatch: `web/src/viewport.ts`, `render-board.ts`, `pages/wall/mount-wall.ts`,
`shared/types.ts`, plus their tests. Risk: camera maths — `learning/traps.md` says do not change
it casually. Recommended: one task, tests first, human visual check after zoom and pan.

### Agent-orchestrator dispatch — 2026-10-27, blocked on credentials
T1 was dispatched (`max-tasks 1`, codex lane, gpt-6.1-sol). The PO planned it correctly — one
reversible task with the acceptance criteria from this document — then the engineer lane failed
four times with **zero file changes**. Cause: the Codex CLI's refresh token was rejected
(`your refresh token was already used`, then `workspace routing discovery unauthorized (401)`).
The work was therefore implemented directly.

Preconditions before the next dispatch:
1. **Re-login the Codex CLI** (`codex login`); verify with `codex exec -m gpt-6.1-sol "PONG"`.
2. The PO also carried forward a process escalation: `scope_violation` fires on reversible web
   files because of ask-first vocabulary matching, not because of a genuine off-scope edit. That
   gate needs narrowing before another web-only batch.

## Superseded inputs

| file | status |
|---|---|
| `remaining.json`, `remaining.harness.json` (repo root) | 46 raw items, heavy duplication, all `pass:false`. **Do not dispatch from these.** Rebuild from this document. |
| `fix_plan.md` | three unresolved P5 findings; they are **T1 acceptance criteria**, not separate tasks |
| `~/Hermes-crypto-builder/metapoo-backlog-refresh-2026-10-26.md` | **RETRACTED** for T2/T3/T4/T8 status — see the table above |
