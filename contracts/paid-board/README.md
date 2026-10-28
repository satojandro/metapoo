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
- [Upgrade policy proposal](../../docs/payments/upgrade-policy.md): choose control
  and migration design before deployment; current code has no migration/upgrade method.

## Product rules

One credit pays for one submitted pixel placement. Credits never expire and cannot
be transferred, redeemed or withdrawn. A batch charges per entry (including
repeated coordinates); recoloring or repainting also costs one credit per entry.
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
- `draw(x,y,color)` / `draw_many(cells)`: no deposit; debit caller's balance atomically.

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

`ECONOMY NEXT` comments mark the extension points. This stage has no staking,
TOILET issuance, longevity rewards, buybacks, burns, swaps, withdrawals or treasury
distribution. Proceeds stay in the contract. Before treasury withdrawals, account
for outstanding-credit service obligations, storage reserves, tax and pending
transfers. Never distribute staked principal or outstanding refund liabilities.

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
