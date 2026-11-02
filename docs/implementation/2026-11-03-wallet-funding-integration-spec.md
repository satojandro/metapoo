# Wallet onboarding and acquisition — integration contract

Date: 3 November 2026. Status: implementation specification; no integration or live-payment proof is claimed.

This is the entry point for implementing three owner-requested capabilities:

1. [Privy through NEAR Connect](2026-11-03-privy-near-connect-spec.md).
2. [Cross-chain funding through Intents](2026-11-03-intents-funding-spec.md).
3. [Acquire mPOO through RHEA](2026-11-03-rhea-mpoo-swap-spec.md).

Dispatch order and acceptance are also recorded in [the task manifest](wallet-acquisition.tasks.json).
That manifest is a human/agent work breakdown, not an executable orchestrator configuration.

## 1. Decisions and scope

The owner's 3 November instructions authorize specifying Privy login, account funding through Intents,
and embedded RHEA mPOO acquisition. They supersede the earlier link-only acquisition direction for
these features. They do not change the paid-board economy or authorize contract changes/deployment.

- Players pay their own gas from their own native NEAR account. No sponsor, relayer, treasury-funded
  bootstrap, delegate-action path, or server-controlled player key is introduced.
- Preserve the existing browser-held drawing key, restricted to the configured board's `draw` and
  `draw_many` methods with its existing allowance. Drawing already works without repeated wallet
  popups. This is not work to rebuild that feature or expand its authority.
- Privy is an additional wallet provider through NEAR Connect. Existing wallets remain available.
- Intents funds the player's account in a supported asset route ending in usable native NEAR.
  mPOO is excluded from Intents by product decision. Do not wait for or pursue its listing.
- RHEA is the mPOO acquisition venue. Do not assume a direct NEAR/mPOO pool; resolve the verified route.
- Acquired funds belong to the player. Funding and swapping do not buy credits, paint a pixel, grant
  an access key, or change game accounting automatically. Each next action requires its own consent.
- Existing NEAR and direct mPOO credit checkout remain separate. Retain the current mPOO checkout
  feature flag, daily caps and board-token checks. Acquisition must work independently of whether
  mPOO credit sales are currently enabled.
- No general DEX, selling mPOO, inventory shop, staking, automatic top-ups, fiat on-ramp, or redesign.

This specification authorizes implementation preparation. A release is not approved by writing it.
Live asset transfers/swaps and production configuration are distinct from source edits and tests.

## 2. Verified starting point and mandatory rebase check

GitHub `main` was read at `7e123621c31206ab1c8f5f502ccf2ef3ed3aeb46` (PR #52, wall Phase 1 step 4).
The authoring checkout is `59cac46` on `codex/adm-1-admin-dashboard`, which predates that main.
Only documentation is changed here. Do not implement from this old branch without reconciling main.

Read `AGENT.md`, `docs/learning/traps.md`, `docs/README.md`, `docs/roadmap.md`, and
`docs/00-shared-decisions.md` before coding. Record the current target SHA and changed integration
seams in the implementation PR. The spec's file paths identify responsibilities, not permission to
overwrite later work. Follow the current wall/dock design tokens and page structure.

Existing seams to reuse:

| Seam | Existing responsibility |
|---|---|
| `web/src/wallet.ts` | NEAR Connect identity, restoration, explicit drawing-key authorization, ordinary wallet transaction approval |
| `web/src/drawing-session.ts`, `local-draw.ts`, `submit-draw.ts` | scoped local signing, allowance/nonce checks, paint submission and confirmation |
| `web/src/app/wallet-chrome.ts`, `paint-wallet-panel.ts`, `shell.ts` | persistent identity controls, balances panel, application shell |
| `web/src/paint-wallet.ts` | account/token reads and integer unit formatting; `availableNear` excludes storage backing, before gas |
| `web/src/submit-buy-credits.ts` | existing purchase confirmation, current price, registration and balance refresh |
| `web/src/config.ts`, `payment-flags.ts`, `web/.env.example` | network, RPC, board and feature configuration |
| `web/src/polyfills.ts`, `web/vite.config.ts` | browser signing dependencies and build entry points |

No contract file is in the implementation scope. The current mPOO receiver rejects routed deposits;
do not weaken its `sender_id == signer_account_id` condition to make swaps appear composable.

## 3. Product flow

The wall remains the first view. Add acquisition controls inside the existing account/balances panel:

- **Add funds**: network and source-asset choice, quote, source-chain send instructions, resumable status.
- **Buy mPOO**: NEAR input, received-mPOO minimum after applicable tax, gas/storage breakdown, approval.
- **Buy credits**: the existing checkout, re-entered explicitly after funding/acquisition.

Preserve selected cells, colour, Look/Paint state, viewport and unsent stroke across popup/redirect
flows using the existing restoration mechanisms or a bounded serializable draft. Restoring a draft
must never submit it. Do not place a blocking acquisition overlay over the wall or alter camera maths.

Disconnected players can explore. New social-login accounts may be absent on chain or have no NEAR.
Represent identity, account readiness, spendable balance and drawing-key authorization separately.
The UI must not call an unfunded identity a ready-to-paint account.

## 4. Shared interfaces — foundation owner only

The following are proposed repository APIs, not assertions that vendor SDKs already expose them.
The foundation owner implements them and their tests first; feature agents consume them through
injected dependencies. Equivalent implementation detail is acceptable if all specs are updated
together before feature work diverges. Do not create three independent wallet/balance abstractions.

### Identity context (`web/src/integrations/types.ts`)

`OperationContext` contains `operationId: string`, `accountId: string`,
`networkId: "mainnet" | "testnet"`, and `sessionEpoch: number`.

The integration owner maintains a monotonically increasing in-memory session epoch on disconnect,
provider switch, account switch and network change. Capture context when the user starts an action.
Revalidate identity and epoch before opening a wallet, after each awaited operation, and before
rendering its result. Do not add Privy-specific fields to the existing `WalletSession` contract.

After a reload, old provider records may be reconciled read-only under their persisted account/network,
but an old session epoch is never reused as signing authority. A deliberate Resume constructs fresh
context and requires a matching active identity. A currently connected different account must not
inherit the old operation, deposit recipient, quote or approval.

### Account readiness (`web/src/integrations/account-readiness.ts`)

`resolveAccountReadiness(accountId, networkId)` returns a discriminated result with `state` equal to
`absent`, `initializing`, `ready`, or `unavailable`; the account/network; observation time/block; and,
when ready, exact decimal-string `nativeAmountYocto`, `lockedYocto`, `storageRequiredYocto`, and
`spendableBeforeGasYocto`. `ready` means the account and relevant keys exist, not that it has enough
money for every action. Only a recognized unknown-account RPC error means absent; timeout is unavailable.

An `initializing` state requires a recorded activation transaction being reconciled; it is not a
guess based on a zero balance. For a Privy implicit account, verify the expected public key as well
as account existence before enabling AddKey or capital-spending calls.

### Native gas budget (`web/src/integrations/gas-budget.ts`)

`computeSpendableNative(input)` returns a breakdown and `maxInputYocto`, all integer decimal strings.
Input contains the readiness snapshot, the plan's payable deposits, quoted gas ceiling using current
gas price and documented headroom, exact outstanding storage-registration deposits, and an explicit
post-operation play-gas reserve. Deduplicate payable amounts already included in the plan.

Compute liquid balance from the existing storage-aware `availableNear` semantics before subtracting
new outlays. Preserve full 24-decimal precision; never parse its human display string as a rounded
number. A gas allowance is a permission limit, not an escrow balance. Do not subtract an entire key
allowance as though those tokens were locked.

`maxInput = max(0, liquid - other payable deposits - gas ceiling - play-gas reserve)`.

Configure the reserve explicitly and disclose it in the UI. Do not invent a permanent hardcoded
gas cost. Missing/old balance or gas information disables spend rather than falling back to zero
reserve. Recompute just before signing and between non-atomic stages. Other tabs/devices can spend
the same account; these are preflight checks, not a chain-enforced reservation.

### Approved NEAR transactions (`web/src/wallet.ts`)

Add `signAndSendApprovedTransactions(request: ApprovedTransactionRequest)` for acquisition only.
It must use the connected wallet provider's ordinary signing path, never `local-draw.ts`.

| Request field | Contract |
|---|---|
| `context` | `OperationContext` above |
| `purpose` | `funding-unwrap` or `mpoo-acquisition` |
| `transactions` | ordered `ApprovedNearTransaction[]`, each `{ receiverId, actions }`, using the installed NEAR Connect action types |
| `approval` | `{ summary, maxNativeSpendYocto, quoteId?, expiresAtMs? }` describing the user-approved plan |

`maxNativeSpendYocto` is the cumulative operation's all-in native outlay ceiling: trade/wrap input,
registration and security deposits, and conservative gas ceiling, excluding the untouched play-gas
reserve. Track confirmed outlays and remaining headroom across checkpoints. A new per-leg quote or
wallet approval cannot reset this ceiling; raising it requires an explicitly revised operation review.

Do not accept arbitrary remote transactions as trusted plans. Independently validate receiver,
method, arguments, amount, gas, storage deposits and route against the feature's reviewed allowlist.
No AddKey, DeleteKey, transfer to a server treasury, full-access key, or unbounded allowance belongs
in this gateway. Drawing-key setup/revocation stays in its existing explicit flow.

The gateway validates context, readiness, reserve and approval, then submits each transaction in
order. Persist the attempt before invoking the provider. Reconcile all relevant receipts before
continuing; do not pass dependent stages to an API that may submit them concurrently. Revalidate
the plan and tax/quote freshness between stages. If changed, stop for a new explicit approval.

Return a record for each attempted step with transaction hash when available and status
`confirmed`, `failed`, or `unknown`, plus completed-step count. A user rejection before sending is
distinct from an attempted broadcast with an unknown result. Failure after an earlier confirmed
step is partial completion, not rollback. No automatic resubmission or provider fallback after a
possible broadcast. Read-only polling and transaction lookup may retry with bounded backoff.

For RHEA, the controller submits exactly one checkpoint in each gateway request: a set of independent
storage registrations, or one multi-action transaction to a single receiver (see the RHEA spec's
**Approval batching**). It then reconciles the received assets and shows a fresh review before
requesting the next approval.
Do not submit an original whole-route transaction array and later mutate it inside the gateway.
Each leg's minimum protects that leg only; a later failure leaves intermediate assets and cannot
promise a rollback or full refund of the original native NEAR.

NEAR Connect cannot send Ethereum, Solana or Bitcoin transactions. Initial Intents source funding
uses copy-address/QR instructions and an external source wallet; adding source-wallet SDKs is a
separate extension. Warn about source-chain fees and memo requirements before a user sends funds.

### Operation ledger (`web/src/integrations/operation-store.ts`)

Persist a versioned envelope containing operation ID, feature (`intents` or `rhea`), account, network,
creation/update times, phase, provider-record ID and known transaction references. Each feature owns
its provider-specific details. Validate loaded JSON, size and version. Store no auth tokens, key
material, partner keys or unrestricted signing payloads in this ledger.

Retain nonterminal operations until reconciled; do not expire an in-flight deposit just because its
quote time has passed. Terminal records may be cleared explicitly. A corrupted record disables
automatic resume but shows a recovery path with known public transaction/deposit references.

Use a cross-tab single-writer claim for capital actions (Web Locks when available, an expiring
owner/heartbeat claim otherwise). On an uncertain stale claim, reconcile before offering takeover.
This prevents accidental duplicate UI sends, not hostile replay or another device spending.

### Refresh and disposal

Feature controllers expose `onBalancesChanged({ accountId, networkId, operationId })` after a
confirmed relevant chain change. The integration owner invalidates/reloads matching NEAR, mPOO,
registration and credit snapshots using existing controllers; do not optimistically increment them.
Unchanged credits after acquisition are correct. Never refresh a new account with an old result.
Abort reads/timers on disposal; preserve resumable records. Background throttling is not failure.

## 5. Files and parallel ownership

| Work item | Exclusive writes | Dependencies |
|---|---|---|
| ACQ-0 foundation/integrator | `integrations/types.ts`, `account-readiness.ts`, `gas-budget.ts`, `operation-store.ts`; `wallet.ts`; shared config/env/type declarations; app shell/chrome/balance panel wiring; package/lock/Vite changes | current main review |
| ACQ-1 Privy agent | `integrations/privy/**`, `privy-sign.html` and feature tests | ACQ-0 interface commit; asks integrator to wire build/config/manifest |
| ACQ-2 Intents agent | `integrations/intents/**`, dedicated panel/styles/tests and fixtures | ACQ-0; can test with fake identity without ACQ-1 |
| ACQ-3 RHEA agent | `integrations/rhea/**`, dedicated panel/styles/tests and route evidence | ACQ-0; existing wallet path works without ACQ-1/2 |
| ACQ-4 integration/review | shared wiring, journey tests, docs evidence | ACQ-1/2/3 reviewed commits |

The feature specs refine owned paths. Any shared-file change is a patch request to the integrator,
not a concurrent edit. Do not concurrently modify one checkout's branch/index. During implementation,
use isolated feature worktrees or staged disjoint changes coordinated by the integrator. Each code
PR names its exact base/head, dependencies and checks. Follow AGENT.md: meaningful code uses a PR;
backlog status is updated on main by the merger. Docs-only work follows the docs convention.

## 6. Feature flags and configuration contract

Foundation adds separate fail-closed flags `VITE_PRIVY_ENABLED`, `VITE_INTENTS_FUNDING_ENABLED` and
`VITE_RHEA_MPOO_SWAP_ENABLED`, default false. Vendor public IDs and per-network endpoints come from
the feature specs. Private credentials never use the `VITE_` prefix or enter the browser bundle.
Preserve `TOKEN_PAYMENTS_ENABLED` independently. Do not enable `SPONSORSHIP_ENABLED`.

An enabled flag alone cannot pass capability gates. Validate network-specific contracts, provider
configuration, route/tax proofs and budget settings. Mainnet integration must never send funds to
a testnet board/account. On testnet, Intents is unavailable and RHEA token rehearsals must say
test token rather than mPOO; never silently invoke mainnet from a testnet page.

Feature flags may disable new quotes/signatures while reconciliation of existing operations remains
available. Do not strand deposits by hiding their status when a feature is turned off.

## 7. Required tests and evidence

Unit/controller tests must exercise money/identity boundaries, not duplicate markup. Preserve the
existing wallet restoration, local-draw, stroke, checkout and balance tests.

| Level | Required evidence |
|---|---|
| Foundation | exact amount parsing; no gas/allowance double counting; reserves and Max; account absent vs RPC failure; account/network/epoch change before/after awaits; stale/corrupt persistence; duplicate cross-tab action; unknown broadcasts stop dependent sends |
| Feature | each feature spec's rejection, pending, timeout, partial completion, refund and receipt tests with versioned primary-source-shaped fixtures |
| Browser | popup blocked/closed, refresh/return, expired Privy auth, 390 px and desktop, keyboard/focus/live status; no acquisition panel covers wall; unsent drawing restored but not sent |
| Build | from `web/`: focused tests, full `npm test`, `npm run build`; no browser-externalized Node dependencies; CI green |
| Existing-wallet testnet | limited key methods/allowance unchanged, normal and session paint, nonce/allowance before/after, receipt plus pixel readback; new provider does not regress existing wallets |
| Privy testnet | new and returning social account, activation/funding, AddKey, refresh, local draw, on-chain revoke; chain proof and no sponsor |
| Intents mainnet gate | separately authorized bounded source transfer; destination native account/key/balance proof; expiry/refund support evidence; no testnet claim |
| RHEA mainnet gate | current route/pool/tax reads and bounded swap approved by owner; all receipts and attributable net mPOO delivery; native balance retained |
| Combined journey | login → fund → explicit swap → explicit credits purchase (if enabled) → local paint → refresh → second browser sees result; correlate each step independently |

Record verification status as specified / fixture-tested / built / browser-tested / chain-verified.
Never describe fixture success as live settlement. Each regression test names the concrete failure
it prevents. A newly added feature need not fail the old tree by importing a nonexistent module;
demonstrate the missing behaviour through its integration seam.

## 8. Hard release gates and stopping conditions

1. **Native NEAR bootstrap:** Intents must prove native delivery to the exact Privy account type,
   including a fresh implicit address that is not yet on chain (the new-player case; a native
   transfer creates it). wNEAR alone cannot fund an account that has no native NEAR to pay for
   unwrapping. Until proven,
   offer direct native NEAR receive instructions; do not advertise zero-balance Intents onboarding.
2. **mPOO net minimum:** RHEA's ordinary gross pool minimum is not proof of a post-tax wallet minimum.
   If the selected route cannot enforce the disclosed net minimum under the token's actual tax
   semantics, stop the embedded swap release and document the narrow follow-up. No new contract
   adapter is authorized here. Keep the existing external acquisition link as fallback.
3. **Unknown broadcast:** keep recovery read-only until the original transaction/deposit is resolved.
4. **Identity/config mismatch:** disable signing/quote creation, keep old-account records readable.
5. **Credentials/config missing:** finish all unaffected code and fixtures; report the exact missing
   public IDs, dashboard settings, backend endpoint or runtime configuration. Do not claim ready.

## 9. Agent handoff and completion template

An implementing agent should begin with: “Implement ACQ-N from this entry point and its feature spec;
read the repository instructions; preserve player-paid gas and current drawing-key scope; do not
deploy or spend funds.” It should read the manifest, verify current main and dependent commits, and
work only in the assigned paths. The integration agent owns dependency and UI consolidation.

Every handoff/PR includes: exact base and head; changed paths; concrete new behaviour; focused/full
checks; browser evidence; any chain transaction/block/account evidence; configuration variables
without secrets; unresolved gates; rollback flag; and `## Learned`. Include the backlog status change
in the PR description, not a parallel edit to `docs/backlog.md`. Do not merge or release as an implied
side effect of finishing implementation.

## 10. Sources and evidence boundaries

- [Meta Poo baseline](https://github.com/satojandro/metapoo/tree/7e123621c31206ab1c8f5f502ccf2ef3ed3aeb46).
- [NEAR Privy integration](https://docs.near.org/web3-apps/tutorials/privy).
- [Privy connector source](https://github.com/beneviolabs/privy-near-connect).
- [NEAR function-call keys](https://docs.near.org/web3-apps/tutorials/wallet-login#function-call-keys-at-login).
- [1Click integration](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api)
  and [FAQ: no testnet](https://docs.near-intents.org/resources/faqs).
- [RHEA SDK](https://github.com/ref-finance/ref-sdk).

Feature specs pin more precise provider evidence. Recheck vendor APIs and release versions before
installation; a documentation example, manifest capability, or historical on-chain read is not a
new live compatibility proof. Archived MPOO route/tax readouts are research inputs only, not current
configuration authority.
