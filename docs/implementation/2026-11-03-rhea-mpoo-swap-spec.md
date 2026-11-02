# RHEA mPOO acquisition — implementation specification

Date: 3 November 2026. Work ID: `RHEA-1`. Status: ready for implementation behind a disabled feature flag; **not a verified production trading route**.

Read the [shared integration specification](2026-11-03-wallet-funding-integration-spec.md) first. This document owns RHEA acquisition only. The owner requested embedded mPOO acquisition, confirmed that RHEA is its only liquidity venue, excluded mPOO from Intents, and requires players to pay their own gas. This supersedes the earlier link-only acquisition direction for this work; it does not authorize a token, board-contract or drawing-key change.

## Outcome and scope

A connected player enters an amount of native NEAR to spend, sees a route and a conservative **net mPOO received** estimate, explicitly approves the required wallet transactions, and receives mPOO into that same player's NEAR wallet. Keep the wall drawing intact throughout. The completion action is “Back to the wall”; “Buy paint credits with mPOO” may open the existing checkout only when its independently controlled payment flag and board settings permit it.

This implementation buys mPOO only. Selling mPOO, limit orders, liquidity management, treasury inventory, a custom swap/escrow contract, cross-chain execution, direct exchange-to-board purchases, sponsorship and automatic credit purchases are out of scope. Do not add React to the wall or import the RHEA widget merely to obtain swap helpers.

## Evidence baseline and mandatory first investigation

- Integration coordinator checked GitHub `main` at `7e123621c31206ab1c8f5f502ccf2ef3ed3aeb46`. The drafting checkout was the older `59cac46` admin branch. Rebase the implementation on current remote main, locate the same hooks there, and record the actual implementation base.
- Current local source has the normal wallet signer in `web/src/wallet.ts`, local paint signing in `web/src/local-draw.ts`, exact balance formatting in `web/src/paint-wallet.ts`, a disabled token-payment launch flag in `web/src/payment-flags.ts`, and the wallet panel in `web/src/app/paint-wallet-panel.ts`. These are integration points, not permission to rewrite them in parallel.
- The repository's [12 October readout](../archive/research/2026-10-12-mpoo-live-contract-readout.json) reports token `mpoo.nearlytrade.near`, historical pool `diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000`, exchange `dclv2.ref-labs.near`, and then-configured buy/sell tax of 200/300 basis points. One basis point is 0.01%. It proves historical configuration, **not a successful swap or today's liquidity**.
- The archived [acquisition investigation](../archive/planning-2026-10/2026-10-12-paint-economy-and-swap-plan.md) proposes a NEAR → RHEA → DIARHEA → MPOO route. Use that only as a discovery seed. Neither the intermediate RHEA asset ID nor the earlier pool IDs have been established here. Never invent a direct NEAR/MPOO pool.
- Reviewed upstream `ref-finance/ref-sdk` revision `8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d`. Its package file reports version 1.5.0, a React peer dependency and an older `near-api-js` dependency. Registry availability and compatibility were not tested. Prefer a narrow adapter using the existing `@near-js` stack and reviewed wire formats. Any added package must be pinned exactly, locked and justified in the PR.

Before enabling trading, the implementation agent must produce `docs/research/2026-11-03-rhea-route-evidence.json` (the date may advance) with block heights/hashes, capture time, public RPC URL, pool reads, token metadata, exchange code hashes, live tax settings, and route quote results. Do not include keys or private wallet data. A read failure means unavailable, never “zero liquidity” or a guessed default. This read-only discovery is authorized by the work order; swaps and storage deposits are separately signed player actions.

Discovery procedure:

1. Fetch `ft_metadata` for the exact mPOO contract. Confirm 18 decimals against the historical observation; a mismatch blocks launch until investigated.
2. Refresh the Nearly launch mapping with `get_launch_by_token({token: "mpoo.nearlytrade.near"})`, `get_tax` and code hash. Read the token's `get_tax({})`; do not treat token and factory responses as interchangeable or combine their allocation denominators.
3. Verify the mapped pool through DCL `get_pool({pool_id})`, including token IDs, direction and usable liquidity. The historical ID is a candidate, not an unchecked execution target.
4. Discover an executable path from `wrap.near` to that pool's quote asset. Indexer results may propose candidates; independently verify each selected pool on the proper exchange and quote the requested amount. Classic numeric pool IDs and DCL composite IDs must retain their distinct types.
5. Write an allowlisted route manifest containing each exchange, pool ID, input/output contract, token decimals, venue type and code hash. Cap at four swap legs for v1; no split routes or arbitrary user-supplied pools. Pin the supported route only after discovery; absence of a bounded path disables embedded trading and leaves the existing Nearly link available.
6. Determine and test tax/minimum-output semantics as described below. Discovering a quote is not sufficient to pass that gate.

## Files and ownership

The RHEA implementer owns new files below and their focused tests:

| Path | Responsibility |
|---|---|
| `web/src/integrations/rhea/types.ts` | Validated quote, route leg, tax evidence and execution checkpoint types |
| `web/src/integrations/rhea/config.ts` | Strict flag/network/allowlist loading; no credentials |
| `web/src/integrations/rhea/read.ts` | RPC views, metadata, storage, pool and tax reads |
| `web/src/integrations/rhea/quote.ts` | Exact-input quotes, integer slippage, net-output calculation and expiry |
| `web/src/integrations/rhea/plan.ts` | Pure allowlisted transaction builder and deposit budget |
| `web/src/integrations/rhea/controller.ts` | State machine, execution/resume and balance reconciliation |
| `web/src/integrations/rhea/panel.ts` | Vanilla TypeScript mount/unmount; accessible controls |
| `web/src/integrations/rhea/*.test.ts` | Adversarial quote, plan and recovery tests |
| `web/src/integrations/rhea/route-mainnet.json` | Reviewed production route manifest, initially absent/disabled |
| `docs/research/*-rhea-route-evidence.json` | Public route discovery and final trial evidence |

Shared types, `wallet.ts`, configuration wiring, environment example, wallet-panel mounting, global CSS/design tokens and dependency lockfile are integration-owner files. Request their changes through the shared API; do not have parallel agents edit them. Use the existing design tokens and keep overlays off the wall.

## Configuration

| Setting | Required behaviour |
|---|---|
| `VITE_RHEA_MPOO_SWAP_ENABLED` | Defaults false; true only with valid route evidence and network config |
| (network) | No separate setting: derive from `VITE_NEAR_NETWORK` / `WALLET_NETWORK`; production route is mainnet only |
| `VITE_RHEA_MAX_INPUT_YOCTO` | Positive integer-string spending cap chosen at release; unset disables submit |
| `VITE_RHEA_GAS_RESERVE_YOCTO` | Positive integer-string reserve; shared gas policy may impose a larger value |
| `VITE_RHEA_MAX_PRICE_IMPACT_BPS` | Explicit release limit, 1–1000; unset disables submit |

No endpoint, token, receiver or route may come from an unvalidated query parameter. Slippage defaults to 100 bps (1%), with user choices 50/100/200 bps and a hard maximum of 300 bps; v1 does not offer an unlimited setting. These are conservative implementation defaults, not claims about market prices. Cap quote lifetime at 30 seconds from the oldest price-dependent view and re-quote every remaining checkpoint before its approval. If the route changes, present a new review. Mainnet token IDs must never appear as enabled choices on testnet, localnet or mock. Testnet acceptance uses deliberately configured fixture tokens and pools, clearly labelled.

## Shared interfaces

Import `OperationContext` from `web/src/integrations/types.ts`: `{operationId, accountId, networkId, sessionEpoch}`. Account, network or session-epoch changes invalidate the quote and stop further approvals. Inject the integration owner's account-readiness/gas-budget services, operation store, balance refresh and `signAndSendApprovedTransactions(request: ApprovedTransactionRequest)` gateway. Never call a drawing signer, construct a full-access key, replace the wallet session, or expose wallet secrets to this module.

Domain API contract:

- `loadRheaReadiness(context, signal)` returns `ready` with validated metadata/manifest, or a typed blocking reason. It checks account initialization and native-NEAR gas readiness; it never submits.
- `quoteMpooBuy({context, inputNearYocto, slippageBps}, signal)` returns a `RheaBuyQuote` or typed error. All on-chain quantities are non-negative integer decimal strings, calculated with `bigint`; display strings are separate.
- `planMpooBuy(quote, verifiedBalances, storageReads)` is pure and returns a `RheaExecutionPlan` with ordered steps, maximum native deposits/gas budget, and preconditions. It must not read or sign inside the builder.
- `executeMpooBuy(plan, dependencies)` executes one checkpoint at a time through the approved gateway. It cannot silently regenerate and submit a replacement trade.
- `resumeMpooBuy(operationId, dependencies)` reconciles recorded hashes/outcomes/balances, returning an updated state without signing.
- `mountRheaPanel(host, dependencies)` returns a disposer that cancels read work/listeners/timers. Closing the panel does not erase unresolved operations.

`RheaBuyQuote` must include context, quote ID, quoted/final expiry time, route manifest hash, per-leg atomic inputs and gross outputs, all pool fees, tax evidence hash, aggregate expected net output, `minNetMpooAtomic`, maximum native spend, storage estimates, gas budget, price-impact estimate and evidence blocks. Unknown tax or unavailable price-impact evidence is a blocker, not zero. `RheaExecutionPlan` records preconditions and the exact approved receiver/method/arguments/deposit/gas for every step.

Submit exactly one checkpoint per gateway request (a checkpoint is defined under **Approval
batching** below); after reconciliation, a re-quoted next checkpoint gets a new quote ID and
explicit review/approval. Do not send a stale whole-route array
or modify transactions inside the gateway. Shared `approval.maxNativeSpendYocto` is a cumulative
all-in native outlay ceiling including wrap input, payable deposits and conservative gas, excluding
untouched reserve. Track consumed/headroom amounts across legs; `VITE_RHEA_MAX_INPUT_YOCTO` limits
trade input only. Neither re-quoting nor a new per-leg prompt resets the operation ceiling.

## Approval batching

Players should approve no more often than on RHEA's own site. Target: a returning player on a
route served by one exchange approves **once**; a first-time player approves **at most twice**.
The review screen states the number of approvals, and evidence records the actual count.

A checkpoint is one of:

- **Registration (first time only):** `storage_deposit` calls for every missing token
  registration, as independent transactions in one gateway request. None depends on another's
  output, so the sequential-submission rule is satisfied. Recheck all registrations after it.
- **Swap:** one transaction to `wrap.near` with two actions in order: `near_deposit({})` attaching
  the approved input, then `ft_transfer_call` to the allowlisted DCL exchange carrying
  `Swap: {pool_ids, output_token, min_output_amount}` across **every consecutive hop on that
  exchange**. Actions in one transaction run in one receipt, so a failed action reverts both. The
  swap itself runs in later receipts: if it fails, `ft_resolve_transfer` returns wNEAR to the
  wallet while the wrap stays done; recovery offers **Unwrap remaining wNEAR**.
- **Next exchange:** only when the route changes exchange (for example a classic
  `v2.ref-finance.near` hop), the next exchange's hops form a new checkpoint with a fresh quote and
  approval, as described in the partial-completion rules.

RHEA-A must verify from the deployed DCL code or a fixture-backed read that a multi-pool `Swap`
either completes every hop or refunds the input, and that `min_output_amount` applies to the final
output. If either is not established, fall back to one checkpoint per hop and record why.

## Quote and tax correctness

v1 uses exact input: the player chooses a maximum native NEAR spend. Do not use DCL `SwapByOutput`, whose semantics with taxed receipts are not established. `minNetMpooAtomic` is the floor of expected **wallet-delivered net output** after the chosen slippage. Fees/taxes already included by a verified quote must not be subtracted twice. Rates use integer basis points, with explicit floor/ceiling rules in tests; no `Number()` conversion for token amounts.

The implementation must establish whether DCL `quote.amount` and `Swap.min_output_amount` measure gross exchange output or net wallet output for the actual mPOO contract. Refresh tax settings at quote time and immediately before signing the final leg; record tax-code/config changes as quote invalidation. A post-swap balance check detects an underfill but does not protect the player from one.

**Production gate:** demonstrate that the transaction's on-chain minimum actually protects the displayed net floor, including the token's exact rounding and configured venue tax. A gross-up conversion is acceptable only when the tax calculation and stability over execution are proven from the deployed contract semantics; checking a mutable tax before signing is not enough to guarantee it will remain unchanged. If net protection cannot be enforced, keep embedded execution disabled and document the narrow external fallback. Do not fix this by weakening the minimum, hiding the tax or shipping a new adapter contract without a separate owner decision.

A route spanning more than one exchange is not atomic. Earlier checkpoints can succeed while the last fails. Every checkpoint needs its own positive executable minimum on its final output, and the review must disclose intermediate assets and possible partial completion. The final aggregate estimate is conditional, not a guaranteed return of the original NEAR if a later leg fails. Never insert a zero minimum merely because an upstream generic router helper does so.

## Transaction construction and execution

Use the existing normal wallet approval path, with the player as signer and recipient. The limited drawing key stays restricted to its existing board and `draw`/`draw_many`; do not add `near_deposit`, `near_withdraw`, token transfers, storage methods or exchange calls to it.

Preparation and each checkpoint are sequential:

1. Acquire the shared capital-operation lock. Refuse another trade/funding conversion/credit purchase that could spend the same balance while approval is pending. Pause local paint submission if the shared policy requires a stable gas budget; do not cancel or lose the drawing.
2. Read account availability and balances at finality. Compute spendable native balance with the shared storage-aware account calculation. Require `availableNative >= inputToWrap + missingStorageDeposits + maximumGasBudget + reserveAfterCompletion`. A “Max” button subtracts all these amounts; it cannot drain the account. Existing wNEAR is displayed separately and never silently spent.
3. Query `storage_balance_of` and `storage_balance_bounds` for required input/refund/output tokens. Register only missing accounts, using the measured minimum and the player's own account ID. Recheck after confirmation. No hardcoded 0.5 NEAR storage deposit. Unknown bounds disable execution. Pre-register recovery tokens before any trade so failed transfers can return funds.
4. Wrap only the approved native amount with `wrap.near::near_deposit({})`, attaching that amount, as the first action of the swap transaction (see **Approval batching**). Confirm its receipts and re-read the wallet's wNEAR balance afterwards. The wrap may remain completed if the swap is refunded.
5. Before each swap checkpoint, re-read context, available balance, previous checkpoint, current route/tax settings and quote expiry. Re-quote the remaining route against the actual amount received. If the original overall input cap or agreed net floor cannot be met, stop and request a new review; no silent acceptance of a worse rate.
6. For a validated DCL leg, use the reviewed wire shape: call input token `ft_transfer_call` with `receiver_id` equal to the allowlisted DCL exchange, integer `amount`, and `msg` containing `Swap: {pool_ids, output_token, min_output_amount}`. Attach exactly 1 yoctoNEAR. For a classic leg, use its own reviewed `actions` message with numeric `pool_id`, exact token IDs, input and positive minimum. Validate emitted actions after any helper runs; SDK objects are not trusted instructions.
7. Reconcile *all* receipt outcomes and FT resolver results. A top-level successful hash can still represent a refunded swap. Read relevant wallet FT balances and, where applicable, exchange `list_user_assets`/classic deposits. Use the received amount supported by operation receipts/events and reconciled balances; unrelated incoming transfers must not manufacture a successful fill.
8. Save the completed checkpoint before generating the next approval. Every remaining input is bounded by the approved plan and the reconciled wallet balance, never merely by the original quote. On the final leg, success requires verified net mPOO delivery meeting the agreed floor. Refresh native NEAR/mPOO wallet state; do not alter credits or paint state.

Set prepaid gas by the reviewed method/receipt budget, bounded by protocol limits, and reserve the conservative maximum monetary gas cost using the shared policy. Do not copy the SDK's gas constants without measuring the actual route. The user pays gas even for a failed transaction; storage and refundable attached amounts are different line items.

## State, persistence and recovery

State progression: `unavailable → idle → quoting → review → preparing → awaiting_approval → submitted → reconciling → next_leg_review | complete | partial | refunded | failed | unresolved`.

- `cancelled` is allowed only before that step broadcasts. After broadcast the panel can close but cannot promise cancellation.
- Record operation context, schema version, route/evidence hashes, quote, accepted limits, initial token balances, step index, checkpoint balances, submitted hashes, receipt result and timestamps in the shared operation store before each redirect. Do not store raw keys, auth tokens or provider credentials.
- A rejected approval preserves already acquired assets and stops. It does not automatically unwind them.
- A timeout or RPC error after possible broadcast becomes `unresolved`; disable retry of that step until transaction/receipts or wallet activity resolve it. Reloading resumes read-only reconciliation. An absent callback hash alone is not proof that nothing was sent.
- `refunded` requires resolver/receipt and balance evidence; show the returned asset and amount. A partial refund is displayed as partial, including any venue-tax loss. Do not promise that all failed swaps refund the original input.
- `partial` lists the exact wallet/exchange-held intermediate assets and completed steps. Provide “Continue with a new quote” only after reconciliation and a fresh explicit approval. Provide “Unwrap remaining wNEAR” through a separate reviewed `near_withdraw` transaction, with its own fee and reserve check. Any exchange-withdrawal recovery requires known ABI and a separately reviewed plan. No forced sale, automatic reverse swap or automatic retry.
- Account switch hides the old operation's actions and balance claims; its persisted evidence remains accessible after switching back. Sign-out disconnects signing but retains unresolved operation records. Another tab must not submit the same operation twice.

## UI requirements

Entry: “Buy mPOO” in the wallet's acquisition section, independently gated from mPOO credit payments. Keep “Buy mPOO on Nearly” as a fallback. Do not show a production swap on a testnet game without an explicit separate mainnet context; v1 simply disables that combination.

Review shows: native NEAR input cap; estimated and minimum net mPOO; route; trading tax; pool fees/price impact; storage charges; estimated gas plus reserve left; number of approvals and the fact that steps can partially complete. Label unknown values unavailable. Route details can expand; critical minimum/cost/partial-completion terms remain visible. Disable submit when account initialization, native reserve, route, metadata, tax protection or limits are invalid. Quote changes require re-review. No fake “0% fee” or “guaranteed credits” copy.

Progress names the actual step (“Register mPOO balance”, “Wrap NEAR”, “Swap DIARHEA for mPOO”, “Checking received mPOO”). Use keyboard-accessible controls, labelled fields, focus return, `aria-live` progress, narrow-screen layouts and explicit `[hidden]` styling. Do not render arbitrary token icons/HTML or external server errors as markup. Stop polling on dispose; resume unresolved operations when reopened.

## Acceptance tests

Focused suites must prove meaningful boundaries, with fixtures matching the actual provider wire shape:

1. Integer precision above `Number.MAX_SAFE_INTEGER`; 18/24-decimal inputs; rejection of negatives, exponent notation, fractional atomic values and excess display precision.
2. Historical route is not treated as live. Wrong pool token, route direction, exchange, code/tax evidence, zero/absent liquidity or unknown metadata blocks planning.
3. Tax applied once, exact rounding, changed tax/config invalidation, gross-versus-net mismatch, and net floor that cannot be enforced disables submit.
4. Gas/storage reserves protect native balance; “Max” cannot consume the reserve; an unfunded account cannot register/wrap/swap; existing wNEAR remains untouched unless explicitly approved.
5. Every generated transaction is allowlisted and uses exact integer arguments/deposits. No calls reach drawing-key signer, board purchase methods, arbitrary receivers or a relayer.
6. Wrap succeeds and first/last swap rejects; intermediate balance recovery survives refresh. No operation success when token resolver refunds or an inner receipt fails.
7. Unknown broadcast, popup closed, duplicate callback, reload, account/network switch, cross-tab duplicate execution and request races cannot produce duplicate trades.
8. Actual balance below displayed floor becomes an underfill failure with evidence, never “swap complete”; unrelated incoming mPOO alone cannot satisfy a fill.
9. Closing/reopening preserves drawing and operation; native and mPOO refresh independently of credits; acquiring mPOO does not enable the token-payment flag.
10. Mainnet manifest is rejected on testnet; feature disabled/unconfigured remains readable with an honest fallback.

Run focused tests, then `npm test` and `npm run build` from `web/`, plus repository-required CI. Browser-check 390 px and desktop review/progress/recovery views. Unit fixtures prove logic only; record their limits.

Live acceptance is a separate owner-approved, capped small mainnet trial because mPOO liquidity is on mainnet. Evidence must include exact tested build/route hashes, wallet approvals, route transactions/receipts, pre/post native and token balances, tax/fee output, resolver behaviour and net floor verification. First rehearse with deterministic fixtures and configured testnet pools where possible. Do not manufacture a slippage failure with uncontrolled funds. The milestone is one successful funded player acquisition and a proven safe unresolved/partial recovery path; it does not claim MPOO credit checkout, painting or the board's mainnet deployment is released.

## Delivery order and handoff

1. **RHEA-A:** read-only discovery + manifest validator + quote/tax proof. Submit evidence and blockers; execution stays disabled.
2. **RHEA-B:** pure planner + controller/recovery with injected gateway, all negative-path tests. No UI coupling or wallet scope changes.
3. **RHEA-C:** panel mount through integration owner, browser checks, ordinary-wallet and Privy connector compatibility tests.
4. **RHEA-D:** approved bounded live trial, independent revision-bound review, release configuration and explicit feature enablement.

An implementation agent can complete A–C without spending money or changing game contracts. If tax protection or routing is blocked, deliver the disabled integration, evidence and precise unresolved question; do not report live trading as done. PR description must name this work ID, exact base/head, checks, source revision, remaining live gates, and repository-required `Learned` entry. The merge owner updates backlog status; this agent does not edit the shared backlog from a parallel PR.

## Primary sources

Sources checked 3 November 2026; refresh deployed state and source revisions at implementation time.

- [RHEA SDK package metadata, pinned source](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/package.json) — compatibility baseline, not a dependency recommendation.
- [DCL quote/transaction helper, pinned source](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/dcl-swap/swap.ts) — inspected wire calls and distinction between quote and execution.
- [DCL pool reads, pinned source](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/dcl-swap/dcl-pool.ts) — candidate discovery; live route still requires evidence.
- [Classic swap helper, pinned source](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/v1-swap/instantSwap.ts) — classic message compatibility only; v1 does not adopt its generic zero-intermediate-minimum policy.
- [Token/storage/wrap reads, pinned source](https://github.com/ref-finance/ref-sdk/blob/8dcb4fb47d3bf5212bdbd94a96c5afa8c7365a7d/src/ref.ts) — method names and adapter baseline; avoid the helper's “read error becomes zero” behaviour.
- [Nearly product documentation](https://nearly.trade/docs) — linked for operator reference; no readable content was returned by this research tool. No present tax or refund claim rests on that page.
- Local historical evidence: [MPOO readout](../archive/research/2026-10-12-mpoo-live-contract-readout.json). Archived material is used to locate the token/pool, not to revive its superseded economy rules.
