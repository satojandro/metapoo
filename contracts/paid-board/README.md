# Paid board: payment integration stage

Schema **4** — this is the product board, ratified 2026-10-28
([decision record](../../docs/payments/2026-10-28-paid-model-decisions.md)).
`contracts/board` (free schema 2) is retired as a product and kept as the testnet fixture.
Fresh account initialization only: this is not a migration of an existing board, and the
testnet mural does not carry over. Pricing stays per pixel; the launch price is being set.
The app's read-only panel supports paid price/credit views, but paid checkout and painting
integration remain pending.

## Release follow-ups

- **No mainnet deployment yet.** Immediately after deploying, reopen backlog
  **PAY-COST** and complete [mainnet cost validation](../../docs/payments/mainnet-cost-validation.md)
  before general paid launch. Every measurement is still pending.
- [Accepted frontend requirements](../../docs/payments/frontend-handoff.md): NEARLY
  link, pixel prices, credits, NEAR and mPOO balances implemented locally as read-only UI; checkout and live paid-state verification pending.
- [Upgrade policy proposal](../../docs/payments/upgrade-policy.md): the board keeps an
  owner-only `upgrade()` so a bug in credit or pixel custody stays repairable; TOILET
  deliberately exposes no upgrade entrypoint (D4). Migration design and a state-preserving
  rehearsal remain pending.

## Product rules

Credits never expire and cannot be transferred, redeemed or withdrawn. A batch
charges per entry (including repeated coordinates), using the 1/2/4-credit
recency tiers described below; one credit is the default empty/old-cell cost.
Invalid coordinates/colors and insufficient balances reject the entire stroke.
Native NEAR and direct mPOO purchases are supported without a swap.

The fixed launch price is **0.0069 NEAR per pixel** (6,900,000,000,000,000,000,000
 yoctoNEAR). Ten credits cost 0.069 NEAR; 100 cost 0.69 NEAR, excluding separate
registration and gas. This is a NEAR-denominated price, not a USD peg. At an example
NEAR price of $4.35, it is about $0.03 (three cents), not 0.03 cents.

Initialization automatically uses this NEAR price and requires a nonzero mPOO
price in atomic units. Owner price updates remain available as previously agreed;
there is no automatic repricing. Test prices 10 and 100 are arithmetic fixtures,
not economically valid launch prices. `set_credit_prices` changes prices with
exactly 1 yoctoNEAR attached. Existing credits are unaffected. Buyers submit
`expected_price` and `min_credits`; stale prices reject/refund.

## Safety controls (local, 2026-10-28)

- Owner-only `set_paused(paused)`, with 1 yoctoNEAR, stops `draw`, `draw_many`, and
  native purchases with `Paused`. Authenticated FT purchases return the full unused
  amount for refund. Views, upgrades and treasury withdrawals remain available.
  `get_tunables().paused` exposes the state.
- Owner-only `set_toilet_paused(toilet, paused)` requires exactly 1 yoctoNEAR
  and returns a promise calling the supplied token's `set_paused` with 1 yoctoNEAR
  and 10 Tgas. The board must be that token's current emitter. This makes TOILET's
  emitter-only circuit breaker reachable without adding a token owner; it works
  even while painting is paused. Follow the returned receipt to confirm success:
  scheduling does not prove the token paused. The token address is an argument,
  so this passthrough adds no state or migration. Emitter handoff passthroughs remain outside this task.
- `set_credit_prices` permits each price to move only between half and double its
  prior value (odd-number halving rounds up). The first change is allowed immediately;
  subsequent changes require at least 24 hours. `price_changed` includes both old
  and new prices. Invalid steps fail `PriceStepTooLarge`; early changes fail
  `PriceCooldown`. Even a no-op update starts the cooldown.
- `get_withdrawable_near()` returns the maximum available now, as a decimal string:
  account balance minus current storage stake, minus outstanding credits ×
  664,000,000,000,000,000,000 yoctoNEAR, minus the configured reserve floor.
  Underfunding or arithmetic overflow returns zero.
- Owner-only `withdraw_near(recipient, amount)` requires 1 yoctoNEAR and a positive
  amount no greater than that view; excess fails `ReserveBreached`. The returned
  transfer promise reserves funds immediately, preventing overlapping withdrawals
  from counting them twice. `treasury_withdrawn` has `status: scheduled`: delivery
  must be verified from the transfer receipt, not inferred from the event.
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

- `new(mpoo_token, mpoo_per_credit)`: initializer becomes pricing owner.
- `get_payment_config()`: token address, prices and registration fee; amounts are strings.
- `register_credit_account()`: exact 0.01 NEAR, once per caller, before purchasing.
- `get_credits(account_id)`: decimal-string balance, or null if unregistered.
- `buy_credits_near(min_credits, expected_price)`: attach an exact positive multiple
  of the NEAR price. A rejected call reverts its credit changes and attached payment.
- On the configured mPOO token, call `ft_transfer_call` with the board as
  `receiver_id`, an exact price multiple as `amount`, and a JSON-encoded `msg`
  such as `{"min_credits":"2","expected_price":"100"}`. Follow the token's
  required 1 yoctoNEAR attachment and allow enough gas for receiver and resolver.
- `draw(x,y,color)` / `draw_many(cells)`: no deposit; debit the caller's balance atomically. **Cost is
  per cell and depends on how recently that cell was painted**: 1 credit for an empty cell or one last
  painted more than 60 minutes ago, 2 credits at 10–60 minutes, 4 credits under 10 minutes. A stroke is
  priced entry by entry and charged in one debit, so a rejected stroke costs and stores nothing.

## Game rules on chain (2026-10-28)

Every rule the game is expected to tune lives in a `Tunables` struct, so retuning is an owner
transaction rather than a redeploy plus a migration:

- `get_tunables()` / `set_tunables(tunables)` — owner-only, one yocto. Holds the repaint tiers, the paint
  quota (`quota_base`, `quota_per_cell`, `quota_max`), the credit float cap (`max_outstanding_credits`)
  and the emission cap (`max_earning_cells`). **The quota and the emission cap are stored but not yet
  enforced** — a zero limit disables that rule.
- `get_cell_cost(x, y)` — what that cell costs right now. The page must display this rather than
  re-implementing the tier rule in JavaScript.
- `get_cells_owned(account_id)` — cells an account holds; the input to the quota and the earning cap.
- `get_outstanding_credits()` — credits sold and not yet spent. Prepaid service, never profit.
- `upgrade(code)` — owner-only, one yocto. The board keeps this; TOILET does not (D4), because the board
  custodies credits and pixels. A logic-only change needs no migration; adding a field to `Board` or
  `Payments` does, so it needs an `#[init(ignore_state)]` migration rehearsed against testnet state first.
  Never call `new` over live state.

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
conversion costs, tax and a reserve. A 0.0069 NEAR price alone cannot guarantee profit.

`ECONOMY NEXT` comments mark the extension points. This board has no staking,
longevity rewards, buybacks, burns or swaps. TOILET emission uses the claim path below. Native treasury
withdrawals use the safeguards above; mPOO proceeds remain in the contract.
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

This state layout is **fresh init only, no migration**. Do not deserialize an older
board into this layout or run `new` over live state. The existing board `upgrade`
entrypoint remains unchanged; it does not migrate this state.

`toilet_per_cell_second` in `Tunables` defaults to 0, so no emission begins until
the owner sets a rate. It counts atomic units (18 decimals) per held cell per
second. The maximum is `u128::MAX / (86_400e9 * 16_384)`; higher values fail
`ToiletRateTooHigh`. Changing tunables settles the elapsed interval at the old
rate before applying the new one. Stored quota and `max_earning_cells` limits
remain unenforced; accrual uses all held cells.

At the start of `draw`, `draw_many`, and `claim_toilet`, the board reserves elapsed
emission against the lifetime 1 billion TOILET cap. The invariant is
`accrued_total <= CAP`; claims do not consume this allowance again. No holders
are iterated. A shared per-cell accumulator uses `SCALE = 1e9`, with a compile-time
assertion that `CAP * SCALE` fits `u128`. Accumulator division loses less than
`total_cells / SCALE` atomic units per call (at most 0.000016384). Subsecond
per-cell emission is truncated before multiplying by the number of cells.
Empty-board intervals earn nothing. Long idle intervals clamp safely at the cap.

Ownership changes settle both holders before changing their cell counts and
checkpoint their new debts. Same-artist repaints leave ownership unchanged;
losing every cell preserves pending emission. Once the cap is reserved, accrual
stops and previously earned claims remain available.

- `get_pending_toilet(account)` returns a decimal-string amount including accrual
  projected through the current block. This view does not reserve or mutate state.
- `get_toilet_emission()` returns `{per_cell_second, accrued_total, cap, remaining}`
  as decimal strings. Totals describe persisted reservations, not a view projection.
- `claim_toilet(toilet)` requires exactly 1 yoctoNEAR. It settles the caller, takes
  and zeroes their pending amount, and returns a promise to `mint(account, amount)`
  on the supplied token with zero deposit and 10 Tgas, **chained to a private
  `resolve_claim(account_id, amount)` callback**. An empty claim fails
  `NothingToClaim`. The `toilet_claimed` event includes `account_id`, `amount`,
  and `accrued_total`; it proves the claim was scheduled, not that the mint succeeded.
- `resolve_claim` restores the claim when the mint fails — wrong token address, wrong
  emitter, registration reserve low, or gas. The amount goes back into `pending` and
  `claim_failed` is emitted. `PromiseError::TooLong` counts as success: the call
  succeeded and only the payload could not be read, so treating it as failure would
  double-credit. Without this callback a refused mint silently destroys the claim.

Configure this board as the supplied TOILET token's emitter and fund the token's
registration reserve. Emission mints only through a player claim. Follow the
returned receipt: the event records a scheduled claim, not successful minting.
As specified, there is no mint-failure callback or retry restoration: pending is
already zero if that separate receipt fails (including an incorrect token address,
wrong emitter, or low registration reserve). No deployment or live receipt test
was performed.
