# Paid board: payment integration stage

Schema **4** — this is the product board, ratified 2026-10-28
([decision record](../../docs/payments/2026-10-28-paid-model-decisions.md)).
`contracts/board` (free schema 2) is retired as a product and kept as the testnet fixture.
Fresh account initialization only: this is not a migration of an existing board, and the
testnet mural does not carry over. Launch price: 0.0025 NEAR per credit.

**Deployed on testnet** at `board3.metapoo-player1.testnet` (2026-10-29,
[deployment record](../../docs/payments/testnet-deployment-2026-10.md)). The page buys credits
with NEAR, shows the repaint price, and paints. A recorded end-to-end journey, with receipts, is
still open (`PAY-INTEGRATION` in the backlog).

## Release follow-ups

- **No mainnet deployment yet.** Immediately after deploying, reopen backlog
  **PAY-COST** and complete [mainnet cost validation](../../docs/payments/mainnet-cost-validation.md)
  before general paid launch. Every measurement is still pending.
- [Accepted frontend requirements](../../docs/payments/frontend-handoff.md): credits,
  repaint prices and NEAR checkout are built; the mPOO purchase path is in the contract but
  hidden in the UI (`TOKEN_PAYMENTS_ENABLED=false`).
- [Upgrade policy proposal](../../docs/payments/upgrade-policy.md): the board keeps an
  owner-only `upgrade()` so a bug in credit or pixel custody stays repairable; TOILET
  deliberately exposes no upgrade entrypoint (D4). State version 2 and the v1 → v2 `migrate`
  exist (REV-A, `src/migrate.rs`, tested against real v1 state in `fixtures/state_v1.json`); the
  testnet rehearsal is still pending.

## Product rules

Credits never expire and cannot be transferred, redeemed or withdrawn. A batch
charges per entry (including repeated coordinates), using the 1/2/4-credit
recency tiers described below; one credit is the default empty/old-cell cost.
Invalid coordinates/colors and insufficient balances reject the entire stroke.
Native NEAR and direct mPOO purchases are supported without a swap.

The fixed launch price is **0.0025 NEAR per pixel** (2,500,000,000,000,000,000,000
 yoctoNEAR). Ten credits cost 0.025 NEAR; 100 cost 0.25 NEAR, excluding separate
registration and gas. This is a NEAR-denominated price, not a USD peg. At an example
NEAR price of $4.35, it is about $0.03 (three cents), not 0.03 cents.

Initialization automatically uses this NEAR price and requires a nonzero mPOO
price in atomic units. Owner price updates remain available as previously agreed;
there is no automatic repricing. Test prices 10 and 100 are arithmetic fixtures,
not economically valid launch prices. `set_near_price` and `set_mpoo_price` change
one price each, with exactly 1 yoctoNEAR attached. Existing credits are unaffected. Buyers submit
`expected_price` and `min_credits`; stale prices reject/refund.

## Safety controls (local, 2026-10-28)

- Owner-only `set_paused(paused)`, with 1 yoctoNEAR, stops `draw`, `draw_many`, and
  native purchases with `Paused`. Authenticated FT purchases return the full unused
  amount for refund. Views, upgrades and both distributions remain available.
  `get_tunables().paused` exposes the state.
- Owner-only `set_toilet_paused(paused)` requires exactly 1 yoctoNEAR
  and returns a promise calling `set_paused` with 1 yoctoNEAR and 10 Tgas on the
  TOILET token stored at `new` (TR-B §B4; the caller no longer names the token). The
  board must be that token's current emitter. This makes TOILET's
  emitter-only circuit breaker reachable without adding a token owner; it works
  even while painting is paused. Follow the returned receipt to confirm success:
  scheduling does not prove the token paused. Emitter handoff passthroughs remain outside this task.
- `set_near_price(near_per_credit)` and `set_mpoo_price(mpoo_per_credit)` (REV-B, C8)
  each move one price between half and double its prior value (odd-number halving
  rounds up; `PriceStepTooLarge`, `ZeroPrice`). Each has its own cooldown, at least
  24 hours: `near_price_cooldown_ns` / `last_near_price_change_ns` and
  `mpoo_price_cooldown_ns` / `last_mpoo_price_change_ns`. Early changes fail
  `NearPriceCooldown` / `MpooPriceCooldown`; changing one never starts the other's
  clock. The first change of each is allowed immediately; a no-op update still
  restarts its cooldown. `price_changed` carries `asset` (`near` | `mpoo`),
  `old_<asset>_per_credit`, `new_<asset>_per_credit` and `changed_at_ns`.
- Repaint tunables (C1): each tier 1..=8 credits (`RepaintCreditsOutOfRange`),
  base <= mid <= young (`RepaintCreditsOutOfOrder`), young window <= mid window
  (`RepaintTiersOutOfOrder`) <= 24 h (`RepaintWindowTooLong`). Changing any repaint
  credit value in `set_tunables` is a NEAR price change: it fails
  `RepaintPriceCooldown` inside the NEAR cooldown and restarts it.
  `max_outstanding_credits` cannot go below current outstanding unless 0
  (`FloatCapBelowOutstanding`).
- mPOO daily cap (C8): `mpoo_daily_credit_cap` credits per UTC day
  (`floor(block_timestamp / 86,400 s)`), bound 1,000,000 (`MpooDailyCapTooHigh`), set
  through `set_tunables` with immediate effect. 0 (the deploy default) closes mPOO
  sales. A purchase that is refused refunds the whole transfer and logs
  `purchase_rejected: MpooSalesClosed` or `purchase_rejected: MpooDailyCapReached`.
  NEAR purchases do not count against it. `get_mpoo_sales_today()` returns
  `{day_index, sold_today, cap, remaining, resets_at_ns}` for the current block day.
- `get_withdrawable_near()` returns the NEAR above the protected reserve, as a decimal
  string: account balance minus current storage stake, minus empty cells
  (16,384 − painted) × `STORAGE_PER_PIXEL` (664,000,000,000,000,000,000 yoctoNEAR until
  REV-E measures it), minus the reserve floor (spec C5). Outstanding credits no longer
  reserve storage. Underfunding or arithmetic overflow returns zero.
- `withdraw_near` is **removed** (owner, 1 Nov 2026). Revenue leaves only through the
  split below.

## Revenue split (spec R1, R2)

- `distribute_near()` — anyone, at most once per `distribution_interval_ns` (default 1 h,
  else `DistributionTooSoon`). Sends `get_withdrawable_near()` as native transfers: 10% to
  `team_account`, 90% plus rounding dust to `buyback_account`. `NothingToDistribute` if
  zero. A failed transfer refunds itself to the board, so the callback
  `on_near_distributed` logs `near_distribution_leg_sent` / `_failed`; the next call
  sends the refund again. On a confirmed buyback leg the callback also adds it to
  `total_near_to_buyback` (below).
- `ft_on_transfer` with msg `{"revenue":{}}` from `buyback_account` adds to
  `mpoo_undistributed` (accepted even while paused); from anyone else it is refunded.
  Every successful mPOO credit purchase also adds its amount.
- `distribute_mpoo()` — anyone, same interval on its own clock. Splits
  `mpoo_undistributed`: 10% `ft_transfer` to `team_account`, 20% `ft_transfer` to the burn
  address `0000…0000` (64 zeros), 70% plus dust into `mpoo_staker_reserve`. Once
  `staking_contract` is set, the whole reserve is forwarded with each call. Each leg:
  1 yocto, 15 Tgas, plus a 10 Tgas `on_mpoo_distributed` callback that restores a failed
  team/burn leg to `mpoo_undistributed` and a failed staker forward to the reserve.
  Attach ≥ 100 Tgas. Team, burn address and staking contract must be storage-registered
  on the mPOO contract.
- `set_team_account` / `set_buyback_account(account_id)` — owner, 1 yocto, separate 7-day
  cooldowns (`RevenueAccountCooldown`; first change allowed), not the board itself
  (`InvalidRevenueAccount`), event `revenue_account_changed`.
- `set_staking_contract(account_id)` — owner, 1 yocto, once (`StakingContractAlreadySet`).
- `get_revenue_state()` — withdrawable NEAR, undistributed mPOO, staker reserve, next
  distribution times (U64 strings, 0 = now), accounts and burn address.
- `get_buyback_totals()` — `{"near_to_buyback": "<yoctoNEAR>", "mpoo_returned": "<mPOO base
  units>"}`, decimal strings, cumulative since `new` (owner, 3 Nov). Both start at 0.
  - `near_to_buyback` counts only NEAR that **reached** `buyback_account`: it is added in
    `on_near_distributed` when the buyback leg's transfer succeeded, not when
    `near_distributed` is logged. A failed leg is refunded and resent by a later call, and
    counts once, when that send is confirmed. The leg's role travels in the callback
    (`to_buyback`), so a team account equal to the buyback account is not counted.
  - `mpoo_returned` counts the mPOO accepted from `buyback_account` with `{"revenue":{}}`:
    the same amounts as the `mpoo_revenue_received` events. Refused revenue messages and
    credit purchases paid in mPOO are not counted.
  - NEAR waiting on the buyback account is not on the board; read that account's balance.

- Reserve floor defaults to **5 NEAR** and cannot be configured below it. Cooldown
  cannot be configured below 24 hours, and `last_price_change_ns` cannot be rewritten
  through `set_tunables`. Its initial value is null, including at timestamp zero.
  `reserve_floor` uses a JSON decimal string. Outstanding-credit additions and
  deductions are checked so overflow cannot silently distort the reserve obligation.

The pixel storage estimate comes from the recorded free-board measurement in
[paid-model decisions §2](../../docs/payments/2026-10-28-paid-model-decisions.md):
152,724 bytes / 2,301 painted cells ≈ 66.4 bytes at 10^19 yoctoNEAR/byte. It is not
a paid-board benchmark or a guarantee of solvency; PAY-COST must measure the new
layout and the operations reserve before launch. mPOO withdrawal is not included.

**State-layout correction to the brief:** the four safety fields did not exist in
the source revision's `Tunables`. Adding them changes Borsh serialization, even
though no direct `Board` or `Payments` fields were added. This build is for fresh
initialization; it is **not a migration-free upgrade** of an already initialized
older schema-4 board. An explicit migration and rehearsal are still required.

For automatic dollar pricing, add a trusted quote publisher or oracle with expiry,
confidence bounds and deviation limits. A thin mPOO pool's spot price is not a
robust oracle. Determine conservative mPOO rates using realizable sale proceeds,
including liquidity, slippage and tax, not nominal market capitalization.

## Calls

- `new(mpoo_token, mpoo_per_credit, team_account, buyback_account, toilet)`: initializer becomes
  pricing owner; writes state version 2. Revenue accounts may not be the board itself. `toilet` is
  the TOILET token this board mints on, fixed for the board's life (TR-B §B4).
- `get_state_version()`: storage layout version (2).
- `get_payment_config()`: token address, prices and registration fee; amounts are strings.
- `register_credit_account()`: exact 0.01 NEAR, once per caller, before purchasing.
- `get_credits(account_id)`: decimal-string balance, or null if unregistered.
- `buy_credits_near(min_credits, expected_price)`: attach an exact positive multiple
  of the NEAR price. A rejected call reverts its credit changes and attached payment.
- On the configured mPOO token, call `ft_transfer_call` with the board as
  `receiver_id`, an exact price multiple as `amount`, and a JSON-encoded `msg`
  such as `{"min_credits":"2","expected_price":"100"}`. Follow the token's
  required 1 yoctoNEAR attachment and allow enough gas for receiver and resolver.
- `draw(x,y,color,max_credits)` / `draw_many(cells,max_credits)`: no deposit; debit the caller's balance
  atomically. **Cost is per cell and depends on how recently that cell was painted**: 1 credit for an
  empty cell or one last painted more than 60 minutes ago, 2 credits at 10–60 minutes, 4 credits under
  10 minutes. A stroke is priced entry by entry (a repeated cell pays the young rate) and charged in one
  debit, so a rejected stroke costs and stores nothing. If the total after free paints is above
  `max_credits` the call rejects with `PriceRoseAboveMax` (spec §C2). Colours are 0–15 (§P1).
- Free paints (`src/free_paint.rs`). **F1:** until every cell has been painted once
  (`first_fill_complete`, never unset), a registered account's first `free_first_paints_per_account`
  (25, bound 0–100) paints of *empty* cells cost 0. **F2:** after that latch, while
  `happy_hour_enabled` and inside the weekly window (`happy_hour_weekday` 0 = Monday, `happy_hour_start_s`
  after 00:00 UTC, `happy_hour_length_s`; start inclusive, end exclusive), base-tier cells cost 0 up to
  `happy_hour_cap_per_account` per window, for registered accounts that have bought credits when
  `happy_hour_requires_purchase`. Free cells join `free_cells`; a paid paint removes them. Switching happy
  hour off, lowering the cap or shortening the window is immediate; turning it on, raising the cap,
  lengthening the window or moving it while on needs 24 h since the last such change
  (`HappyHourCooldown`) and restarts it. Each draw event cell carries `"free": true|false`.
- `get_stroke_cost(account_id|null, cells)` → `{costs, free, total}`: exactly what `draw_many` would charge
  that account now, free paints and repeated cells included; pass `total` as `max_credits`.
  `get_cell_costs` is unchanged (tier price per cell, no free paints, no duplicate handling).
- `get_free_first_paints(account_id)` → `{used, remaining, active, allowance, registered}`.
- `get_happy_hour(account_id|null)` → `{open, enabled, first_fill_complete, window_start_ns, window_end_ns,
  used, cap, remaining, eligible, requires_purchase}`; the window is the open one, or the next one when
  closed; times are nanosecond strings.

## Game rules on chain (2026-10-28)

Every rule the game is expected to tune lives in a `Tunables` struct, so retuning is an owner
transaction rather than a redeploy plus a migration:

- `get_tunables()` / `set_tunables(tunables)` — owner-only, one yocto. Holds the repaint tiers, the paint
  quota (`quota_base`, `quota_per_cell`, `quota_max`) and the credit float cap
  (`max_outstanding_credits`). **The quota is stored but not yet enforced** — a zero limit disables
  that rule. There is no earning cap (owner decision T3): `max_earning_cells` is deleted. The
  emission rate `toilet_per_cell_second` is shown here but changes only through `set_toilet_rate`;
  `set_tunables` refuses a changed value with `RateViaSetter`.
- `get_cell_cost(x, y)` — what that cell costs right now. The page must display this rather than
  re-implementing the tier rule in JavaScript.
- `get_cell_costs(cells)` — the same answer for a whole stroke in one call, bounded by
  `MAX_DRAW_BATCH`. Use it instead of `get_cell_cost` per cell: a 64-cell drag priced cell by cell
  is ~129 round-trips (each cell also needs `get_pixel`) before the wallet prompt.
- `get_cells_owned(account_id)` — cells an account holds, free or paid; the input to the quota.
  Not every owned cell earns TOILET: see "TOILET accrual and claims".
- `get_outstanding_credits()` — credits sold and not yet spent. Prepaid service, never profit.
- `upgrade(code, migrate_args)` — owner-only, one yocto. Deploys `code` and calls its
  `migrate(migrate_args)` in **one receipt** on the board account, so a rejected migration rolls the
  deploy back. For v1 → v2, `migrate_args` is `{"team_account": "…", "buyback_account": "…", "toilet": "…"}`. The
  board keeps this; TOILET does not (D4), because the board custodies credits and pixels.
  Never call `new` over live state.
- `migrate(team_account, buyback_account, toilet)` — `#[private]`, `#[init(ignore_state)]`. Accepts only
  version-1 state (detected by its first u32, see `src/migrate.rs`); rejects a second run, a fresh
  v2 board, or anything unknown with `UnsupportedStateVersion`. Maps `p`, `h`, `c` keep prefix and
  value type; new maps `a` (account extras) and `f` (free cells) start empty. Holder records in `h`
  gained a trailing `earning` count (TR-B); a version-1 record still decodes, as `earning = cells`
  (version 1 had no free paints), and `total_earning` starts at `total_cells`. TR-B also added board
  fields without bumping the state version: a board already running version-2 code cannot be
  upgraded to this code (its `migrate` rejects version 2, so the deploy rolls back). New layouts
  are fresh-init only (owner, 2 Nov).

The board account must also be registered on the mPOO token before receiving it.
The board credit-registration fee does not perform that token registration.
Plain `ft_transfer` does not invoke the receiver and does not buy credits.
Do not send plain token transfers or plain NEAR transfers to purchase credits.

## NEARLY compatibility and evidence boundary

[NEARLY documentation](https://nearly.trade/docs#tax), read 2026-10-28, describes
NEP-141-style tokens with immutable tax rates on transfers into/out of Rhea DCL.
Ordinary wallet transfers are untaxed. Its trading section says buy tax is applied
after the exchange's minimum-output check, so a DEX quote is not the delivered amount.

This receiver authenticates the configured token and credits only its reported
`ft_on_transfer` amount. It does not subtract a guessed tax percentage. It restricts
purchases to direct sender/signer identity and explicitly rejects the Rhea sender.
Unknown tokens panic; malformed, insufficient, unregistered, overflowed or routed
purchases return the full unused amount to the token resolver. Exact multiples
avoid partial-dust refunds. No manual outgoing token transfer is scheduled.

The existing research snapshot identifies `mpoo.nearlytrade.near`, 18 decimals,
but this is not current on-chain verification. Before enabling real payments:
verify the deployed token's metadata, tax configuration, receiver amount and
resolver behavior using an actual direct transfer and rejected-transfer refund.
Local tests simulate those calls; they do not prove live NEARLY compatibility.

## Costs and later economy work

Users currently pay their own transaction gas. The contract pays storage staking
from its NEAR balance. Registration collects a separate fixed 0.01 NEAR fee for a
bounded account record; it is not a full NEP-145 storage API and has no unregister
or refund. Confirm measured storage costs before launch. Pre-fund enough NEAR for
the full 128x128 board, since mPOO receipts cannot pay NEAR storage staking.
Benchmark single draws, 64-cell strokes, registrations, purchases and refunds in
a sandbox/testnet; then calculate margin with gas sponsorship (if added), storage,
conversion costs, tax and a reserve. A 0.0025 NEAR price alone cannot guarantee profit.

`ECONOMY NEXT` comments mark the extension points. This board has no staking,
longevity rewards or swaps. TOILET emission uses the claim path below. NEAR and mPOO
revenue leave only through the split above.
Future distribution must account for tax and pending liabilities, and must never
distribute staked principal or outstanding refund liabilities.

## Checks

Run `cargo test --locked --manifest-path contracts/paid-board/Cargo.toml`.
Build WASM with `cargo build --locked --release --target wasm32-unknown-unknown
--manifest-path contracts/paid-board/Cargo.toml`. Deployment, live settlement,
wallet UI integration, migration and independent security review are separate steps.

## Mainnet measurement procedure

Start read-only with an existing transaction hash and signer account. Retrieve its
complete RPC execution outcome at `wait_until: FINAL`, including refund receipts.
Sum `tokens_burnt` from `transaction_outcome.outcome` and every entry in
`receipts_outcome[].outcome`, once per outcome, and divide by 10^24 for NEAR.
This reports execution fees; attached purchase deposits are not gas fees. Check
all receipt statuses and final credit/pixel state, since a top-level successful
transaction alone is not proof of successful purchase or swap settlement.

Measure storage separately: query the board's `storage_usage` before and after an
isolated transaction and multiply the byte increase by the applicable network
storage price. This is locked capital, not a recurring burned transaction fee.
Concurrent calls can contaminate a block-to-block difference: use a dedicated
benchmark account/deployment or transaction-specific state-change evidence.

Benchmark registration, NEAR purchase, mPOO purchase, first pixel, overwrite,
64-pixel batch, and rejected purchase/refund. Report user-paid fees separately
from contract-funded storage and any sponsored gas. Divide batched painting fees
by successfully painted entries, and amortize credit-purchase fees over credits.
An existing free-board mainnet transaction is useful baseline evidence, but does
not measure this undeployed paid contract. No mainnet transactions were sent.

References: [NEAR transaction RPC](https://docs.near.org/api/rpc/transactions),
[storage staking](https://docs.near.org/protocol/storage/storage-staking).

## Purchase UI: read-only display implemented, checkout pending

Start with a credit quantity selector, Pay with NEAR / Pay with mPOO, separate
registration/gas disclosure, and a Buy mPOO on NEARLY link for insufficient balances.
On return, refresh the wallet's actual token balance before offering credit purchase.
An embedded swap can later deliver mPOO to the user's wallet, followed by a separate
credit purchase; the current receiver does not accept direct DEX-routed deposits.
For the documented DIARHEA pair route, NEAR goes through RHEA then DIARHEA then
mPOO. Verify current pool IDs and executable quotes before implementing the route.

An inventory shop is a separate later-stage business: quote a disclosed premium
above net replacement cost, reserve inventory per order, handle failed delivery
and refunds, and cap exposure. Restocking later at a lower price is not guaranteed
arbitrage. Use separate inventory capital, never credit-service or storage reserves.

## TOILET accrual and claims

Do not run `new` over live state. An existing board moves to a new layout only through
`upgrade` → `migrate` (see Calls).

`toilet_per_cell_second` in `Tunables` defaults to 0, so no emission begins until
the owner sets a rate. It counts atomic units (18 decimals) per **earning** cell
per second. The maximum is `u128::MAX / (86_400e9 * 16_384)`; higher values fail
`ToiletRateTooHigh`.

**Earning tiles (TR-B §B1, owner decision T4).** A cell earns while it holds paint
whose latest paint was paid with credits. A free paint (F1 free first paints, F2
happy hour) owns its cell, and counts in `get_cells_owned`, but earns nothing until
someone repaints it with credits. That includes the same artist: repainting your own
free cell with credits starts it earning, and a free happy-hour repaint of a paid
cell stops it. Each holder record keeps `cells` (ownership) and `earning`; the board
keeps `total_cells` and `total_earning`, and accrual uses only the earning counts.
A free tile's share is never reserved, so it stays in the unissued part of the cap:
nothing is minted for it and nothing is burned. There is no per-account earning cap
(T3).

**The rate setter (TR-B §B3, owner decision T2).** `set_toilet_rate(per_cell_second)`,
owner-only, exactly 1 yoctoNEAR, is the only way to change the rate. It accrues the
old rate up to now first, so no change is retroactive. Its guards:

- **0 is allowed at any time** (the emergency stop). It does not restart the cooldown.
- The **first** switch-on ever may be any value up to the maximum.
- A later switch-on from 0 may be at most 2× the last non-zero rate.
- A change between non-zero rates stays within ×2 and ÷2 of the current rate
  (`ToiletRateStepTooLarge`; odd halving rounds up, like prices).
- Any change to a non-zero rate, a switch-on after a stop included, waits
  `TOILET_RATE_COOLDOWN_NS` (24 h, a constant) after the last change to a non-zero
  rate (`ToiletRateCooldown`). Without that, stop → 2× → stop → 2× would compound in
  one block. Owner confirmed this rule on 3 Nov.
- Event `toilet_rate_changed {old, new, changed_at_ns}` (decimal strings).

At the start of `draw`, `draw_many`, and `claim_toilet`, the board reserves elapsed
emission against the lifetime 1 billion TOILET cap. The invariant is
`accrued_total <= CAP`; claims do not consume this allowance again. No holders
are iterated. A shared per-cell accumulator uses `SCALE = 1e9`, with a compile-time
assertion that `CAP * SCALE` fits `u128`. Accumulator division loses less than
`total_cells / SCALE` atomic units per call (at most 0.000016384). Subsecond
per-cell emission is truncated before multiplying by the number of cells.
Intervals with no earning cell reserve nothing. Long idle intervals clamp safely at the cap.

Ownership and earning changes settle both holders before changing their counts and
checkpoint their new debts against `earning`. Same-artist repaints leave ownership unchanged;
losing every cell preserves pending emission. Once the cap is reserved, accrual
stops and previously earned claims remain available.

- `get_pending_toilet(account)` returns a decimal-string amount including accrual
  projected through the current block. This view does not reserve or mutate state.
- `get_toilet_emission()` returns `{per_cell_second, accrued_total, cap, remaining,
  toilet, last_toilet_rate_change_ns, last_nonzero_toilet_rate}`; amounts and times are
  decimal strings, `last_toilet_rate_change_ns` is null before the first switch-on.
  Totals describe persisted reservations, not a view projection.
- `claim_toilet()` takes no argument and requires exactly 1 yoctoNEAR. It settles the
  caller, takes and zeroes their pending amount, and returns a promise to
  `mint(account, amount)` on the TOILET token stored at `new` (§B4) with zero deposit
  and 10 Tgas, **chained to a private `resolve_claim(account_id, amount)` callback**.
  An empty claim fails `NothingToClaim`. A claim below `MIN_CLAIM` (1 TOILET,
  10^18 atomic units, a constant; §B5, value confirmed by the owner on 3 Nov)
  fails `ClaimBelowMinimum`, so dust claims cannot drain the token's
  auto-registration balance. The `toilet_claimed` event includes `account_id`, `amount`,
  and `accrued_total`; it proves the claim was scheduled, not that the mint succeeded.
- `resolve_claim` restores the claim when the mint fails — wrong token address, wrong
  emitter, registration reserve low, or gas. The amount goes back into `pending` and
  `claim_failed` is emitted. `PromiseError::TooLong` counts as success: the call
  succeeded and only the payload could not be read, so treating it as failure would
  double-credit. Without this callback a refused mint silently destroys the claim.

Configure this board as the stored TOILET token's emitter and fund the token's
registration reserve. Emission mints only through a player claim. Follow the
returned receipt: the event records a scheduled claim, not successful minting.
As specified, there is no mint-failure callback or retry restoration: pending is
already zero if that separate receipt fails (including an incorrect token address,
wrong emitter, or low registration reserve). No deployment or live receipt test
was performed.
