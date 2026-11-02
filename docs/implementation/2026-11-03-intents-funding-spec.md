# INTENTS-1 — Fund a player's NEAR account through 1Click

Date: 3 November 2026. Status: implementation specification, not an integrated or live-tested feature.
Read the companion integration plan first. Product constraints: players pay their own gas; mPOO is
not an Intents destination; no relayer, sponsor, game-contract change, or automatic credit purchase.

## Outcome and boundary

A connected player opens **Add funds**, chooses a supported source asset/network, obtains a quote,
sends the specified amount from an external wallet, and returns to a verified NEAR balance. Keep
the wall/drawing mounted and preserve its draft. Funding never marks a pixel or a credit purchase
successful. **Buy credits** and **Buy mPOO** are explicit next actions.

The first version supports copying the deposit address/amount/memo and a QR code. NEAR Connect
does not provide EVM, Solana, Bitcoin, or exchange signing: those transfers happen in the player's
chosen source wallet. Do not add a second wallet SDK or imply an in-game source-wallet approval
exists. An optional later source-wallet adapter is a separate work order.

## Baseline and prerequisites

Repository examined: local `59cac46`; coordinator verified remote main
`7e123621c31206ab1c8f5f502ccf2ef3ed3aeb46`. Rebase implementation on the live default branch and
recheck paths before coding. Read `AGENT.md`, the documentation map, traps and current decisions.

- `web/src/wallet.ts`: connected identity and existing NEAR approvals; do not duplicate its session.
- `web/src/paint-wallet.ts`: existing exact balance formatting and storage-aware NEAR availability.
- `web/src/config.ts`: page network defaults to testnet; connector network fallback is not permission
  to use mainnet. Gate on the actual page/account network and feature flag.
- `web/src/app/paint-wallet-panel.ts`: existing panel integration surface; coordinator owns edits.
- `web/src/submit-buy-credits.ts`: separate checkout; funding agent must not change its economics.

Consume coordinator-owned `OperationContext` from `web/src/integrations/types.ts`:
`operationId`, `accountId`, `networkId`, `sessionEpoch`. Validate context before rendering a payable
address, before new quotes/payable actions and after every asynchronous result. Historical status
reconciliation remains read-only and available after logout or account changes. Account/network/epoch
changes invalidate live forms; a previously funded operation remains recoverable under its original
identity. Never silently retarget an existing deposit address to a new account.

## Provider facts and unresolved native-NEAR gate

Checked against primary sources on 3 November 2026:

- 1Click exposes token discovery, quote and status endpoints. Quote requests identify source and
  destination assets, recipient and refund destination; a preview has no payable address. Amounts
  are smallest-unit integer strings. Use `ORIGIN_CHAIN` deposit and `DESTINATION_CHAIN` recipient,
  not an internal Intents balance. [Quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- Partner JWTs can use `X-API-Key`; `Authorization: Bearer` is also accepted. This is integration
  authentication, not player authentication. Keep credentials out of the frontend.
  [API authentication](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication)
- Exact-input fixes the source amount; exact-output fixes the requested destination amount.
  Slippage uses basis points. Underpayments/excess have mode-specific refund treatment.
  [Swap modes](https://docs.near-intents.org/integration/distribution-channels/1click-api/swap-types)
- `nep141:wrap.near` represents wNEAR in the Verifier. Managed integrations handle wrapping, but
  that statement alone does not prove the form of a destination withdrawal.
  [NEAR token guide](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/near-token)
- The protocol has a native withdrawal primitive. Its existence does not prove that the selected
  1Click route uses it. Rust documentation warns native withdrawal to a nonexistent receiver can
  fail without refund. Never infer account creation from a successful social login.
  [NativeWithdraw](https://near.github.io/intents/defuse_core/intents/tokens/struct.NativeWithdraw.html)
- Production settlement has no testnet. [FAQ](https://docs.near-intents.org/resources/faqs)

**Release gate INT-NATIVE:** Before enabling a real payable quote, establish whether a selected
`nep141:wrap.near` destination delivers native NEAR or wNEAR to the player's external account.
Record the exact API/SDK revision, request/response, initialized receiver type, withdrawal transaction
and final native/FT reads. The gate applies separately to initialized named and implicit accounts.
Do not treat the symbol `NEAR` or `wNEAR` as evidence of the delivered form.

Supported resolution:

1. If direct native delivery is proven, configure `deliveryMode=native`; account initialization must
   still be verified before producing a payable quote.
2. If delivery is wNEAR, use `deliveryMode=wrapped_then_unwrap` **only for an initialized account
   already holding sufficient native NEAR** for storage/unwrap gas. Read `storage_balance_bounds`
   and registration status; do not assume provider-paid token registration. Make prerequisite
   costs visible before deposit. After settlement, offer explicit wallet-approved `near_withdraw`
   on `wrap.near`, attaching the documented 1 yoctoNEAR and measured gas. The drawing key cannot
   authorize it. Use the shared approval gateway, re-read balances, and require a successful
   receipt before the native balance confirmation.
3. If native gas or account initialization is missing and direct native delivery has not been
   proven, block the payable Intents route with **First receive a small amount of NEAR** and offer
   the direct NEAR receive address. This is an honest prerequisite, not sponsorship.

Do not add Verifier-account creation, signed-intent execution, a custom withdrawal router, or a
service-funded bootstrap to work around this gate. Local fixture work can proceed while it is open.

## Files and ownership

Agent-owned new files:

| File | Responsibility |
|---|---|
| `web/src/acquisition/intents-types.ts` | Validated provider DTOs and funding state union |
| `web/src/acquisition/intents-client.ts` | Fetch wrapper, runtime validation, aborts and error classification |
| `web/src/acquisition/intents-quote.ts` | Exact decimal parsing, immutable request construction, quote checks |
| `web/src/acquisition/intents-funding.ts` | Controller and state transitions |
| `web/src/acquisition/intents-storage.ts` | Versioned provider details keyed by operation id |
| `web/src/acquisition/intents-receipt.ts` | Destination evidence reconciliation |
| `web/src/app/intents-funding-panel.ts` and `.css` | Accessible panel with mount/dispose boundary |
| Matching `.test.ts` files | Cases below |

Coordinator owns shell entry points, `config.ts`, environment typings/example, wallet gateway,
`integrations/account-readiness.ts`, `gas-budget.ts`, `operation-store.ts`, shared styles and docs
index. Propose a wiring patch after local tests; do not race other agents editing those files.
The controller receives shared reads/storage/events by dependency injection. It must not become a
second authoritative wallet/balance implementation.

Required public controller methods: `loadAssets(signal)`, `preview(input, context, signal)`,
`commit(previewId, context, signal)`, `resume(operationId, context, signal)`, `refresh(operationId)`,
`dispose()`. Return validated immutable snapshots; do not expose provider objects for UI mutation.
Emit `onBalancesChanged(context)` after reconciliation so the shared wallet display reloads.
For the optional explicit unwrap, consume the coordinator's
`signAndSendApprovedTransactions({ context, purpose: "funding-unwrap", transactions, approval })`.
The approval carries `summary`, `maxNativeSpendYocto` and optional `quoteId`/`expiresAtMs`; each
transaction contains its approved `receiverId` and NEAR Connect actions. Handle per-transaction
`confirmed`, `failed` and `unknown` outcomes. An unknown broadcast cannot be automatically retried.

## Configuration and transport

Public configuration proposed to coordinator:

- `VITE_INTENTS_FUNDING_ENABLED=false` by default; requires mainnet page and mainnet account.
- `VITE_INTENTS_API_BASE=https://1click.chaindefuser.com`; allowlisted HTTPS origin only.
- `VITE_INTENTS_TRANSPORT=direct` or `proxy`; `VITE_INTENTS_PROXY_BASE` only when proxy deployed.
- A reviewed source-asset allowlist (exact `assetId` plus blockchain), validated against fresh
  `/v0/tokens`; start with one source route proven by evidence, rather than a static broad promise.
- Reviewed `deliveryMode` and evidence reference; no environment value can bypass missing evidence.

No `VITE_*` partner secret. Initial direct mode uses unauthenticated endpoints and presents the
returned total without inventing a fee discount. A keyed mode requires a separately deployed
same-origin proxy with server-only `INTENTS_PARTNER_JWT`, fixed upstream/path allowlists, body size
and schema validation, timeouts, per-client rate limits and restricted CORS. It neither signs nor
holds funds. Proxy token/quote/status and optional deposit-submit endpoints only; no arbitrary URL
fetch or arbitrary authorization forwarding. A static Vite build alone cannot hide a key.

Choose plain fetch with a narrow typed adapter unless a pinned official SDK has an evidenced
advantage. Save sanitized schema fixtures and dependency revision. Current authentication docs
resolve earlier Bearer-vs-key examples; test the chosen mode explicitly. Provider contract changes
must fail closed, not strip safety fields or send unknown defaults.

## Quote and deposit protocol

1. Resolve account readiness and gas prerequisites. Select assets from a fresh validated list;
   require supported metadata/decimals. Never identify assets by symbol alone or include MPOO.
2. Require source chain, asset, positive decimal input, and a source-chain refund address controlled
   by the player. Parse decimals to integer strings exactly; reject rounding, negatives, exponent
   notation and excess precision. Explain that sending from an exchange needs a valid refund
   address; never assume its deposit address accepts protocol refunds.
3. Launch with `EXACT_INPUT`. Send `dry=true`, explicit deposit/recipient/refund types, immutable
   NEAR destination account, source refund address, configured slippage, bounded deadline and no
   app fees. Exact-output is an optional later mode with distinct tests, never a silent fallback.
4. Show **You send**, **Estimated received**, **Minimum received**, network/provider costs, refund
   destination and estimated wait. Requote on any edit; a prior quote cannot remain confirmable.
   Default slippage policy is 100 bps with no automatic widening; changing it requires an explicit
   new player confirmation. A no-route/minimum error is not permission to increase input.
5. On **Get payment address**, recheck identity/readiness and commit with `dry=false`. Re-review
   material changes from the preview. Do not display/copy the address until the committed response
   passes schema, recipient/refund/amount/asset checks, signature policy and durable persistence.
6. Render the exact source network, amount, address and mandatory memo/tag separately; copy each
   and offer **Copy payment details**. A QR must include only a supported chain payment URI or a
   clearly labelled address-only payload; a generic address QR does not encode memo or amount.
   Never claim exchange auto-fill. Escaped text only; no provider HTML or unchecked explorer URLs.
7. The address is quote-specific. Show the provider's earliest actionable expiry
   (`deadline`/`timeWhenInactive`) with a safety margin for the selected source network; stop new
   sending instructions when that margin is crossed. A changed deadline never edits an old quote.
8. Poll `/v0/status` by deposit address and memo where present. A player may optionally supply an
   origin transaction hash; submitting it assists discovery but is not payment proof. Omit this
   convenience if hash validation/ownership cannot be made clear.

Use a 15-second fetch timeout and jittered exponential backoff, starting at 3 seconds and capped at
30 seconds, honoring `Retry-After`. Do not launch overlapping polls. Pause background polling on
hidden tabs; reconcile on visibility, reconnect and resume. Rate-limit failures keep recovery data.
All timers/listeners/fetches must be disposed on unmount; provider settlement continues independently.

The API supports signed payload verification. Use the official SDK's `verifyQuoteSignature()`
(documented minimum version 0.1.24), pin the exact reviewed installed version, and test it with
provider fixtures before exposing a deposit address. The provider specifies stable JSON ordering
and a Base58/SHA-256 message construction; do not invent a replacement serializer or mutate the
provider response before verification. Failure or unavailable verification disables commit.
[Quote-signature documentation](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature)

## State, storage and reconciliation

States: `disabled`, `needs_login`, `needs_account`, `needs_native_gas`, `loading_assets`, `editing`,
`previewing`, `review`, `committing`, `awaiting_deposit`, `deposit_detected`, `processing`,
`incomplete_deposit`, `settled_verifying`, `needs_unwrap`, `funded`, `refund_pending`, `refunded`,
`failed_needs_review`, `expired_unfunded`, `unavailable`, `identity_changed`.

Map provider `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `INCOMPLETE_DEPOSIT`, `SUCCESS`,
`REFUNDED`, `FAILED` explicitly. Unknown status freezes new sending and remains recoverable; never
map unknown to success. `SUCCESS` means provider settlement, then `settled_verifying`.
`INCOMPLETE_DEPOSIT` is never a confirmed refund: retain tracking until refund evidence or a
provider terminal explanation is available. `FAILED` likewise is not `REFUNDED`.
[Status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status)

Persist alongside the shared operation ledger: schema version, context, creation/update timestamps,
asset ids and chain ids, decimals, refund address, input/minimum/output integer strings, immutable
original committed quote and signature, deposit address/memo, expiry, provider correlation id,
current provider state, source/destination hashes and reconciliation evidence. No auth tokens,
private keys or sensitive provider headers. Store one immutable quote per operation; a new quote
gets a new operation id. Escape and validate even locally restored data. Corrupt/unsupported records
cannot render a payable address; preserve an exportable support record if possible.

On refresh resume the original operation, not a new quote. On account change show **This payment is
for [original account]** and keep new actions blocked until that account is selected. Read-only
tracking may continue. Cross-tab storage events prevent duplicate commits; multiple tabs must not
rewrite the same quote. Closing the panel is not cancelling/refunding a funded swap.

Before reporting `funded`, reconcile provider output identity and amount, a successful destination
receipt (all relevant child receipts), and final NEAR RPC account data. A larger balance by itself
cannot attribute the transfer because other deposits/spending may occur concurrently. Native
delivery must be evidenced as native; an FT balance increase is not native gas. If receipt matching
is ambiguous, retain **Conversion complete; checking your balance** with evidence and retry.
Never automatically repeat a transfer, withdrawal, or credit purchase after an ambiguous response.

Refresh storage-aware spendable NEAR using the shared readiness/gas-budget layer. Do not compare
only the raw `amount`, subtract the key allowance as if it were locked funds, or use floating point.
If delivered funds are below the next action's gas/storage reserve, show the actual balance and a
shortfall; do not label them ready to spend. Unwrap, if enabled, is its own persisted approved
operation and cannot be repeated until its previous outcome is resolved.

After expiry with no observed deposit: hide send instructions but keep the record and status check.
For late/wrong-asset/wrong-network/missing-memo deposits, expose recovery details and provider
support; never promise recovery or a deadline refund beyond the documented mode. A timeout is
**Still checking**, not **Failed**. Keep polling resumable past the normal wait; the provider's
going-live guide allows up to 15 minutes, not a guarantee.
[Operational guidance](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/going-live)

## Acceptance and regression checks

Meaningful failing-before/passing-after tests must cover:

1. Integer precision above JS safe-integer bounds and decimal parsing failures.
2. Mainnet feature isolation: a testnet/mock page cannot expose a mainnet payable address.
3. Source token same-symbol collision, stale listing, malformed decimals, no-route and minimum
   rejection; no implicit different token/network or increased payment.
4. Preview cannot expose an address; commit mismatch/signature failure/expired quote cannot be paid.
5. Refund address and mandatory memo survive reload and status requests exactly.
6. Account/network change during every awaited request does not render or continue the old action.
7. Status coverage including API 404/429/5xx, transient RPC failure, unknown status, incomplete
   deposit, expired-but-processing, late deposit, refund pending and refund confirmation.
8. `SUCCESS` plus wNEAR-only delivery cannot become native `funded`; zero native balance cannot
   approve unwrap or claim gas sponsorship. Named nonexistent accounts block commit.
9. Concurrent deposit/spend does not turn a balance delta into false settlement attribution.
10. Refresh, tab duplication and double-click do not generate a second payable operation or resend.
11. Disposal removes polling/timers/listeners; read-only resume never requests a signature.
12. Successful funding refreshes shared balances and leaves credits, paint and drawing-key scope
    unchanged. Explicit unwrap uses ordinary wallet approval, never the draw key.

Run focused tests, then `npm test` and `npm run build` from `web/`. Capture desktop 1280px and phone
390px views: edit, review, deposit, expiry, progress, refund, identity mismatch and funded. Keyboard
focus stays inside the active dialog; close restores focus; status updates use a polite live region;
copy confirmation is accessible. No card/overlay covers the wall.

Fixture tests and build are sufficient to review the implementation behind disabled flags; they do
not close INT-NATIVE or establish live settlement. A separately authorized small mainnet trial must
record source transaction, exact quote, destination receipts, native balance and recovery path.
No spend or deployment is authorized by this document alone. Handoff must name commit, test
commands/results, provider revision, open gates, screenshot paths, `## Learned`, and precise backlog
status change for the coordinator to record on merge.
