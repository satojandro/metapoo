# Meta Poo — code audit and product review

Date: 29 October 2026. Baseline: `main` = `09965fe` (in sync with `origin/main`). Status: findings for
owner review. Nothing in this document changes code, contracts or deployments.

Companion: [`2026-10-29-whole-site-design-review.md`](2026-10-29-whole-site-design-review.md) (UX and
visual design, reviewed against an older main `c6979be`). This audit does not repeat it; it checks
which of its findings still hold.

## Owner decisions (29 Oct, after the first draft)

| question | decision |
|---|---|
| target | **mainnet, real money**: the game for the mPOO memecoin. Minimum bar: **Berry Club feature parity**, on current protocol standards |
| canonical testnet paid board | **`board3.metapoo-player1.testnet`**. Every other id in the docs is wrong |
| bounties, prints, history service, pressure simulation | **remove from `main`**, recoverable from a tag |
| agents | Hermes (co-founder) stays. Claude has priority over Codex |
| mPOO payments | **offered at mainnet launch** (`mpoo.nearlytrade.near`), alongside NEAR |
| mPOO credit price | **20% holder discount** against the NEAR price (C8 below) |
| where revenue goes | NEAR revenue is used to buy mPOO; all mPOO (bought or received) goes **70% to TOILET stakers, 30% burned** (§1b below) |
| TOILET economy | **required for mainnet launch**. This overrides §4.1 below: sequence it, don't freeze it |

Consequence: C1, C2 and C7 become **mainnet blockers**.

**Decided: mPOO is a payment option at mainnet launch.** This supersedes the "NEAR only" entry in the
deployment record. The contract path exists; the UI hides it until C8 is settled and an mPOO purchase is
recorded on testnet.

## What was checked

| check | result |
|---|---|
| `web`: `npm test` | 44 files, **293 tests pass** (one harmless happy-dom abort log at teardown) |
| `web`: `npm run build` (`tsc` + vite) | **clean**; 493 KB JS (156 KB gzip); known `util` externalisation + mixed-import warnings |
| `contracts/paid-board` `cargo test` | **86 pass** |
| `contracts/toilet` `cargo test` | **24 pass** |
| `contracts/board` `cargo test` | **23 pass** |
| `contracts/bounties` | compiles with unused-result warnings in the sandbox test; not part of the product |
| Chain reads, wallet, live page | **not done** in this audit — no transaction or browser evidence below |

The engineering underneath is better than "messy" suggests: small tested modules, honest comments,
checked arithmetic in the contracts, atomic strokes, explicit failure codes. What is messy is the
**layer around the code**: documents that contradict each other, scaffolding from abandoned
orchestration runs, and a product surface that still carries work nobody is shipping.

---

## 1. Contract findings (money path)

Ordered by severity. None of these is exploitable for theft by a stranger; the top two are about what
the owner can do to buyers and what a buyer can be charged without seeing it.

### C1 — `set_tunables` defeats the price-change guard · **should fix before mainnet**

`set_credit_prices` is carefully bounded: at most ×2 / ÷2 per step, one change per 24 h
(`payments.rs:144-170`). But the effective price of painting is `near_per_credit × credits_per_cell`,
and `Tunables::validate` (`lib.rs:136`) only requires the repaint credits to be `> 0`. The owner can
set `repaint_base_credits = 1000` in one transaction with no cooldown, which multiplies the price of
every pixel — and devalues every credit already sold — by 1000×.

Fix: bound each repaint tier (e.g. `1..=8`), require base ≤ mid ≤ young, and put changes to credit
costs under the same cooldown as `last_price_change_ns`. Same review for `max_outstanding_credits`
(can be set below current outstanding — harmless, but should be deliberate).

### C2 — paint has no `max_cost`, so the user can pay up to 4× the price shown · **product decision**

`draw` and `draw_many` charge whatever the cell costs *at execution time* (`lib.rs:478, 541`). The page
quotes first, but between quote and execution another painter can touch the cell and move it from 1 to
4 credits. Since `09965fe` the tap path does not quote at all: it checks a cached per-cell cost that is
never invalidated (`mount-wall.ts:326, 1824`) and defaults to 1 for unknown cells
(`repaint-price.ts:140`).

So the displayed price is advisory. On testnet that is fine; with real money it is the kind of thing
people call a scam on social media. Options: add `max_credits` to `draw`/`draw_many` (contract change,
ask-first), or keep it and say plainly in the UI "price can rise if someone paints here first, up to
4 credits". I recommend the contract argument. It is the same pattern `buy_credits_near` already uses
with `expected_price`, and the retired schema-3 board had exactly this (`max_cost` on every paint).

### C3 — `max_earning_cells` and the quota tunables are stored but not enforced · **document or delete**

`max_earning_cells` (default 128) and `quota_base/per_cell/max` are in `Tunables` but nothing reads
them (`grep max_earning_cells contracts/paid-board/src` → only the struct and default). An operator
reading `get_tunables` will believe a cap exists that doesn't. Emission is currently `0`, so no harm
yet — but if emission is switched on, one account holding 16,384 cells earns on all of them.

### C4 — `claim_toilet(toilet)` lets the caller choose the token contract · **low**

The board mints on whatever account the caller passes (`emission.rs:46`). Passing a fake contract only
destroys the caller's own pending balance, so it is not theft, but it is a footgun for a UI bug and
means the board never commits to one token. Store the token id at `new` (or set it once) instead.

### C5 — withdrawable NEAR uses a storage estimate from the old board · **verify on testnet**

`STORAGE_PER_PIXEL` is 66.4 bytes, measured on the schema-2 free board (`safety.rs:8-11`). Paid-board
records carry an `AccountId` plus `IterableMap` index overhead, and new accounts add `holders` and
`balances` rows. If the real figure is higher, the owner can withdraw down to a level where later first
paints fail with `LackBalanceForState`. The 5 NEAR reserve floor masks this at small scale. Measure
`storage_usage` before/after 100 first-paints on the testnet board and replace the constant.

### C6 — TOILET auto-registration is paid from the token's own balance · **low, once emission is on**

Any account with a single held cell can claim a dust amount and make the token fund its storage
record (`toilet/src/lib.rs` `mint`). Many sybils drain the token to its 1 NEAR floor, after which all
first-time claims fail (they are restored, not lost). Fine while emission is 0; set a minimum claim
before switching it on.

### C7 — no migration exists for the `upgrade()` path · **known, still open**

`upgrade()` is present; there is no `migrate` / `#[init(ignore_state)]` anywhere. Any layout change
bricks state. This is already `PAY-UPGRADE` in the backlog — listing it so it is not forgotten behind
the newer work.

### C8 — a fixed mPOO price can't track a memecoin · **mainnet blocker now that mPOO is offered**

`mpoo_per_credit` is an owner-set constant, bounded to ×2 / ÷2 per 24 h (`payments.rs:144-170`). A memecoin
can move more than 2× in a day. When it does, one currency becomes the cheap way to buy credits. If mPOO
rises, credits bought with mPOO cost less than credits bought with NEAR, and anyone can take the
difference. If it falls, nobody pays in mPOO. The guard that protects buyers from the owner also stops the
owner from keeping up.

Why drift matters less than it looks: credits can't be resold, refunded or transferred, so cheap mPOO
credits can only be used to paint, and that drives buying of mPOO. Only three things are actually at risk:
NEAR for storage, cheap TOILET farming (C3), and NEAR revenue.

**Decided design (owner, 29 Oct): a holder discount, set by hand, with a cap. No oracle.**

- **Rule:** `mpoo_per_credit = near_per_credit × (mPOO per NEAR, 7-day average) × 0.8`, so mPOO pays 20% less.
- **Rate:** recomputed **weekly** off-chain from the NEARLY/Rhea pool and set with `set_credit_prices`. The
  method is public and every change is a logged `price_changed` event. The ×2-per-day bound then only guards
  against a compromised key.
- **Cap (new contract work):** a tunable board-wide limit on credits sold for mPOO per UTC day, with a
  counter. If mPOO pumps between updates, the cheap credits run out for the day and the UI offers NEAR
  instead. This bounds exposure without an oracle.
- **Separate cooldowns:** today one call sets both prices under one 24 h cooldown, so a weekly mPOO update
  would block an emergency NEAR change for a day. Give each price its own cooldown when fixing C1.
- **Storage:** fund the board with NEAR for the whole wall's first paints, measured per C5. Then the payment
  currency doesn't affect solvency.

Also: registration and gas are still NEAR, so an mPOO-only holder needs some NEAR. `ft_on_transfer` rejects
routed deposits (see below), so "swap and buy" in one step won't work.

### Also noted

- `ft_on_transfer` rejects when `sender_id != signer_account_id` (`payments.rs:242`). That blocks
  multisig wallets and any NEP-366 relayed transaction. Intentional, but it should be in the README.
- The session key is a function-call key in `localStorage` with no CSP on the page. On the paid board
  it can spend all of a user's credits. Acceptable on testnet; add a CSP and a credits warning before
  mainnet.

### 1b — revenue flow: NEAR → mPOO → 70% stakers / 30% burn · **new work, owner-decided**

Decided 29 Oct. It matches option A in the [economy spec](economy/2026-10-28-toilet-economy-v1.md) §4/§12:
TOILET holds the revenue claim, and mPOO is the money. `mpoo.nearlytrade.near` exposes `burn` (verified in
economy §5).

| step | proposed mechanism | trust |
|---|---|---|
| mPOO paid for credits | stays on the board, tracked in a new `mpoo_undistributed` counter | contract |
| split mPOO | new `distribute_mpoo()`: 30% `burn` on the mPOO contract, 70% `ft_transfer` to the staking contract. The **only** way mPOO leaves the board, so the split can't be skipped | contract |
| NEAR revenue | `get_withdrawable_near()` already excludes storage, outstanding credits and the 5 NEAR floor; weekly `withdraw_near` | owner |
| NEAR → mPOO | **weekly buyback by the operator** on NEARLY/Rhea, with transaction hashes published, then the mPOO goes back to the board and through `distribute_mpoo()` | operator, auditable |
| pay stakers | **new TOILET staking contract**: stake TOILET, accrue mPOO pro rata (same accumulator pattern as `emission.rs`), claim | contract |

Why the buyback is off-contract at first: an on-chain swap means a cross-contract call to Rhea, slippage
limits, NEARLY's tax on Rhea-bound transfers, and refund handling. That is the "swap adapter" the
`ft_on_transfer` comments already warn about. A weekly published buyback is honest and much smaller. It can
be automated later.

**Open questions:**
- **No team or ops share?** As decided, 100% of net revenue goes to stakers and the burn, and NEAR for
  storage is protected by the reserve. Any running cost (RPC, hosting, the weekly buyback's gas) comes out of
  your pocket. Confirm that this is intended.
- **Exit tax on unstaking?** The economy spec suggests a capped 10% "paperhand" burn. Decide before the
  staking contract is written.
- **Sell pressure:** stakers paid in mPOO may sell straight away (economy §12). The 30% burn is the offset.
  Worth watching, not blocking.

---

## 2. Frontend findings

### F1 — `mount-wall.ts` is 2,544 lines in one closure

Fifty-plus inner functions share ~40 mutable `let`s (`selected`, `drawInFlight`, `cachedCredits`,
`priceUnavailable`, `cellCostCache`, …). Every agent that touched paint, price or checkout edited this
one file, which is why the last five commits are fixes to interactions between features (a price read
blocking a paint, a failed read dead-ending painting). The extracted modules around it (`repaint-price`,
`stroke-commit`, `paint-queue`, `board-sync`) are good; the controller that wires them is the problem.

Recommendation: before checkout grows further, split by responsibility — **board sync**, **pricing &
credits**, **paint submission**, **camera & gestures** — each a small object with explicit state, with
`mountWall` reduced to wiring. Do it as a pure refactor with no behaviour change, test-first, one PR.
It is the single change most likely to stop the regressions.

### F2 — paid-board pricing state has no single owner

Credit balance lives in at least three places: `cachedCredits`/`creditsKnown` in mount-wall, the
buy-credits sheet's `onCreditsChanged`, and the dock text. Cell costs live in `cellCostCache` (never
expired) and in each quote. Queued taps all check the same cached balance and are not decremented, so
five fast taps with 2 credits all pass the client check and three fail on chain. This is a symptom of
F1; fixing F1 is the fix.

### F3 — design-review P1s still present on today's main

| design-review finding | still true? | where |
|---|---|---|
| "cannot move your funds" without saying it can spend credits | **yes** | `wall-template.ts:113` |
| static "Testnet" / "No app fee" / "LIVE BOARD" labels | **yes** | `wall-template.ts:9, 45` |
| internal "Worker H owns…" copy on public routes | **yes** | `register-default-pages.ts:34-50` (`/history`, `/prints/:id`, `/account`) |
| no checkout | **no — fixed** | `buy-credits-sheet.ts`, `55526b9` |

The first one matters most: on a paid board it is now inaccurate.

### F4 — roughly 12,000 lines ship or sit in the repo for features that are not the product

`contracts/bounties` + `contracts/prints` + `board/src/pressure.rs` + `services/history` +
`simulations/pressure` ≈ 8,600 lines; `web/src/pages/bounties` ≈ 3,800 lines. Bounties are gated off
by `VITE_EXTRA_PAGES_ENABLED`, but the code is still bundled, tested and read by every agent that greps
the repo. `shared/protocol/*` is imported only by `services/history`.

Recommendation: move them to an `archive/` branch or a tag and delete from `main`. They are in git
history either way. This also shrinks what an agent has to understand before touching the wall.

---

## 3. Repository and documentation hygiene

This is where "messy" actually lives. The project has a strong rule — *a status line is a claim until
you check it* — and the top-level documents currently break it.

| claim | where | reality |
|---|---|---|
| paid wall "not deployed", checkout "not built" | `README.md` table | deployed to testnet 29 Oct; checkout shipped in `55526b9` |
| "a pixel currently costs 0.0069 NEAR" | `README.md` | 0.0025 (`payments.rs:13`, `82c9852`) |
| "free board's testnet id is already the default in `.env.example`" | `README.md` | `VITE_CONTRACT_ID=` is empty |
| paid-board account | three different ids | `board3.metapoo-player1.testnet` (deployment doc), `board1.metapoo-player3.testnet` (docs map, design review) |
| safety + TOILET "on the review branch, not on main yet" | `docs/README.md` | merged in PR #15–#17 |
| "54 contract tests" / "63" / "65" | README, roadmap, work queue | 86 today |
| contract README "schema 4, not deployed" | `docs/README.md` | deployed on testnet |
| work queue baseline `0a3e284`, "nothing is deployed" | `implementation/2026-10-28-work-queue.md` | stale by ~25 commits |

Stray root files: `remaining.json` / `remaining.harness.json` (145 KB, backlog itself says "do not
dispatch from these"), `fix_plan.md`, `.ao/` orchestrator logs, `signs/` — all from the 17–21 Oct agent
orchestrator. 27 remote branches, most from merged or abandoned agent runs (`ao/*`, `batch/po-1`,
`cursor/*`, `codex/*`), plus two stale local branches.

**Done in the cleanup PR (`chore/cleanup-2026-10-29`):** the README, docs map, backlog payment rows and
both contract READMEs were corrected to `board3.metapoo-player1.testnet` and the current state. The work
queue is marked superseded. The stray files and non-product code are deleted, recoverable from the tag
`archive/pre-cleanup-2026-10-29`. **Still open:** deleting the merged remote branches, which needs the
owner's go-ahead.

---

## 4. Product review

**What is good.** The premise (a communal wall above a toilet) is memorable. The paid model is
thought through: prepaid credits, exact-price purchase guards, recency pricing that makes griefing
expensive rather than banned. Strokes are atomic. Failure states are named honestly. The
learning/traps discipline is unusual and valuable.

**The main risk is scope, not quality.** In two weeks the project grew a pixel wall, a paid wall, a
capped token with taxes and emission, staking design, bounties, prints, a history service, a pressure
simulation and an agent orchestrator. The MVP the work queue itself defines — *a stranger connects,
understands the price, buys credits, paints, and someone else sees it* — has still not been recorded
end-to-end on testnet. Everything that is not on that path is currently cost.

**Specific product calls I would make:**

1. ~~Freeze the TOILET economy until the paint loop has real users.~~ **Overruled by the owner:** TOILET is
   required for mainnet. Sequence it after the paint loop is proven, and turn emission on only once C3
   (earning cap) and C6 (minimum claim) are enforced. The economy doc's own math is still the warning:
   the board's entire first fill is about $190, so uncapped emission can be captured by one wallet.
2. **Decide C2 (price slippage) before inviting anyone.** Being charged more than the number you saw is
   the fastest way to lose trust in a paid toy.
3. **Make tap-to-paint and select-then-place one mental model.** Today there is Direct paint, Place
   paint, Paint zoom, Focus and drag strokes; on a paid board each tap spends money. The design
   review's state-aware dock is the right answer.
4. **Seed the wall.** An empty dark square does not explain a communal wall. A labelled owner-painted
   starting mural is honest and solves it.
5. **Run the five-person test** from the design review as soon as the MVP loop is recorded. It is
   cheaper than any more building.

## 5. Order of work (revised for the mainnet goal)

1. **Cleanup PR**: docs fixed to `board3.metapoo-player1.testnet` and current state (§3), stray orchestrator
   files and merged branches removed, non-product code removed from `main` behind a tag (F4), and the F3
   copy fixes.
2. **Berry Club parity matrix**: verify the original's features from its open-source contract and frontend,
   never from memory, then map each one to Meta Poo as done, partial or missing. Credits ≈ avocados,
   TOILET-from-held-cells ≈ bananas, and TOILET staking for revenue ≈ the Berry Farm are the likely
   mapping. Treat this as a hypothesis until it's checked.
3. **Recorded testnet journey** with transaction hashes: connect → buy (NEAR **and** mPOO, the latter
   once C8 is decided) → paint →
   seen in a second browser (`PAY-INTEGRATION`).
4. **One contract revision**: C1, C2, C3, C4, C6, the C8 daily mPOO cap and split cooldowns, `distribute_mpoo()` (§1b),
   plus a migration (C7), rehearsed as a state-preserving
   upgrade of `board3.metapoo-player1.testnet`.
5. **`mount-wall.ts` refactor** (F1/F2), behaviour-neutral, before claim and staking UI are added to it.
6. **TOILET on**: claim UI, emission rate, then the **staking contract** paying mPOO (§1b), and the first
   weekly buyback/burn/distribution, recorded on testnet.
7. **Mainnet**: an external review of the paid board and TOILET, the cost matrix (`PAY-COST`), and an
   owner-held deploy key.
