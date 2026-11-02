# 2 November — TOILET round, board side (TR-B)

Spec: [`../economy/2026-11-02-toilet-round-spec.md`](../economy/2026-11-02-toilet-round-spec.md) §B, owner
decisions T1–T4. Work order: [`../implementation/toilet-round-board.task.json`](../implementation/toilet-round-board.task.json).
Stacked on REV-G (`claude/upbeat-cerf-vm5j6q-rev-g`). Local `cargo test` only: nothing was deployed and no
chain was read or written.

## What changed

- **B1 earning tiles.** `Holder` gained `earning`, the board gained `total_earning`. Accrual
  (`emission_at`, `settled_holder`, the debt checkpoint) uses them; `cells` / `total_cells` /
  `get_cells_owned` keep meaning ownership. The paint path reads, per distinct cell and before any
  write, the previous owner and whether the cell was earning (painted and not in `free_cells`), then
  after the writes whether it is earning now. Per-account deltas are summed for the stroke and applied
  once per account, settling first.
- **B2.** `max_earning_cells` deleted from `Tunables`, its default and the tunables event list.
  `quota_*` untouched.
- **B3.** `set_toilet_rate(per_cell_second)`; `set_tunables` refuses a changed rate with `RateViaSetter`.
  `last_toilet_rate_change_ns` and `last_nonzero_toilet_rate` are stored and returned by
  `get_toilet_emission`.
- **B4.** `new(…, toilet)` stores the token; `claim_toilet()` and `set_toilet_paused(paused)` use it.
- **B5.** `MIN_CLAIM = 10^18` (1 TOILET), `ClaimBelowMinimum`. A zero claim still says `NothingToClaim`.

## Tests that failed before the change

Run against the REV-G head (`21008a2`) with only the tests added:

| test | failure before |
|---|---|
| `free_paint_earns_nothing` | `get_pending_toilet` for a free first paint was `U128(70)`, expected `U128(0)` |
| `repainting_a_free_cell_with_credits_starts_earning` | the free cell's previous owner had `U128(70)` from the free interval, expected `U128(0)` |
| `set_tunables_refuses_a_rate_change` | `set_tunables` accepted the new rate: `must reject: ()` |

The others (`rate_step_is_bounded_and_cooled_down`, `rate_can_drop_to_zero_any_time`,
`switch_on_after_zero_is_bounded_by_the_last_rate`, `rate_change_accrues_the_old_rate_first`,
`claim_uses_the_stored_token`, `claim_below_minimum_is_refused`, `free_cells_never_reserve_against_the_cap`,
`get_tunables_has_no_earning_cap`) call methods or signatures that did not exist before, so before the
change they fail to compile rather than fail.

## Boundaries pinned

- Rate steps: exactly ×2 and exactly ÷2 pass, one atomic unit beyond either fails
  `ToiletRateStepTooLarge`. Cooldown: `24 h − 1 s` fails `ToiletRateCooldown`, `24 h` passes.
- 0 at any time, twice in a row too; a stop keeps `last_toilet_rate_change_ns` and
  `last_nonzero_toilet_rate`.
- Claims: `MIN_CLAIM − 10^17` refused with no receipt and the pending amount intact; exactly `MIN_CLAIM`
  mints.
- Free cells: 25 free tiles held at `MAX_RATE` for 10,000 s reserve nothing (`accrued_total = 0`,
  `remaining = CAP`).
- Same-artist free → paid starts earning; free happy-hour repaint of a paid cell stops earning, for
  another artist and the same artist (`f2_a_free_repaint_of_a_paid_cell_stops_its_earning`).

## Decisions made here, for review

- **The 24 h cooldown also applies to a switch-on after a stop** (not to the first switch-on ever).
  The spec lists the switch-on bound and the cooldown in separate bullets. Without the cooldown on a
  switch-on, stop → 2× → stop → 2× compounds without limit in one block, which defeats T2. Only 0 is
  "at any time". If the owner wants switch-on exempt, it is one condition in `set_toilet_rate`.
- **`Holder` stays decodable from version 1.** `earning` is the last Borsh field and a 36-byte v1
  record decodes as `earning = cells`, exact for v1, which had no free paints; `from_v1` sets
  `total_earning = total_cells`. The spec needs no backwards compatibility, but a plain layout change
  would have left `migrate` accepting a v1 board whose holder reads then panic: the "redeploy bricked a
  board" trap. `migrate` gained a `toilet` argument because the board now stores the token.
- **The state version stays 2** although the board struct grew. Upgrading a board already running
  version-2 code to this code fails in `migrate` ("already version 2") and the deploy rolls back with
  it, so it cannot corrupt state; it simply is not possible. Fresh init only, as the spec says.

## What this does not prove

No chain evidence: this is unit tests over the mocked runtime. The token's `mint` and `set_paused`
receipts, the gas of a 64-cell stroke with the extra `free_cells` reads, and the web client's
`claim_toilet` call (it still sends a `toilet` argument; a no-argument near-sdk method should not parse its input, but that is unverified on chain) need the
fresh testnet rehearsal.
