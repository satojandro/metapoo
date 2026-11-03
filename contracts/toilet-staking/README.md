# TOILET staking

Work order TR-S ([`toilet-staking.task.json`](../../docs/implementation/toilet-staking.task.json)).
Spec: [TOILET round](../../docs/economy/2026-11-02-toilet-round-spec.md) §S, owner decisions T5, T7, T9.

**Status: built and tested locally (unit tests and a sandbox simulation). Not deployed, not reviewed.**
Before any board points at it: a testnet rehearsal with chain evidence, then an external review.

Stakers lock TOILET. The contract holds a pool of mPOO, releases at most 10% of it per day to
stakers in proportion to their stake, and burns 10% of every amount unstaked.

## No owner, no upgrade (T9, S8)

There is no owner account, no upgrade method, no pause and no admin method of any kind. The three
accounts it needs (TOILET, mPOO, the board) are arguments to `new`, and `new` runs once. Every rate is
a compile-time constant. A bug can't be patched: the response to a bug is a new staking contract
and a new board. That is the accepted cost, so the review and the rehearsal carry the whole weight.

### The board points here once, ever

The board's `set_staking_contract` can be called **once**. After that every `distribute_mpoo`
forwards the stakers' 70% here, for the life of that board. Pointing a board at a broken or
mis-deployed staking contract can't be undone: the fix is a new board. So the owner calls it only
after the testnet rehearsal and the external review, and only after checking the full-access key is
gone (below).

## The drip, in plain numbers

**The 10% daily release smooths payouts. It does not grow them.** If the pool receives `I` mPOO a
day, it settles where 10% of the pool equals `I`: it holds about **ten days of inflow** and pays out
`I` a day. Stakers get a steady payout and a visible pool, and no single large buyback lands at once.
Describe it that way, never as a multiplier.

Worked example: the board forwards 700 mPOO once, and 400 TOILET are staked (Alice 100, Bob 300).

| after | released that day | pool left | Alice (¼) | Bob (¾) |
|---|---|---|---|---|
| day 1 | 70 | 630 | 17.5 | 52.5 |
| day 2 | 63 | 567 | 15.75 | 47.25 |
| day 3 | 56.7 | 510.3 | 14.175 | 42.525 |
| half a day more | 25.515 (510.3 × ½ ÷ 10) | 484.785 | 6.37875 | 19.13625 |

How a release is computed (`math::drip`), from the time since the last release:

- For each whole day (at most 365 in one release) take `pool / 10` and subtract it before the next day.
- For the rest of a day take `pool × rest / (10 × 86,400 s)`: linear within the day.
- Releases happen whenever anyone calls a state-changing method. Splitting an interval into many
  releases compounds on a smaller pool, so it releases slightly **less** than one release over the
  whole interval, never more. Counted from any release, the next day of releases takes at most 10% of
  the pool as it stood then (inflow aside).
- With nobody staked, the clock advances and nothing is released. The pool waits for stakers, and a
  staker earns only from releases after they staked.
- More than 365 days with no call at all: 0.9^365 ≈ 2·10⁻¹⁷ of the pool remains after the 365 days,
  and the extra time releases nothing more.

## The exit tax (T7)

`unstake(amount)` sends 90% of `amount` back and burns 10% by `ft_transfer` to the 64-zero burn
address (`0000…0000`), the burn route recorded on 2 Nov in the
[handover](../../docs/handover-2026-10-29.md). The tax is `floor(amount × 1,000 / 10,000)`; the net is
`amount − tax`, so the two always add up to `amount` exactly. 19 units unstaked: 1 burned, 18 returned.

- The tax applies to each unstake, on that amount only. Unstaking 300 of 1,000 burns 30 and leaves 700
  staked, untaxed until they come out.
- Stake and unstake cycles burn 10% every round, which is what the owner wants. **A spike in burns is
  not an attack.** It is someone cycling.
- Rewards are not taxed. Unstaking does not claim, and claiming does not unstake.
- A transfer to the burn address does not lower TOILET's `ft_total_supply` or its own `burned_total`.
  For the burn page, show this contract's `burned_total` and the burn address's TOILET balance.

## How mPOO arrives

The board pays with a **plain `ft_transfer`** (`contracts/paid-board/src/revenue.rs`,
`send_mpoo_leg`), so this contract gets no notification. Two paths in:

- **`sync_inflow()`**, open to anyone: reads `mpoo.ft_balance_of(this)` and, in the callback, adds
  `balance − accounted` to the pool when positive. `accounted = pool + rewards_owed`, where
  `rewards_owed` is everything released and not yet confirmed paid out (claimable, not yet settled,
  and payouts in flight). The revenue keeper calls it after each `distribute_mpoo` (`ops/keeper`,
  `KEEPER_STAKING_CONTRACT_ID`).
- **`ft_transfer_call` on mPOO with `msg = "fund"`**: anyone can fund the pool. The handler accepts the
  tokens, logs `pool_funded`, and counts them through the same balance read as `sync_inflow` (see
  "Races" for why it does not add the amount directly).

mPOO above 1 billion tokens (`MPOO_BOUND`, mPOO's supply is ~972 million) is never counted, so the
arithmetic bounds below always hold. Anything else sent here is refused and returned: TOILET with a
message other than `stake`, mPOO with a message other than `fund`, any other token.

### Races between a balance read and other calls

A balance read leaves in one receipt and comes back in another, and other calls can land in between.
The read carries the contract's cumulative inflow and outflow counters from when it left; the
callback treats any movement since then as possibly in the balance or not, and acts only outside that
range:

- **Above the range** (`balance > accounted + outflow since the read`): new mPOO; add it to the pool.
  A payout confirmed while the read was in flight is not mistaken for inflow.
- **Below the range** (`balance < accounted − payouts in flight − inflow since the read`): something
  counted earlier is gone. That happens only when a sync saw tokens that were then refunded (an
  `ft_transfer_call` whose notification we refused or that ran out of gas). The difference comes back
  out of the pool, before most of it has been released (at most 10% a day). An in-flight payout or a
  newer inflow is not mistaken for a loss.
- In between: nothing changes.

Tests: `sync_and_payout_race_does_not_double_count` (three orderings),
`a_refunded_transfer_seen_by_a_sync_is_taken_back_out`, `fund_message_adds_to_the_pool`.

## Rounding: nothing pays out more than the pool held

- Rewards use a MasterChef accumulator: `acc_per_share` grows by `release × ACC_SCALE / total_staked`
  (rounded down). `ACC_SCALE = 10^11` is derived from the two largest values multiplied by it (the
  mPOO bound and TOILET's 10^27 cap, `u128::MAX / 10^27 ≈ 3.4·10^11`) and asserted at compile time
  (`src/math.rs`).
- The pool is charged `ceil(inc × total_staked / ACC_SCALE)`, which is at most the release. Stakers
  claim `floor(stake × Δacc / ACC_SCALE)` each. Charging the ceiling is what keeps the sum of all
  claims inside what left the pool over any number of releases; the remainder of each release stays in
  the pool.
- Each staker stores the accumulator value at their last settlement (`snapshot`) instead of a rounded
  `debt`, so differences of rounded products can't over-pay.
- A release too small to move the accumulator (less than `total_staked / 10^11` units) releases
  nothing and stays in the pool. With all 10^27 TOILET staked that is 0.01 mPOO.
- Unit-test `many_stakers_never_claim_more_than_was_released` runs 400 random stakes, unstakes, claims
  (some failing) and inflows and checks after every step that claimable + in flight ≤ released and
  unpaid, and that nothing is promised that isn't held.

## Failure paths

| what fails | what happens |
|---|---|
| the net TOILET transfer of an unstake | the **full** amount goes back to the stake (it earned nothing while in flight), nothing is burned, `unstake_failed` |
| the burn transfer | the tax goes to `burn_pending`, `burn_failed`; anyone can call `flush_burn()` to retry |
| the mPOO transfer of a claim | `pending` is restored, `claim_failed`; the amount stays accounted, so a sync does not count it as inflow |
| the balance read of a sync | nothing changes, `inflow_sync_failed`; the next sync counts it |
| the board's transfer to us (not registered on mPOO) | the board restores its reserve (board callback); nothing here |
| the burn address not registered on TOILET | every burn fails into `burn_pending` until it is registered, then `flush_burn()` |

`claim_rewards`, `unstake`, `flush_burn` and `sync_inflow` refuse to start with too little prepaid
gas (50, 90, 50 and 40 Tgas), so a callback that restores value always has its gas. Sandbox gas burnt
(simulation): `distribute_mpoo` 17 Tgas, `sync_inflow` 6, `claim_rewards` 6, `unstake` 11 (with burn).

## Methods

| method | who | deposit | notes |
|---|---|---|---|
| `new(toilet, mpoo, board)` | once | – | `board` is for event attribution only |
| `ft_on_transfer` (`stake` / `fund`) | the TOILET / mPOO token | – | via `ft_transfer_call` |
| `unstake(amount)` | staker | 1 yocto | ≥ 90 Tgas |
| `claim_rewards()` | staker | 1 yocto | ≥ 50 Tgas |
| `sync_inflow()` | anyone | – | ≥ 40 Tgas |
| `flush_burn()` | anyone | – | ≥ 50 Tgas, `NothingToBurn` if empty |
| `storage_deposit(account_id?, registration_only?)` | anyone | ≥ min | NEP-145; min = max = 0.00161 NEAR (161 bytes); excess and duplicates refunded |
| `storage_withdraw(amount?)` | registered | 1 yocto | nothing is ever available |
| `storage_unregister(force?)` | registered | 1 yocto | refuses while stake, rewards or a transfer is pending, **even with `force`**: no path forfeits a stake |
| `get_pool()` | view | – | `{pool, released_total, total_staked, last_release_ns, burn_pending, burned_total}` (persisted, not advanced to now) |
| `get_staker(account_id)` | view | – | `{registered, staked, pending_rewards}`, rewards including release up to now |
| `get_accounting()` | view | – | the whole ledger: rewards owed, in flight, accounted, inflow and fund totals |
| `get_config()` | view | – | tokens, board, burn address, constants, storage minimum |

Events (`EVENT_JSON`, standard `toilet_staking`): `staked`, `unstaked {account_id, amount, net,
tax_burned}`, `rewards_claimed`, `pool_funded`, `inflow_synced`, `tax_burned`, and the failure events
`unstake_failed`, `claim_failed`, `burn_failed`, `inflow_sync_failed`.

## Deploy procedure

Testnet first. Each step's transaction hash goes into the deployment record.

1. Create the contract account and deploy the release wasm.
2. `new(toilet, mpoo, board)`.
3. Register storage: this contract on **mPOO** (or the board's transfer fails and is restored to its
   reserve, safe but wasted) and on **TOILET** (to receive stakes); the **burn address** on **TOILET**
   (before the first unstake). The board already needs the burn address on mPOO.
4. **Delete the full-access key** from the contract account and record the transaction. Without this,
   "no upgrade" is only true until someone redeploys over it. Check with
   `near account list-keys <account> network-config <network> now`: no keys at all.
5. Give the keeper a second function-call key for `sync_inflow` on this contract
   (`ops/keeper/README.md`, "Staking sync"), set `KEEPER_STAKING_CONTRACT_ID`.
6. Only after the rehearsal and the external review: the owner calls `set_staking_contract` on the
   board. This work order never does.

## Verification

```sh
cd contracts/toilet-staking
cargo test --locked                       # unit tests, mocked runtime
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release --target wasm32-unknown-unknown

cd sim && cargo test --locked -- --nocapture   # sandbox: real board + token wasm
```

The simulation builds `contracts/toilet`, `contracts/paid-board` and this crate to wasm, starts a
local sandbox, and runs: buyback returns 1,000 mPOO to the board → `distribute_mpoo` (100 team / 200
burn / 700 here) → `sync_inflow` → time passes → Alice and Bob claim → both unstake everything. Every
amount is asserted exactly from the chain's timestamps: claims, pending rewards, the pool, TOILET
returned (90 and 270), burned (40) and the books (`accounted` equals the balance held). mPOO's wasm is
not in this repository, so a second TOILET-wasm instance with zero tax stands in for it.
`set_staking_contract` is called there, on a throwaway sandbox board.

neard raises its open-file limit to 65,535 at start. Where the hard limit is lower (some containers),
it fails with "couldn't set the file descriptor limit"; GitHub's hosted runners allow it.

What this does not prove: behaviour against the real mPOO contract (its tax and storage rules), gas
on testnet, and anything about the deployed account's keys. Those are the rehearsal's job.
