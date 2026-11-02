# TOILET round — spec for review

Date: 2 November 2026. Status: **owner decisions recorded 2 Nov; nothing here is implemented.**
Contract changes and deployments are ask-first (`AGENT.md`). This document asks for one approval: build
the three pieces below, test them, and rehearse them together on a fresh testnet board.

Inputs: [TOILET economy v1](2026-10-28-toilet-economy-v1.md) (the reasoning; this spec settles its open
decisions), [code audit](../2026-10-29-code-audit.md) C3, C4, C6 and §1b,
[paid board revision spec](../payments/2026-11-01-paid-board-revision-spec.md) R2 (the stakers' reserve),
and the draft public page [`../visual-concepts/toilet-draft.html`](../visual-concepts/toilet-draft.html),
whose review layer lists every claim against the code.

Baseline: `main` = `d282ff8`. Backwards compatibility: none needed. The owner confirmed on 2 Nov that a
fresh testnet board can be deployed at any time and mainnet is a fresh deploy, so layout changes are
fresh-init only.

## Owner decisions, 2 November

| id | decision |
|---|---|
| T1 | Emission stays a **fixed rate per earning tile per second**. It is not keyed to revenue. |
| T2 | The rate gets the same **safeguards as prices**: bounded steps, a cooldown, a public event. The owner does not expect to change it. |
| T3 | **No earning cap.** Every earning tile earns. The whale risk is accepted: the community is the defence, and the fight is revenue. |
| T4 | **Free tiles earn nothing** until repainted with credits. Their share is not minted and not burned. |
| T5 | A **staking contract** holds the stakers' mPOO and pays out **at most 10% of its pool per day**. The board is unchanged. |
| T6 | **TOILET is for staking.** It will not be spendable on paint. |
| T7 | Unstaking pays a **10% exit tax, burned**, on each unstaked amount only. A partial withdrawal is taxed on what comes out. |
| T8 | An **exchange tax** on TOILET is a nice-to-have, matching mPOO's 2% buy and 3% sell. |

Still open, and not blocking the build: the launch emission rate (T1), whether the daily paint allowance
(`quota_*`) is still wanted now repaint pricing exists, the minimum claim size (B5), whether the staking
contract has any owner at all (S8), and the exchange-tax split and treasury account (X1).

## What the drip does, in plain numbers

The 10% daily release smooths payouts. It does not grow them. If the pool receives `I` mPOO a day, it
settles where 10% of the pool equals `I`, so it holds about **ten days of inflow** and pays out `I` a day.
What stakers gain is a steady payout, a visible and growing pool when the wall is busy, and no single
large buyback landing all at once. Any public copy should describe it that way and not as a multiplier.

## B — board changes (`contracts/paid-board`)

### B1. Only credit-painted tiles earn (T4)

Today `bump_cells_owned` counts every held cell in `holders[account].cells` and in `total_cells`, and
accrual uses those counts. `free_cells` records which cells' latest paint was free, but accrual ignores it.

- Add `earning: u32` to `Holder` and `total_earning: u32` to the board. Accrual (`emission_at`,
  `settled_holder`, `entitlement`) uses `earning` and `total_earning` in place of `cells` and `total_cells`.
- Keep `cells` and `total_cells` as the ownership counts. `get_cells_owned` and anything that reads
  ownership keep their meaning.
- A cell is **earning** when it holds paint and its latest paint was paid with credits (it is not in
  `free_cells`). On each cell in a stroke, compare the cell before and after:
  `was = previous paint exists and was not free`, `now = this paint is not free`.
  Settle both parties first, then move `was` off the previous owner and `now` onto the artist. This applies
  even when the artist is the previous owner, because a same-artist repaint can change a free cell into
  an earning one.
- Nothing is burned for free cells. Reservation happens at accrual against earning tiles only, so a free
  tile's share is never reserved and stays in the unissued part of the cap.

### B2. Delete the earning cap (T3, audit C3)

Remove `max_earning_cells` from `Tunables`, its default and its validation. `get_tunables` must stop
advertising a limit nothing enforces. Leave `quota_*` alone until the owner decides whether the daily
allowance is still wanted; this task does not enforce or delete it.

### B3. A guarded emission-rate setter (T2)

- Move `toilet_per_cell_second` out of `set_tunables`. `set_tunables` refuses a changed value with
  `RateViaSetter`, the same pattern as the price history fields.
- New `set_toilet_rate(per_cell_second: U128)`, payable, 1 yocto, owner only:
  - `accrue(now)` first, so the old rate applies up to now and never retroactively.
  - Setting **0** is allowed at any time: it is the emergency stop.
  - From 0, the first switch-on may be any value up to `MAX_RATE`. A later switch-on from 0 may be at
    most 2× the last non-zero rate.
  - Otherwise the new rate must be within ×2 and ÷2 of the current rate, and 24 hours must have passed
    since the last non-zero change (`TOILET_RATE_COOLDOWN_NS`, a constant, not a tunable).
  - Emit `toilet_rate_changed {old, new, changed_at_ns}` through the safety event.
- Store `last_toilet_rate_change_ns` and `last_nonzero_toilet_rate` on the board and expose them in
  `get_toilet_emission`.

### B4. Store the TOILET token id (audit C4)

`new` takes `toilet: AccountId` and stores it. `claim_toilet()` takes no argument and mints on the stored
token. `set_toilet_paused` uses the stored token too. `get_toilet_emission` returns it.

### B5. Minimum claim (audit C6)

`claim_toilet` refuses `pending < MIN_CLAIM` with `ClaimBelowMinimum`. This stops dust claims from
draining the token's auto-registration balance. Proposed `MIN_CLAIM = 1 TOILET` (10^18 atomic units),
as a constant; the owner confirms the value.

### B tests (name each; the first three must fail before the change)

- `free_paint_earns_nothing`
- `repainting_a_free_cell_with_credits_starts_earning`, including the same-artist case
- `set_tunables_refuses_a_rate_change`
- `rate_step_is_bounded_and_cooled_down`, `rate_can_drop_to_zero_any_time`,
  `switch_on_after_zero_is_bounded_by_the_last_rate`
- `rate_change_accrues_the_old_rate_first`
- `claim_uses_the_stored_token`, `claim_below_minimum_is_refused`
- `free_cells_never_reserve_against_the_cap` (accrue with only free tiles held; `accrued_total` stays 0)
- `get_tunables_has_no_earning_cap`

## S — staking contract (`contracts/toilet-staking`, new crate)

### S1. What it holds

- **Stakes:** TOILET per account, `total_staked`.
- **Pool:** mPOO waiting to be released. Released mPOO becomes claimable rewards through a MasterChef
  accumulator over stake, the same pattern as `emission.rs`: `acc_per_share` (scaled; derive the scale
  from the largest possible values and assert it at compile time, as the board does), and per-account
  `debt` and `pending`.
- **Config, fixed at `new`:** the TOILET token, the mPOO token, the board account (for inflow attribution
  in events only). Constants: `DRIP_BPS = 1_000` (10% per day), `EXIT_TAX_BPS = 1_000`, `DAY_NS`.

### S2. Release: at most 10% of the pool per day (T5)

`release(now)` runs first in every state-changing call.

- If `total_staked == 0`, advance the clock and release nothing. The pool waits for stakers.
- Otherwise, with `elapsed = now - last_release_ns`: for each whole day (loop bounded at 365), release
  `pool / 10`; for the remaining part of a day, release `pool × rest / (10 × DAY_NS)`. Subtract each
  release from `pool` before the next step. Add the total to `acc_per_share` and `released_total`.
- Invariant: over any interval the release never exceeds what a continuous 10%-per-day drip of the
  starting pool would release. Rounding dust stays in the pool.

### S3. How mPOO arrives (the board is unchanged)

The board's `distribute_mpoo` forwards the stakers' share with a **plain `ft_transfer`**
(`revenue.rs`, `send_mpoo_leg`). There is no `ft_on_transfer` notification, so the contract can't learn of
it by callback. Two paths:

- `sync_inflow()`, permissionless: query `mpoo.ft_balance_of(self)` and, in the callback, add
  `balance - accounted` to the pool when positive. `accounted` is the pool plus all unclaimed rewards plus
  payouts in flight. In-flight payouts leave `accounted` only when their transfer is confirmed. Design and
  test the race where a payout and a sync overlap.
- `ft_on_transfer` from the mPOO token with `msg = "fund"` adds the amount to the pool directly. Anyone
  may fund the pool this way.

The revenue keeper (`ops/keeper`) calls `sync_inflow()` after each `distribute_mpoo`. That is a keeper
change, not a board change.

Before the owner calls `set_staking_contract`, this contract must be registered for storage on mPOO, or
the board's transfer fails and is restored to the reserve, which is safe but wastes the call.

### S4. Stake

`ft_on_transfer` from the TOILET token with `msg = "stake"`: `release`, settle the sender, add to their
stake and `total_staked`, reset their debt. Any other sender token or message is refused (return the full
amount). Stakers register with NEP-145 `storage_deposit` first; staking without storage is refused.

### S5. Unstake and the exit tax (T7)

`unstake(amount)`, 1 yocto:

1. `release`, settle rewards (they stay in `pending`, unaffected by the tax), then subtract `amount`
   from the stake and `total_staked`.
2. `tax = amount × EXIT_TAX_BPS / 10_000`, rounded down; `net = amount - tax`.
3. Transfer `net` TOILET to the account. On success, burn `tax` by calling the TOILET token's `burn` on
   the contract's own balance. On a failed transfer, restore the **full** `amount` to the stake and burn
   nothing, so a failed exit costs nothing.
4. A failed burn adds `tax` to `burn_pending`. A permissionless `flush_burn()` retries it.
5. Events: `unstaked {account_id, amount, net, tax_burned}`.

The tax applies to each unstake, on that amount only (owner, 2 Nov). Stake and unstake cycles therefore
burn 10% every round, which is what the owner wants. Note it in the docs so nobody reads a spike in burns
as an attack.

### S6. Claim rewards

`claim_rewards()`, 1 yocto: `release`, settle, transfer `pending` mPOO, zero it. A failed transfer
restores `pending`. Rewards can be claimed without unstaking, and unstaking doesn't claim.

### S7. Views and events

`get_pool() -> {pool, released_total, total_staked, last_release_ns, burn_pending, burned_total}`,
`get_staker(account) -> {staked, pending_rewards}` (including release up to now, without mutating),
`get_config()`. Events: `staked`, `unstaked`, `rewards_claimed`, `pool_funded`, `inflow_synced`,
`tax_burned`.

### S8. Ownership: decide before building

The board can point at a staking contract **once, ever** (`set_staking_contract`). So this contract must
be right before that call, and it can't be swapped later.

- **Proposed: no owner, no upgrade, no pause**, like the TOILET token (D4). Every parameter is a constant
  or set at `new`. The cost: a bug can't be patched, only routed around by a new board.
- The alternative is an owner who can pause staking and claims but can't move funds. The cost: an owner
  key that every staker has to trust.

Either way, the work order ends at testnet. The owner calls `set_staking_contract` on mainnet only after an
external review.

### S tests

- `release_is_ten_percent_per_whole_day`, `partial_day_releases_proportionally`,
  `nothing_releases_with_no_stakers`, `release_never_exceeds_the_pool`
- `rewards_split_pro_rata_by_stake`, `late_staker_gets_nothing_released_before_they_staked`
- `sync_inflow_adds_only_new_mpoo`, `sync_and_payout_race_does_not_double_count`
- `fund_message_adds_to_the_pool`, `stake_from_the_wrong_token_is_refused`
- `unstake_burns_ten_percent_of_the_amount`, `partial_unstake_taxes_only_what_comes_out`
- `failed_unstake_transfer_restores_the_full_stake_and_burns_nothing`
- `failed_burn_goes_to_burn_pending_and_flushes`
- `claim_without_unstake`, `failed_claim_restores_pending`
- Workspace simulation: board `distribute_mpoo` → `sync_inflow` → time passes → two stakers claim, with the
  exact amounts asserted.

## X — TOILET exchange tax (nice-to-have, T8)

The token already supports a venue tax fixed at `new` (`buy_bps`, `sell_bps`, `exchange`, `burn_bps`,
`treasury_bps`, `treasury`, `exempt`). Nothing changes in code. Before deploy:

- **X1.** Owner chooses the split between burn and treasury and the treasury account. Proposed
  `buy_bps = 200`, `sell_bps = 300` to match mPOO.
- **X2.** Prove the tax against a real pool on testnet: a fee-on-transfer token can be mis-accounted by an
  AMM (economy doc §14). If no testnet venue exists, deploy with the tax at 0 rather than ship an unproven
  setting that can never be changed.
- **X3.** Exempt the staking contract only if it ever trades through the exchange; it shouldn't.

## F — frontend (Claude, for consistency)

- **F1.** `/how-it-works`, from [`../visual-concepts/how-it-works-draft.html`](../visual-concepts/how-it-works-draft.html).
  Not blocked; reads live values the way `/money` does.
- **F2.** `/toilet`, from [`../visual-concepts/toilet-draft.html`](../visual-concepts/toilet-draft.html), with
  the review layer removed. Blocked on B and S being on a testnet board.
- **F3.** Claim and staking UI in the wallet panel. Blocked on B and S.

## Order and gates

1. Owner decides S8 (and, when convenient, the open items above).
2. B and S in parallel. They meet only through `distribute_mpoo` → `ft_transfer` → `sync_inflow`.
3. Fresh testnet board plus token plus staking contract; rehearse the whole loop with chain evidence.
4. External review of the staking contract before `set_staking_contract` anywhere it matters.
5. F2 and F3 against the rehearsed testnet deployment.

Work orders: [`toilet-round-board`](../implementation/toilet-round-board.task.json),
[`toilet-staking`](../implementation/toilet-staking.task.json),
[`toilet-exchange-tax`](../implementation/toilet-exchange-tax.task.json),
[`fe-how-it-works`](../implementation/fe-how-it-works.task.json),
[`fe-toilet-page`](../implementation/fe-toilet-page.task.json).
