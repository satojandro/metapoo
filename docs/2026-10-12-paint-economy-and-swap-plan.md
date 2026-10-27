# MPOO game economy and implementation plan

Updated: 12 October 2026

Status: current economy planning document. Product decisions are distinguished from proposed mechanics and unset parameters. This original planning work did not implement payments. The 28 October override below records subsequent local payment work; staking, rewards, inventory shop and trading remain unimplemented by that work. The running board implementation remains a free Open wall; frontend changes are proceeding separately.

## Payment-stage override — 28 October 2026

The current stage accepts **NEAR and mPOO**, with one non-expiring internal paint
credit per pixel placement and an initial price of **0.0069 NEAR**. The first mPOO
acquisition UI is an external NEARLY link. Older MPOO-only, TOILET-pack and embedded
swap requirements below are historical proposals, not current implementation instructions.
Staking, longevity/rewards, TOILET and the inventory shop are deferred.
The [paid contract](../contracts/paid-board/README.md) exists locally; no mainnet
deployment has happened. Follow the [frontend handoff](payments/frontend-handoff.md),
[mainnet cost gate](payments/mainnet-cost-validation.md) and [upgrade proposal](payments/upgrade-policy.md).

## Decisions and reading path

The [product PRD](2026-10-12-product-prd.md) adds pressure-priced placement, historical prints and Art Bounties. The [pressure spec](implementation/pressure-and-paint.md) defines the proposed variable TOILET placement charge while paint-pack MPOO pricing remains versioned and fixed within a schedule. The [bounty spec](implementation/art-bounties.md) keeps funded MPOO awards in separate escrow, outside game revenue and staking distributions. These domain specs complement this economy plan; they do not approve production price parameters or enable payments. The first integrated testnet slice defers longevity issuance, staking and the inventory shop to keep the funded-art journey bounded.

Confirmed by the user:

- The primary economic objective is genuine MPOO acquisition/trading activity and its associated supply burn.
- Paid paint purchases accept **MPOO only**. NEAR is not an alternative paint-payment asset.
- **MPOO is the staking asset**, confirmed after the latest question.
- Pixels earn **TOILET** through longevity. TOILET is spent/burned as paint, allowing players to reuse earnings in the game.
- Net game revenue is to be distributed **in MPOO**, after a disclosed operating reserve and liabilities. This replaces the earlier NEAR-only distribution plan.
- Competition should produce repeated painting expenditure greater than pixel reward issuance. This is a design target to test, not observed player behavior.
- Investigate a separate shop selling existing treasury MPOO for NEAR at a premium and replenishing inventory through the DIARHEA route. Premium, inventory, risk budget and execution permissions remain unset.

The earlier NEAR-versus-MPOO 20% paint discount is obsolete when MPOO is the sole paid asset. No replacement discount or shop premium has been chosen. Stakeholders receive revenue rights, not equity or legal ownership of the platform. Earlier MPDAO allocation ideas are not an additional claim on these proceeds.

Start here for the economy. Read [shared decisions](00-shared-decisions.md) for implemented board rules and next-phase status, and the [live MPOO readout](research/2026-10-12-mpoo-live-contract-readout.json) for exact blockchain observations. Board presentation/interaction work remains in its existing briefs linked from the root README.

## Verified facts and evidence boundaries

Local board source in `contracts/board/src/lib.rs` stores current color, artist and latest write time. It has no payments, balances, continuous tenure, rewards or staking. Own recolors reset the write timestamp. The frontend payment provider is a placeholder. Frontend uses Vite/TypeScript and near-connect; a complete economy journey has not been tested.

The readout records MPOO mainnet metadata/settings and the Nearly launch record: token `mpoo.nearlytrade.near`, 18 decimals, 2% buy tax, 3% sell tax, listed exchange `dclv2.ref-labs.near`, launch 2311 and pool `diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000`. Its factory tax read at block 219621014 reports creator/burn/holder allocations plus a platform portion. These fields do not all share one additive denominator; do not interpret `burn_bps: 3300` as 33% of every trade.

[Nearly documentation](https://nearly.trade/docs) explains exchange-boundary tax, fixed supply, holder payouts, the DIARHEA route and refunded swaps. Direct user-to-game transfers are expected to avoid the trading tax under the observed venue rules. DEX purchases and sales do not. Refresh settings and verify actual transfer/refund/burn behavior before integration. The inspected token program exports `burn` and no mint method; the game cannot mint MPOO. Tax-funded holder payouts already exist and must remain distinct from game staking income.

Rhea publishes a [React swap widget and SDK](https://github.com/ref-finance/ref-sdk/blob/main/README.md), [DCL transaction helpers](https://github.com/ref-finance/ref-sdk/blob/main/src/dcl-swap/swap.ts) and a separate [cross-chain API](https://github.com/rhea-finance/rhea-sdk-docs/blob/main/CrossChainDexAPI.md). Their existence does not verify support for MPOO's entire multi-venue route, tax behavior or our wallet adapter. Cross-chain support is not needed for this phase.

Historical engineering reference: [Berry Club drawing](https://github.com/evgenykuzyakov/berryclub/blob/master/contract-rs/pixel-board/src/lib.rs) charged/burned avocados outside its free-drawing exception; [account code](https://github.com/evgenykuzyakov/berryclub/blob/master/contract-rs/pixel-board/src/account.rs) farmed avocados or bananas from pixel-time; [Berry Farm](https://github.com/evgenykuzyakov/berryfarm/blob/master/contract-rs/berry-farm/src/lib.rs) accepted bananas and credited cucumber balances for NEAR sharing. Our economic assets and reversible staking rules differ from that historical implementation.

## Product journey and token roles

1. Explore freely, then connect a wallet.
2. Obtain MPOO through the verified embedded swap, [Nearly fallback](https://nearly.trade/mpoo.nearlytrade.near), or the proposed clearly priced inventory shop.
3. Buy a paint pack with MPOO. The pack supplies TOILET paint units; do not introduce another independently spendable credit token.
4. Spend/burn the configured TOILET amount to paint. A failed placement spends nothing. Recoloring or overwriting is a paid action; reject exact same-artist/same-color no-ops without charging.
5. Pixels earn bounded TOILET over their continuous attribution interval. Spend earned TOILET to paint again.
6. Stake MPOO, with disclosed eligibility/withdrawal timing, and claim the recorded share of net MPOO game revenue.

Buying MPOO, buying paint and drawing are separate operations with separate confirmations. A successful swap does not buy paint automatically. TOILET spending generates no new MPOO revenue; only an actual paid purchase does. Staking locks existing MPOO without reducing total supply or creating exchange volume. Unstaking returns principal. Reward and ranking resets must never erase owned tokens or historical revenue entitlements.

## MPOO purchases, reserve and payouts

Proposed initial implementation keeps purchase acceptance and TOILET paint accounting together in the board/economy contract. Use MPOO `ft_transfer_call`; authenticate the predecessor as the exact token account and credit the original `sender_id`. Do not credit a browser-supplied artist or the MPOO token contract itself. Validate pack ID, schedule version/expiry and amounts, then record the paint allocation and paid revenue. Reject invalid/underpaid requests through the token refund protocol. Choose and document excess-payment, unused-paint refund and expiry policies before recognizing revenue.

Use a versioned price schedule denominated in MPOO. A designated administrator and explicit update/expiry policy are recommended initially. Do not silently reprice already purchased paint or enforce prices supplied only by the browser. Any automated price oracle requires separate review for thin-liquidity manipulation and stale rates.

Net distributable MPOO equals eligible paid receipts minus refund obligations, the disclosed reserve, any separately approved burn/reward allocation and outstanding/pending liabilities. Reserve percentage and its calculation basis are still unset. Staking principal, shop inventory and TOILET allocations are not game-sale revenue. Any optional game-level MPOO burn must be allocated explicitly; the same tokens cannot be burned and paid to stakers.

Paying out directly in MPOO removes the mandatory game-revenue sell and its trading costs. Recipients can hold, stake or sell; their later exchange sales can create selling pressure. Operating storage/gas expenses still require NEAR. Fund a NEAR operating balance separately or disclose a limited sale of operating-reserve MPOO. Do not reintroduce automatic conversion of all game revenue to NEAR.

Recommended stake policy: additions/removals become effective at defined period boundaries, with historical account checkpoints and recorded eligible totals. Associate purchase revenue with the proper period, not the instant a delayed forwarding transaction lands. New stake must not collect previously accrued revenue; withdrawal must preserve earlier entitlements. Claims and catch-up work are bounded and do not loop over all stakers. Specify cooldown and the destination of proceeds earned when there are no eligible stakers.

Use claim-based transfers with pending IDs and callbacks. Failed MPOO claims/unstakes must restore the correct entitlement or remain recoverably pending. Track actual forwarded/received revenue once, including duplicate-request protection. Preserve principal withdrawal where safe during a distribution pause.

MPOO held by the staking vault may itself receive Nearly holder payouts. Test actual eligibility and record those receipts separately, with a disclosed beneficiary rule. Do not promise that depositors retain identical personal tax-holder payouts after moving their balances into a contract.

## Separate NEAR-to-MPOO inventory shop

This is a retail inventory service with automated replenishment, not guaranteed risk-free arbitrage. The site sells its own MPOO inventory to customers for NEAR at a disclosed convenience premium. It then uses sales proceeds to purchase replacement MPOO through the verified DIARHEA route. This is separate from the game, which still accepts only MPOO for paid paint.

Profit depends on the **actual all-in replacement cost**, including final received MPOO after buy tax, intermediate-token taxes, route/pool fees, execution/storage expenses, slippage and price movement. A premium over a spot price is not evidence of positive margin. Display net delivered MPOO, full NEAR cost, quote expiry and the premium. Retain an external alternative; users may prefer its lower price.

Illustration only: sell a batch for 1.10 NEAR, actually replace it for 1.07 NEAR and spend 0.01 NEAR on other costs: the remainder is 0.02 NEAR. A 1.12 NEAR replacement cost would make that sale unprofitable. No quote or chosen premium is implied.

### Execution and accounting proposal

- Supply a finite initial MPOO inventory and independent NEAR working/risk budget. Never borrow staked principal, refund reserves or pending payout assets.
- Generate a short-lived size-specific quote from executable route estimates. Limit order size and reject stale/out-of-policy quotes. Model the customer's exact net delivery and the inventory's exact required replenishment.
- Reserve inventory/order state before accepting the sale. Use IDs/nonces, expiries, in-flight counts and callbacks to prevent double delivery or restocking.
- Confirm delivery or refund with asynchronous failure recovery. A successful NEAR deposit alone does not prove MPOO delivery.
- Replenish only completed sales, within maximum spend, minimum received MPOO, price-impact, inventory and daily-loss limits. Compare sequential fulfillment/replenishment with pre-hedged stock; neither eliminates exposure to price changes.
- Authenticate the keeper and restrict asset/receiver/method choices. An off-chain executor has no key in the frontend and no authority to spend unrelated vault funds. A separate contract/account is recommended for inventory isolation.
- Record route input actually used and net output actually received. A refunded swap must not count as a successful refill. Multiple classic/DCL legs can partially complete; keep residual RHEA/DIARHEA/wNEAR balances and a bounded recovery policy.
- Halt new quotes when margins, liquidity or inventory are inadequate. Do not chase a loss with unconstrained trades. No self-trades or repetitive buy/sell churn to manufacture volume.

Customer NEAR payments include the cost of goods sold, not just profit. Keep shop inventory principal and replacement liabilities separate from game receipts. Do not distribute gross shop turnover as revenue. If shop profit is later included in staking income, explicitly authorize the allocation and acquire the payout MPOO from that realized profit; do not distribute replacement inventory. No decision to share shop profit has been made yet.

Real customer sales followed by replenishment can create recurring buy-side MPOO exchange activity and its configured tax burn. Sales from existing inventory alone do not trigger exchange tax. Tax-burn quantities and customer-acquisition benefits remain measured outputs, not guarantees of token-price appreciation.

## Swap integration checks

Validate the full NEAR-to-RHEA-to-DIARHEA-to-MPOO path and its current pools. Do not assume a direct NEAR/MPOO pool exists. Verify every intermediate token's decimals and tax behavior. Inspect widget route/whitelist support before choosing it; a custom panel using reviewed helpers can preserve the existing frontend and wallet connector.

Tax-aware minimum-output policies must protect the actual recipient balance. If only the final output is taxed at 2%, receiving M MPOO needs an appropriately rounded pre-tax minimum of roughly M / 0.98; extra taxed legs require their own adjustment. Nearly documents buy tax after the pool minimum-output check. Wallet transaction success can also mean a fully refunded swap, so inspect input used, output receipts and final operation state rather than a hash or success flag alone.

Handle registrations, wrap/unwrap, quote expiry, gas reserve, rejected approvals, account/network changes, reload and uncertain transactions. Do not blindly repeat a potentially completed trade. Verify mobile/desktop and retain Buy MPOO on Nearly if the embedded route or inventory quote is unavailable.

## TOILET accounting and competitive longevity

Recommended initial structure: TOILET ledger and board in one contract, with token-standard methods if a transferable token is required. Buy/allocate paint, burn and update a pixel in the same contract receipt so a failed draw cannot burn tokens without painting. A separate staking vault holds MPOO. Coupling board/TOILET upgrades is an explicit tradeoff; a separate TOILET contract would require a more complex reservation/burn/confirmation protocol.

Purchased and earned TOILET have identical paint spending rights. Define finite purchase/reward allocations and the long-run replenishment/issuance policy. For pre-minted allocations, distribution changes liquid availability but not total supply; actual burn lowers supply. If issuance is allowed instead, count both purchased and rewarded issuance against burns. A UI counter alone is not evidence of a standard token burn.

Pixel state needs separate latest-paint time, artist tenure start and settlement checkpoint. Own recolors preserve tenure. Before overwrite, settle the previous artist's bounded entitlement and then start the next artist's interval. Empty cells earn nothing. Preserve fractional remainders, use chain time, cap at season end and advance checkpoints so no interval earns twice. Settled rewards survive losing the pixel. Claims process bounded coordinate lists/account work, not the whole board. Choose whether a pause stops accrual.

### Spending must exceed rewards in paint-equivalent units

Measure painting expenditure and TOILET rewards in the same paint units over the same period. Separate paid-funded consumption from consumption funded by previously earned TOILET; repeated reward-funded painting is activity but not new MPOO income.

Competition can increase spending, but cannot guarantee it. Users may cooperate, bots may monopolize territory, or everyone may stop painting. Use hard emission limits as well as competitive features:

- Finite season budget and funded entitlement accounting.
- Per-interval/season accrual caps; no untouched pixel earns forever.
- Evaluate a maximum lifetime reward in paint units below the paint cost of the placement. This would ensure each placement is a net token sink regardless of how long it survives, but the ratio needs playtesting.
- Bound the season budget as a fraction of actual paid-funded paint consumption where appropriate. Define how reward eligibility is reserved without overcommitting future claims.
- Own recolors and season boundaries must not reset a placement's cumulative lifetime reward cap. A renewed reward budget requires a new explicitly paid placement under the chosen rules. New paid overwrites must not unlock more guaranteed rewards than they consume. Same-person activity across multiple wallets is an economic test case, not prevented by an account cap.

Illustration: if a placement consumes one paint unit and its maximum lifetime rewards are 0.6 units, each such placement contributes at least 0.4 units of net consumption. Ten placements consuming ten units and issuing at most six contribute four units. These are examples, not chosen parameters; paid purchases can still release additional inventory.

The gamification target is repeated creative rivalry: overlapping territory, team murals, bounded contests, clear season end times, longest-surviving-art records, badges and wall snapshots. Distinguish artist tenure from unchanged-image age. Test whether incentives preserve art or reward covering it with a solid color. Separate art rankings from MPOO wealth/stake. Use optional notifications and player-controlled session spending budgets.

## Contract and frontend work map

| Area | Required change |
| --- | --- |
| Board/economy + TOILET | MPOO receiver, price/pack validation, TOILET allocation/burn, atomic paid draw, tenure settlement, funded claim ledger, revenue forwarding, events and migration |
| MPOO staking/revenue vault | Stake custody, eligibility periods, historical MPOO entitlements, reserve accounting, claims/unstakes and failure recovery |
| Optional inventory shop/keeper | Separate inventory/cash/order ledgers, delivery/refunds, bounded replenishment and measured spread |
| Shared types/config | Exact token/network IDs; integer-string monetary/timestamp fields; account, pack, reward, stake/order states and error codes |
| Frontend payment/wallet adapters | MPOO-only paint checkout; separate Acquire MPOO flow; swap/shop quote display; general signed transactions preserving restricted draw sessions |
| Frontend draw/board adapters | Credit/TOILET checks, pending spend, balance refresh, fee/schema validation and overwrite-aware confirmation |
| Account UI | Available paint, capped TOILET earnings, MPOO stake, pending MPOO payouts, reserve/rules and optional shop order recovery |
| Deployment/operations | Authorities, storage/gas funding, schedules/caps, telemetry, reconciliation, inventory budget and emergency controls |

Use checked integer arithmetic; NEAR has 24 decimals and MPOO has 18. Serialize large quantities/timestamps as decimal strings. Converting an already-rounded JavaScript number to a string cannot repair precision.

Zero-deposit draw can preserve the drawing-session approach after top-up. Explain that an authorized draw key can spend paint units and gas; gas allowance is not a paint allowance. Bound session spending, protect account/network switches and retain revoke/ordinary-wallet fallback.

## Migration, testing and rollout

Verify actual game deployment/account/upgrade powers before choosing migration or a new contract. The local board uses schema 2. Define old/new serialized state, unique storage prefixes and bounded migration; a schema increment alone does not migrate data. Preserve existing pixels, and start new reward eligibility at a stated boundary because last-write timestamps cannot reconstruct continuous historic tenure.

Choose initial paint grants, reserve, refunds, token funding and authority rules. Fund storage for all board cells/accounts and the NEAR operating balance. Remove any free method bypass when enabling the paid schema; reject incompatible frontend metadata. Register contract accounts on external tokens where needed.

Delivery order:

1. Economy simulation and parameter/interface specification.
2. MPOO purchase acceptance, TOILET paint balance/burn and atomic deductions.
3. Capped tenure rewards and repeat-safe settlement.
4. MPOO staking, revenue forwarding, reserve, claims and withdrawals.
5. Embedded Acquire MPOO route/fallback and tax-aware confirmations.
6. Optional inventory shop in quote-only simulation, followed by budgeted execution when its configuration is explicitly chosen.
7. Migration and end-to-end rehearsal with independent users.

Required tests cover forged token calls/prices, underpayment/refunds, decimal overflow, concurrent last-credit spending, no-ops, atomic batch validation, same-artist recolor, overwrite settlement, season/emission caps, duplicate forwarding, stake entry/withdrawal timing, failed callbacks, principal coverage, shop stock exhaustion, stale quotes, tax-adjusted replenishment, partial multi-leg swaps and operation recovery. Assert actual assets cover all liabilities without counting inventory or stake as profit.

Model active competition, quiet/cooperative play, falling paid demand, full-board capture, dominant stakers, multi-account bots, low route liquidity and supply/inventory depletion. Report paid consumption versus reward-funded consumption, TOILET issuance/burns, MPOO acquired/staked/distributed/sold, tax/game burns, reserve, replacement liabilities and realized shop profit. A model does not predict market price or prove competitive retention.

Local/testnet success does not establish actual MPOO mainnet transfer behavior. Small scoped live trials, any live bot, keys, treasury budgets and deployment are separate execution steps; this document supplies no such settings or credentials.

## Remaining decisions

Paint-pack MPOO prices; TOILET units per paint, supply/allocation and long-run issuance; longevity rate/lifetime cap/season budget; reserve percentage and basis; credit refunds/expiry; staking period/cooldown/no-staker funds; pricing and upgrade authorities; NEAR operating funding; shop premium/inventory/risk limits; whether realized shop profits join game distributions; intermediate-token transfer behavior and actual contract eligibility for external holder payouts.

## Documentation ownership

This file is the single economy plan, updated in place. The exact MPOO readout is evidence, not another plan. Root README is the navigation entry; shared decisions separates current implementation from next-phase requirements. Economy comparisons and burn/staking notes formerly in two separate files have been merged here and removed. Frontend visual/interaction briefs, contract handoff and the historical Intents research retain distinct purposes and are not duplicated into new economy documents.
