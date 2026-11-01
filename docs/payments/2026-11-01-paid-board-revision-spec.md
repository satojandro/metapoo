# Paid board revision — spec for review

Date: 1 November 2026. Status: **draft for the owner and Hermes to review. Nothing here is implemented.**
Contract changes and redeploys are ask-first (`AGENT.md`). This document asks for one approval: build
this revision, test it, and rehearse it on `board3.metapoo-player1.testnet`.

Baseline: `contracts/paid-board` on `main` = `218c271` (schema 4). Inputs:
[code audit](../2026-10-29-code-audit.md) §1, [parity matrix and owner answers](../2026-10-29-berry-club-parity.md),
[handover decisions](../handover-2026-10-29.md), [upgrade policy](upgrade-policy.md).

## Scope

This revision finishes **the first loop: register → buy (NEAR or mPOO) → paint → revenue leaves the
board correctly.** It is the contract that launches on mainnet.

**TOILET is out of scope.** The owner has said the full TOILET cycle is the next review round. This
revision only stores the one fact TOILET will need later (which cells were painted for free), so that
round doesn't need another layout change for it. Emission stays at rate 0.

| in this revision | id |
|---|---|
| bound the repaint-cost tunables and put them under a cooldown | C1 |
| `max_credits` on `draw` and `draw_many`, so a painter never pays more than they saw | C2 |
| measure storage per cell and per account, and reserve for empty cells instead of credits | C5 |
| a migration path, rehearsed as a state-preserving upgrade | C7 |
| a daily cap on credits sold for mPOO, and separate price cooldowns | C8 |
| revenue leaves the board only through a fixed split, callable by anyone | R1, R2 |
| 16-colour palette (Grime & Gum) | P1 |
| 25 free first paints per account until the first board is full | F1 |
| weekly happy hour | F2 |

| deferred to the TOILET round | id |
|---|---|
| enforce `max_earning_cells` and the quota tunables | C3 |
| store the TOILET token id instead of taking it as an argument | C4 |
| minimum claim | C6 |
| free cells earn no TOILET until repainted with credits (the bit is stored now, enforced then) | — |
| TOILET staking contract, exit tax, held-cell paint allowance | — |

## Findings from reading the code for this spec

1. **mPOO can't leave the board today.** `ft_on_transfer` accepts mPOO for credits, but nothing in
   `contracts/paid-board/src` calls `ft_transfer`. Every mPOO paid would be stuck. R2 fixes this, and
   is why mPOO payments can't be switched on with the current contract.
2. **Mainnet is a fresh deployment, not an upgrade.** Nothing is deployed on mainnet. The migration (C7)
   is needed to carry `board3` on testnet forward, and as the tested pattern for every later mainnet
   upgrade. It doesn't have to move live mainnet money this time.
3. **Per-account and per-cell maps can't be rewritten in a migration.** `balances` is a `LookupMap`
   (not iterable) and `pixels` can hold 16,384 records, too many for one transaction. So this design
   **never changes the value type of an existing map.** New per-account and per-cell facts go in new
   maps with new prefixes, read with a default when absent. Only the top-level `Board` struct changes,
   and that is one value, cheap to migrate.
4. **After the first board is full, credits need no storage.** Repaints overwrite an existing record.
   Today's reserve protects `outstanding credits × storage per pixel` forever, which over-reserves after
   the fill and under-reserves for free first paints, which carry no credits. C5 replaces it.

## C1 — bound the repaint costs

Today `Tunables::validate` only requires repaint credits to be above zero. The owner can multiply
every pixel's price by 1000 in one transaction, without the price cooldown.

- Each repaint tier must be within `1..=8` credits, and `base ≤ mid ≤ young`.
- `repaint_young_ns ≤ repaint_mid_ns ≤ 24 h`.
- A change to any repaint credit value counts as a price change: it needs the NEAR price cooldown to
  have passed, and it restarts that cooldown.
- `max_outstanding_credits` can't be set below the current outstanding total (it would block all sales
  with a confusing error). Setting `0` (uncapped) is always allowed.

**Tests:** each bound rejected with its own code; a repaint change inside the cooldown rejected; a
repaint change outside it accepted and the cooldown restarted.

## C2 — `max_credits` on paint

Between quote and transaction, another painter can make a cell cost 4 credits instead of 1. The
contract charges whatever it costs at execution.

- `draw(x, y, color, max_credits: u32)` and `draw_many(cells, max_credits: u32)`.
- If the stroke's total cost (after any free paints, F1 and F2) is above `max_credits`, the call
  rejects with `PriceRoseAboveMax` and nothing is stored or charged.
- The argument is required. Old frontends stop working against the new contract, which is intended:
  the page and contract ship together.
- Session keys aren't affected: they are scoped to method names, not arguments.

**Frontend:** pass the quoted total from `get_cell_costs`. On `PriceRoseAboveMax`, re-quote and ask once.

**Tests:** cost equal to max succeeds; one credit above rejects; a stroke where a duplicate cell raises
the cost above max rejects; free cells count as 0 against the max.

## C5 — storage, measured

- Measure on testnet, with the new code: `storage_usage` before and after 100 first paints by distinct
  accounts, 100 first paints by one account, 100 registrations, and 100 free-cell flags. Record the
  numbers in [`mainnet-cost-validation.md`](mainnet-cost-validation.md).
- Replace `STORAGE_PER_PIXEL` with the measured per-cell figure (record plus index plus free flag),
  rounded up 10%.
- New reserve rule, in `get_withdrawable_near`:
  `protected = storage used now + empty cells × storage per pixel + reserve floor`, where
  `empty cells = 16,384 − painted cells`. Outstanding credits no longer reserve storage. Each credit
  either paints an empty cell, already covered by the empty-cell term, or repaints one, which needs
  none.
- Check the 0.01 NEAR registration fee covers the measured per-account storage, including the new
  account record (F1, F2). If it doesn't, raise it.

**Mainnet funding:** the board must hold the empty-cell reserve before launch: about 16,384 × 0.0066 ≈
**109 NEAR** at today's unverified estimate, plus the 5 NEAR floor. The measured figure replaces this.

## C8 — mPOO price safety

Owner decision (29 Oct): 20% holder discount, rate set by hand each week from a 7-day pool average,
daily on-chain cap, no oracle.

- **Daily cap.** New tunable `mpoo_daily_credit_cap` (credits). The board counts credits sold for mPOO
  in the current UTC day (`floor(now / 86,400 s)`). A purchase that would cross the cap is refunded
  with `MpooDailyCapReached`, and the page offers NEAR instead. `0` means mPOO sales are closed, which
  is the default at deploy.
- **Separate cooldowns.** `near_price_cooldown_ns` and `mpoo_price_cooldown_ns`, each with its own last
  change time, each at least 24 h. `set_credit_prices` becomes `set_near_price` and `set_mpoo_price`.
  A weekly mPOO update then never blocks an urgent NEAR change.
- The ×2 / ÷2 step limit stays on both. If mPOO moves more than 2× in a week, the owner steps twice
  over two days, and the daily cap bounds what can be bought cheaply in between.

**Tests:** cap reached within a day refunds the whole transfer; the counter resets at the next UTC day;
changing one price doesn't start the other's cooldown.

## R1 — NEAR revenue leaves only through a split

Owner decisions: 10% to the team at the source, in the currency paid; the rest buys mPOO. Automate it.

- New `distribute_near()`. **Anyone can call it**, at most once per `distribution_interval_ns`
  (tunable, default 1 hour). It takes `get_withdrawable_near()` and sends **10% to `team_account`** and
  **90% to `buyback_account`**. Rounding dust goes to the buyback.
- `buyback_account` is where the operator swaps NEAR for mPOO on Rhea/NEARLY. The swapped mPOO comes back
  to the board through R2. An on-chain swap is a later stage (parity doc, "Automating revenue
  distribution", stage 2).
- `team_account` and `buyback_account` are set at `new` (or in the migration). Changing either is
  owner-only, needs a 7-day cooldown, and emits an event.
- **`withdraw_near` is removed**, so the split can't be skipped. *Decision needed, see the end.*
- The transfers are promises. If one fails, a callback adds the amount back so the next call retries it.

**Tests:** non-owner can call; second call inside the interval rejects; amounts are exactly 10/90 of
withdrawable; a failed transfer restores the amount; withdrawable never dips into the reserve.

## R2 — mPOO revenue: 10 / 70 / 20

Owner decision (1 Nov): 10% team, 70% TOILET stakers, 20% burned.

- Every mPOO accepted by the board adds to `mpoo_undistributed`. That covers credit purchases and mPOO
  sent back by the buyback operator. `ft_on_transfer` gets a second message type,
  `{"revenue": {}}`, accepted only from `buyback_account`.
- New `distribute_mpoo()`. **Anyone can call it**, on the same interval. It sends:
  - **10%** to `team_account` with `ft_transfer`
  - **20%** to the mPOO contract's `burn`. *The method's exact arguments must be read from
    `mpoo.nearlytrade.near` before implementation. The economy spec confirms `burn` exists, not its
    signature.*
  - **70%** to `mpoo_staker_reserve`, a counter on the board. The staking contract doesn't exist yet.
    When it does, the owner sets `staking_contract` **once**, and from then on the 70% is forwarded
    with each distribution, including what built up in the reserve. Until then the reserve can't be
    spent by anyone, the owner included.
- Each outgoing transfer has a callback that restores its amount on failure.
- `team_account` and the staking contract must be registered for storage on the mPOO contract before
  the first distribution. The callback catches it if they aren't.
- NEARLY's tax applies to transfers to and from the Rhea pool only (economy spec §5), so these
  transfers aren't taxed. The operator's buyback swap is.

**Tests:** split exact to the yocto with dust to the reserve; burn failure restores the 20%; reserve
accumulates until `staking_contract` is set and can be set only once; `revenue` messages from anyone
except `buyback_account` are refunded.

## P1 — 16 colours

- `PALETTE` grows to 16 entries: today's 8 at 0–7, then Grout `#8a857c`, Rust `#7a4528`, Nicotine
  `#ecd9a0`, Bubblegum `#ec8fb0`, Bleach `#9ccbdc`, Bruise `#263552`, Bile `#9fb53a`, Cone `#ef7a2c`
  at 8–15.
- `shared/palette.ts` and `shared/board.json` change in the same PR. The shared drift test must pass.
- No storage or migration effect: colour is already a `u32`, and existing cells keep their index.

**Tests:** colour 15 accepted, 16 rejected with `ColorOutOfRange`; `get_board` returns 16 entries.

## F1 — free first paints

Owner decision: 25 per account, only until the first board is full.

- New latch `first_fill_complete`. It becomes `true` the first time every cell has been painted, and
  never goes back.
- Before the latch, painting an **empty** cell costs 0 credits if the account has used fewer than 25
  free first paints. In a stroke, free paints apply to empty cells first, in order. The rest of the
  stroke pays normally.
- The account must be registered (0.01 NEAR). That is the sybil cost. At 25 cells per account it's
  0.0004 NEAR per free cell, and the reason to farm them is removed in the TOILET round, when free
  cells stop earning.
- New per-account record in a **new** map (prefix `a`, never `c`):
  `AccountExtra { free_first_used: u8, has_purchased: bool, happy_hour_window: u32, happy_hour_used: u16 }`.
  Absent means all zeros.
- New set `free_cells` (prefix `f`): a cell is in it while its latest paint was free. A paid repaint
  removes it. Nothing reads it in this revision except a view. It's stored now so TOILET can
  use it without a migration.
- Tunable `free_first_paints_per_account` (default 25, bound 0–100). `0` turns it off.

**Tests:** 25th free paint free, 26th charged; a repaint is never a free first paint; a stroke of 30
empty cells charges 5; the latch sets on the last empty cell and free first paints stop; a paid repaint
clears the free flag.

## F2 — happy hour

Owner decisions: weekly, Sundays 20:00 UTC, 1 hour by default, 100 free cells per account, base-tier
cells only, only accounts that have bought credits once, kill switch, no global cap, only after the
first board is full.

- Tunables: `happy_hour_enabled` (default **off**), `happy_hour_weekday` (0 = Monday … 6 = Sunday,
  default 6), `happy_hour_start_s` (seconds after midnight UTC, default 72,000), `happy_hour_length_s`
  (default 3,600, bound 15 min–24 h), `happy_hour_cap_per_account` (default 100, bound 1–1,000),
  `happy_hour_requires_purchase` (default true).
- A window is open when the latch is set, the switch is on, and the current time falls inside this
  week's window. Week boundaries are computed from the block timestamp. 1 Jan 1970 was a Thursday, and
  the formula and its tests must cover that.
- Inside the window, a cell whose current cost is the **base tier** costs 0, up to the account's cap
  for this window. Cells at the mid or young tier pay normally. That protects fresh art.
- `has_purchased` is set by any successful credit purchase, NEAR or mPOO. Existing buyers on `board3`
  have no record. They start at `false` and become `true` on their next purchase. That's acceptable on
  testnet. Mainnet starts fresh.
- A cell painted free in happy hour joins `free_cells`, same as F1.
- **Switch rules:** turning happy hour **off is immediate**, so it works in an emergency. Turning it on,
  raising the cap or lengthening the window needs the 24 h cooldown. *This refines the 1 Nov note that
  put the whole switch under the cooldown.*
- New view `get_happy_hour()`: open or not, current window start and end, the caller's used count.

**Tests:** window boundaries (start inclusive, end exclusive); cap per account per window, reset the next
week; mid/young cells charged during the window; non-buyers charged when the purchase flag is on; window
closed before the latch; switching off takes effect in the same block.

## C7 — migration and upgrade rehearsal

- Add `state_version: u32` to `Board`. The current deployed layout is version 1, this revision is 2.
- `migrate()` is `#[private] #[init(ignore_state)]`. It reads the version-1 struct, writes version 2
  with the new fields at their defaults (team and buyback accounts as arguments), and rejects any other
  source version with `UnsupportedStateVersion`. Run twice, the second call rejects.
- Existing maps (`p`, `h`, `c`) are untouched. The new maps (`a`, `f`) start empty.
- `upgrade(code, migrate_args)` deploys and calls `migrate` in **one promise batch**, so the board is
  never left running new code over old state.
- Test with real old state: serialize a version-1 board with balances, painted cells, holders and
  outstanding credits; migrate; assert every balance, pixel, holder count and outstanding total is
  unchanged.

**Rehearsal on `board3.metapoo-player1.testnet`:** record code hashes before and after, the upgrade
transaction, and `get_credits` / `get_pixels` / `get_outstanding_credits` reads before and after for at
least three accounts with balances. Then run the full loop again on the upgraded board, the way the
owner did on 29 Oct: register, buy with NEAR, buy with mPOO (cap set above 0 for the test), paint with a
free first paint, run both distributions. Record transaction hashes this time.

## New public methods and changed signatures

| method | change |
|---|---|
| `draw`, `draw_many` | add `max_credits` |
| `set_credit_prices` | replaced by `set_near_price`, `set_mpoo_price` |
| `withdraw_near` | removed (decision needed) |
| `distribute_near`, `distribute_mpoo` | new, anyone can call, rate-limited |
| `set_team_account`, `set_buyback_account` | new, owner, 7-day cooldown |
| `set_staking_contract` | new, owner, once |
| `get_revenue_state` | new view: undistributed mPOO, staker reserve, next distribution time, accounts |
| `get_happy_hour`, `get_free_first_paints(account)` | new views |
| `upgrade` | deploys and migrates in one batch |
| `migrate` | new, private |

## Frontend work this revision needs

Listed so it's sized. It lands on `web/` after the contract, on its own branch:

- 16 swatches in the dock (phone layout must still fit)
- pass `max_credits`, handle `PriceRoseAboveMax`
- show free first paints left, and "free" on the stroke total
- happy-hour banner and countdown, with free cells left
- enable mPOO checkout (`TOKEN_PAYMENTS_ENABLED`), handle `MpooDailyCapReached` by offering NEAR
- a public "where the money goes" panel from `get_revenue_state`

The `mount-wall.ts` split is recommended **before** this frontend work. See the backlog row F1-REFACTOR.

## Decisions needed before implementation

1. **Remove `withdraw_near`?** Recommended: yes. Every NEAR leaving the board then follows the 10/90
   split, which is the promise to TOILET holders. The cost: no owner route to recover NEAR outside the
   split. The upgrade path stays as the last resort.
2. **Which accounts** are `team_account` and `buyback_account` on testnet and on mainnet? The buyback
   account should be a dedicated account, not the owner's main one, so its swaps are easy to audit.
3. **mPOO daily cap at launch**, in credits. Suggestion: 4,000 credits a day (10 NEAR worth at 0.0025),
   raised once real volumes are known.
4. **Distribution interval.** Default 1 hour. Shorter means smaller, steadier buybacks.

## Definition of done

Per `AGENT.md`: `cargo test` for `paid-board` with a named failing-then-passing test for each item
above; `npm test` and `npm run build` for the shared palette change; the testnet rehearsal with chain
evidence (code hashes, transaction hashes, before/after reads); a `## Learned` line in the PR; the
backlog updated in the same PR.
