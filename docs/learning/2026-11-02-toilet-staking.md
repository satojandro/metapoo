# 2026-11-02 — TOILET staking contract (TR-S)

Work order [`toilet-staking`](../implementation/toilet-staking.task.json), spec
[§S](../economy/2026-11-02-toilet-round-spec.md). New crate `contracts/toilet-staking`; keeper flag
in `ops/keeper`. Nothing deployed.

## Learned

**A balance-based inflow count races everything else that moves the balance.** The board pays with a
plain `ft_transfer`, so the contract finds new mPOO by reading its own balance (`sync_inflow`). The
read and its callback are separate receipts, and three things can land in between: a payout confirmed
(the stale balance still holds it, so it looks like inflow), a newer sync's inflow (the stale balance
lacks it, so it looks like a loss), and an `ft_transfer_call` that credited us and will be refunded
(it looks like inflow and then leaves). The fix is to carry cumulative inflow/outflow counters with the
read and act only outside the range the in-between movements allow; a later read takes back a
refunded transient before most of it has dripped out. The spec's "fund adds the amount directly" would
count a funded transfer twice if a sync saw it first, so the fund handler triggers a balance read
instead. Mutation check: removing either counter fails `sync_and_payout_race_does_not_double_count`.

**MasterChef rounding can over-pay by a unit per settlement.** With a rounded `debt`, a staker's claim
is a difference of two floors, which can exceed the exact share. Storing the accumulator snapshot (not
the rounded debt) and charging the pool the **ceiling** of what an increment could pay keeps the sum
of all claims inside what left the pool over any number of releases.

**Boundaries.** No owner, upgrade, pause or admin method (T9). The contract can't patch itself, can't
be paused, can't sweep stray tokens (TOILET sent with a plain transfer is locked for good, which is
effectively a burn), and can't forfeit a stake (`storage_unregister` refuses even with `force`).
Inflow above 1 billion mPOO is never counted. A release smaller than `total_staked / 10^11` units
releases nothing and waits in the pool. The board can be pointed here once, ever.

## Evidence

All from `contracts/toilet-staking` on `claude/upbeat-cerf-vm5j6q-tr-s`, Rust 1.97.0, near-sdk 5.29.1.

| command | result |
|---|---|
| `cargo test --locked` | 28 passed (5 math, 23 contract) |
| `cargo clippy --locked --all-targets -- -D warnings` | clean |
| `cargo build --locked --release --target wasm32-unknown-unknown` | passed |
| `sim/`: `cargo test --locked` | 1 passed, in a real local sandbox (neard 2.14.0) |

The simulation ran the real `paid-board` and `toilet` wasm: buyback → `distribute_mpoo` (100 / 200 /
700) → `sync_inflow` → time → two claims → two full unstakes, with every amount asserted exactly from
chain timestamps and the books balanced at the end. Sandbox gas burnt: `distribute_mpoo` 17 Tgas,
`sync_inflow` 6, `claim_rewards` 6, `unstake` 11.

In this session's container the sandbox only started with a local `LD_PRELOAD` shim that clamps
neard's `setrlimit(NOFILE, 65535)` to the container's hard limit of 20,000; the chain itself was real.
GitHub's hosted runners allow the raise, so CI needs no shim.

What this does not prove: behaviour against the real mPOO contract (NEARLY's token, not in this
repo; a zero-tax TOILET instance stood in), testnet gas, and the deployed account's keys. The
testnet rehearsal and the external review are still open, and both come before any
`set_staking_contract`.
