# PRIVY-1 — Social login through NEAR Connect

Date: 3 November 2026. Status: implementation specification; no SDK installed, no credentials configured, no browser or chain signing proof produced by this document.

Read [the shared integration contract](2026-11-03-wallet-funding-integration-spec.md) first. It owns operation context, identity epochs, the transaction gateway, gas policy, shared file ownership, and cross-feature release evidence. This document owns Privy authentication and its NEAR Connect wallet adapter. User decisions for this work supersede the older external-acquisition-only direction: players pay their own gas; preserve existing drawing keys; no relayer, sponsored transactions, expanded key scope, or allowance change.

## 1. Result and scope

A new player can choose social/email sign-in, obtain a Privy-controlled NEAR account address, fund it, explicitly authorize the existing limited drawing key, and paint through the existing local signer. Returning players recover the same selected account. Existing NEAR wallets remain available through the same connector.

Implement Google and email code login first. Apple may be enabled only after provider credentials and return-flow tests exist; never render a provider button that is not configured. Keep the wall frontend in vanilla TypeScript. Use the connector's framework-independent `sign-page` entry and a small DOM UI; do not convert the app to React merely because examples use it. If the core SDK integration cannot meet the tested browser flow, document the blocker before replacing this design with an isolated React authentication page; never silently migrate the main app.

Out of scope: account merging, automatic identity linking, portability of drawing secrets between devices, gas sponsorship, backend custody, background purchases, Intents source-wallet signing, RHEA routes, and contract changes.

## 2. Evidence baseline and first implementation checkpoint

Repository implementation baseline is remote main `7e123621c31206ab1c8f5f502ccf2ef3ed3aeb46` (parent verified 3 Nov). This specification is authored from local checkout `59cac46`; reconcile the latest wallet, drawing and wall-shell files before implementation. Read `AGENT.md`, `docs/learning/traps.md`, `docs/README.md`, `docs/roadmap.md`, `docs/00-shared-decisions.md`, and newest learning record. Work from current main on a meaningful code branch; do not redeploy contracts.

Existing foundations, not new work:

- `web/src/wallet.ts`: connector singleton, `connectWallet`, `restoreWalletSession`, `accountIdFromWallet`, and wallet subscriptions. Restoration already repairs identity after redirect/reload.
- `web/src/drawing-session.ts`: locally generated Ed25519 key restricted to `draw` / `draw_many` on `CONTRACT_ID`, existing bounded lifetime gas allowance, storage and mismatch handling.
- `web/src/local-draw.ts`: local RPC submission using that key; uncertain broadcast must never trigger a duplicate fallback. Tap/stroke nonce gates already serialize drawing.
- `web/src/submit-draw.ts`: chooses local drawing when available. Preserve confirmation and pixel read-back, not just transaction hashes.
- `web/src/polyfills.ts`: browser Buffer setup must run first in the new signing entry too.

Provider source inspected at `beneviolabs/privy-near-connect` commit `bef71302bdcb3ea952435a12cdbec920fe68d4b9`, whose package metadata reports `@peerfolio/privy-near-connect` 0.0.8. This is source evidence, not an assertion that a particular published executor has identical code:

1. `src/executor.ts` forwards `signIn` including `addFunctionCallKey` to the signing page.
2. `src/signing/signer.ts` selects a linked account with `chain_type: near` and dispatches to `AccountWithPrivySigner`.
3. `src/signing/account.ts::ncSignIn` really calls `addFunctionCallAccessKey`, using supplied receiver, method list and limited allowance, before returning. Capability is implemented in this source, not merely advertised in a manifest.
4. The no-key branch returns an implicit address without querying whether the on-chain account exists. An address is not proof of an initialized, funded account.
5. `executor.getAccounts` restores only a cached account ID. `signOut` clears that cached ID but does not end the Privy authentication session. Network arguments to `getAccounts` are ignored there; wallet/session validation must be supplied by Meta Poo.
6. Signing provider creation defaults to mainnet if payload network is omitted. Every request must carry the configured network explicitly.

**PRIVY-1A checkpoint:** select an exact published package/core-SDK/executor tuple, inspect its actual declarations and runtime code, compile a minimal fixture, and record versions, executor SHA/URL, exported methods, account creation call, network forwarding and dependency compatibility. Package and executor need not share a commit: prove compatibility explicitly. If source differs from the inspected commit, update the evidence before implementation. Do not copy `latest`, a mutable release branch, or a manifest claim as proof.

## 3. Files and ownership

Privy agent owns new files:

- `web/src/integrations/privy/config.ts` — validated public configuration and manifest entry.
- `web/src/integrations/privy/sign-page.ts` — standalone authentication/approval DOM entry.
- `web/src/integrations/privy/session.ts` — selected Privy NEAR wallet resolution, auth restore/logout and callback handling.
- Matching `*.test.ts` tests and provider fixture adapters in that directory.
- `web/privy-sign.html` — independently built Vite entry; no game boot or board polling here.

Shared integration owner owns `web/src/integrations/account-readiness.ts`, `web/src/integrations/types.ts`, operation store, generic transaction gateway and shared shell buttons. Privy agent supplies changes to `wallet.ts`, `config.ts`, `vite-env.d.ts`, `.env.example`, `vite.config.ts`, `package.json` and lockfile as a single coordinated patch to that owner; do not concurrently edit those files. Do not replace the default wallet manifest with a Privy-only list. Merge the reviewed additional wallet into the connector's supported manifest mechanism for the installed connector version. Test that Meteor and another existing wallet remain selectable.

Signing HTML should be a real emitted asset, not an invented SPA route that boots the wall. Use the actual configured Vite base path, including deployments under a subpath. Register its exact public callback URL in Privy. Hosting must preserve popup opener messaging while permitting the Privy secure-context iframe; test actual CSP/COOP headers rather than adding broad wildcards.

## 4. Public config and dependency policy

Add disabled-by-default `VITE_PRIVY_ENABLED`, public `VITE_PRIVY_APP_ID`, `VITE_PRIVY_APP_CLIENT_ID`, and explicit `VITE_PRIVY_SIGN_PAGE_URL`. Use existing `VITE_NEAR_NETWORK` and RPC config; no independent network selector. Use a reviewed, committed executor SHA constant or checked generated manifest asset, never a query-string override. A production sign-page URL must have the configured app origin and no untrusted redirect parameter. Derive exact allowed origins from deployment config; localhost origins are development-only.

App/client IDs are public configuration. Never put Privy app secrets, user access tokens, OAuth codes, recovery material, or signing keys into `VITE_*`, logs, error telemetry, URLs, quotes, or funding operation records. Existing limited drawing secrets stay solely in their established drawing-session storage; no full-access signing key is exported to Meta Poo.

Pin exact dependency versions after checkpoint PRIVY-1A. `@peerfolio/privy-near-connect/sign-page` and `@privy-io/js-sdk-core` are the intended runtime entrypoints. Optional React/Radix peers are unnecessary for the custom DOM sign page. Core SDK provider documentation asks integrators to discuss the low-level integration with Privy; record provider-support status as an integration dependency, not an invented claim of production support. Preserve frontend build compatibility and inspect browser polyfill/externalization warnings.

Disabled or incomplete config hides social-login choices, without preventing existing-wallet connect. Invalid enabled config gives an actionable unavailable reason rather than falling back to another network.

## 5. Identity, readiness and login sequence

Canonical transaction identity remains `getWalletSession()` (`accountId`, `networkId`). Privy auth user ID or email is never a board account ID. Derive the selected account only from a validated linked NEAR wallet record; the embedded account is an implicit account address. Do not blindly use `user.wallet` or the first wallet across chains. If multiple NEAR wallets are linked, persist one explicit wallet ID and require a deliberate switch. Never create a new wallet on every login.

Required steps:

1. Capture shared operation context and preserve current wall position, pending drawing and intended next panel before launching auth.
2. Launch the connector popup from the click handler. No autoplay popup after a delayed network read. Handle blocked popup and a closed popup separately; offer an explicit Retry action.
3. Initialize one Privy client per signing document. Use provider-supported Google OAuth or email-code methods; reuse authenticated user state if valid. Keep credentials private to Privy's secure context.
4. Find or create exactly one linked NEAR wallet. For the inspected upstream example, the core SDK exports `create` as `createWallet`, invoked with a Privy route-fetch context and `{request: {chain_type: 'near'}}`; verify this low-level signature against the pinned package at PRIVY-1A. Never guess a nonexistent `createNearWallet` method. Prefer the reviewed supported equivalent if the pinned SDK changed.
5. Select that wallet explicitly when calling `initSigningPage`. Complete no-key `signIn` first. Display the obtained account address, with readiness determined independently.
6. The shared `resolveAccountReadiness(accountId, networkId)` queries the configured chain for account existence and available native NEAR. A typed unknown-account response is `absent`; RPC timeout is `unavailable`, not absent or zero. Intents funding may display the recipient address while absent, but neither signing nor drawing is enabled.
7. If unfunded, open the funding flow or show native-NEAR receive instructions. **Do not request AddKey yet.** Intents delivery to a fresh implicit account and its native account initialization are a separate live acceptance gate; see the funding spec. Funding failure cannot generate a fake-ready account.
8. Once account and spendable gas readiness are freshly confirmed, offer the current explicit drawing-session authorization using the existing keypair builder and allowance. Verify the key permissions on chain before marking active.
9. Resume the existing wall flow. Intents success does not authorize a key; social login does not purchase credits.

Readiness must include balance net of locked storage and the shared gas reserve. The allowance is a cap, not a balance deposited into the key. Retain enough native NEAR for AddKey, optional registration and first actions; no automatic team top-up. Re-evaluate just before submission because balances can change elsewhere.

## 6. Signing-page protocol and transaction boundary

Use the connector's `initSigningPage` handshake, not a second ad-hoc postMessage protocol. Require exact `allowedOrigins` and `debug: false`. Validate payload structure, network, selected wallet/account identity, allowed request kinds, and operation context before enabling Approve. A request with omitted/mismatched network must be rejected rather than exercising upstream's mainnet default. A direct visit without an opener shows a safe explanation and Back action; it never auto-signs.

Auth redirects may reload the popup and lose the initial in-memory payload. Restore the Privy OAuth state using SDK PKCE/state APIs, return to the same signing entry, then reinitialize the connector handshake. Persist only bounded non-secret return intent; reject external return URLs. Reconcile identity again after callback. Test this with actual Google auth, not just a mocked RESULT message.

Show user-readable approvals for AddKey (receiver, methods, allowance), normal NEAR credit purchases, token registration/transfer calls, and reviewed RHEA transaction batches. Preserve exact smallest-unit values internally. Rendering untrusted account/token fields uses text nodes, not HTML.

New funding-unwrap and MPOO-acquisition transactions use shared `signAndSendApprovedTransactions(request: ApprovedTransactionRequest)` in `web/src/wallet.ts`. Its request is `{context, purpose, transactions, approval}`, where `context` holds `{operationId, accountId, networkId, sessionEpoch}`, `purpose` is `funding-unwrap` or `mpoo-acquisition`, `transactions` are readonly `{receiverId, actions}` entries, and `approval` holds `{summary, maxNativeSpendYocto, quoteId?, expiresAtMs?}`. The shared owner validates and confirms the immutable reviewed plan sequentially. Existing credit purchase functions remain the purchase path; AddKey remains the existing explicit drawing authorization path and does not use this gateway. The sign page is an approval surface for the selected wallet, not a second spending API. Reject identity/epoch changes before signing, never use the local drawing key for payment/swap/transfer/AddKey/DeleteKey, and do not add those methods to its scope.

Serialize prompts for a given wallet and the affected transaction key. Preserve existing tap/stroke nonce serialization. No automatic resend after an RPC timeout that could have followed broadcast; record hash/uncertainty and reconcile outcomes. Never treat receipt-created or wallet-returned hash alone as completion.

No `signDelegateActions`, relayer URL, paymaster, or sponsor flag is enabled. Ordinary transactions keep the user as signer, preserving the existing direct MPOO credit sender/signature invariant.

## 7. Restore, account switches, logout and errors

On wall boot, await existing `restoreWalletSession`; a cached Privy account is a remembered selection, not proof of fresh provider authorization or readiness. Refresh authenticated Privy identity at the next approval without opening surprise popups; if expired, require reauthentication. Reconcile the selected wallet returned by fresh Privy data before spending.

Account, network or contract change advances shared session epoch, aborts pre-sign quotes, pauses drawing and invalidates the previous key for the current context. Historical funding monitors continue under their original recipient context. Late results cannot attach themselves to the new user or automatically resume purchases.

Disconnect must clear connector selection, stop drawing submission and context-isolate the disconnected identity. Preserve the existing drawing-secret storage policy; this integration does not silently change it. Implement Privy auth logout as well (the upstream executor does not do it); failures leave transactions disabled and show a specific Retry sign-out action. Do not clear unrelated wallets' storage. Keep explicit Forget locally separate from Logout and Revoke on-chain. Local deletion is not on-chain key revocation: retain explicit revoke-on-chain management for a connected/funded user, using wallet approval. Never claim a successful revoke without chain evidence. Expired Privy authentication requires reauthentication for provider/capital approvals; an existing valid authorized local drawing key does not require fresh Privy authentication for each paint.

Map at least: disabled config; popup blocked/closed; auth cancelled/expired; wallet provisioning failed; account not initialized; insufficient spendable NEAR; RPC unavailable; wrong network/account; key not found/wrong permissions; allowance exhausted; user rejected; transaction failed; broadcast unresolved. Keep raw provider errors behind a diagnostic expansion with secret redaction. Cancelled login is not a purchase failure.

## 8. Acceptance and proof

Unit/component tests must cover failure boundaries, not just getters:

- Disabled/invalid config preserves existing wallet choices; manifest merge retains existing entries and capabilities.
- Linked wallets include EVM/Solana before NEAR: select the explicit NEAR wallet; repeat login does not create a duplicate; multiple NEAR wallets cannot silently switch.
- Fresh implicit address permits no-key login without AddKey; absent account blocks signing; RPC failure remains unknown.
- Every connect/sign call includes configured network; omitted network is rejected in the sign page; mainnet cannot be used from testnet UI.
- Drawing authorization carries exactly existing receiver/methods/allowance. Verify access key is FunctionCall with those constraints and bounded allowance; merely finding a public key (or FullAccess) does not mark the session authorized.
- Auth popup/redirect return restores intent; denied origin, blocked popup, timeout, direct sign-page visit and cancelled auth never call sign.
- An expired provider session blocks capital/provider approval until reauthentication; a wallet switch cannot spend for the previous context. A valid local drawing key remains independent of Privy authentication expiry.
- Disconnect stops local drawing immediately even if Privy logout fails; local forget never claims chain revoke.
- Financial transaction gateway never receives the drawing secret and never signs via the drawing key. Unknown-broadcast outcomes do not resubmit.
- Core SDK public APIs compile against pinned versions; build emits both app and signing entry with browser polyfills, no Node-only runtime imports.

Run focused tests first, then `npm test` and `npm run build` from `web/`. Follow current CI requirements; on this Mac use the documented `NODE_OPTIONS=--no-experimental-webstorage` workaround only if the recorded Node storage issue occurs. Name a meaningful test that fails before the implementation and passes after it. Code PR needs `## Learned` and backlog transition in its description, not concurrent backlog edits.

Browser testnet evidence is a separate acceptance layer requiring configured Privy app and funded user account: Google and email login, same-account restore after refresh, network isolation, confirmed AddKey, one popup-free tap and one `draw_many` stroke, allowance/nonce deltas, fresh matching pixel read, second-browser read, rejection, explicit revoke and ordinary-wallet fallback. Capture redacted hashes, before/after access-key permissions and receipts; no keys, OAuth tokens or email addresses in evidence. Different browser has no drawing secret and requires its own authorization; never clone that secret.

Do not label the feature complete from fixtures alone. Mainnet readiness additionally requires real configured hosting/provider credentials, reviewed recovery guidance, tested popup/callback headers on mobile/desktop, and the separately authorized funding/settlement trials described in the shared plan. This specification authorizes no mainnet spend or deployment.

## 9. Deliverable checklist and sources

Hand off exact package/core-SDK/executor versions and SHAs; configuration names and callback origins; changed files; fixture versus browser/chain evidence; explicit remaining gates; privacy-safe recovery/logout behaviour; and a reviewable branch/PR. Review testnet and mainnet configurations separately. No approval request should substitute for completing fixture implementation and the configured testnet checks already within scope.

Primary sources, checked 3 Nov 2026:

- [NEAR Privy tutorial](https://docs.near.org/web3-apps/tutorials/privy): direct and connector-based integration, extended-chain wallet creation, raw hash signing.
- [Privy connector source at inspected revision](https://github.com/beneviolabs/privy-near-connect/tree/bef71302bdcb3ea952435a12cdbec920fe68d4b9), especially [`account.ts`](https://github.com/beneviolabs/privy-near-connect/blob/bef71302bdcb3ea952435a12cdbec920fe68d4b9/src/signing/account.ts), [`executor.ts`](https://github.com/beneviolabs/privy-near-connect/blob/bef71302bdcb3ea952435a12cdbec920fe68d4b9/src/executor.ts), [`sign-page.ts`](https://github.com/beneviolabs/privy-near-connect/blob/bef71302bdcb3ea952435a12cdbec920fe68d4b9/src/sign-page.ts), and [`App.tsx`](https://github.com/beneviolabs/privy-near-connect/blob/bef71302bdcb3ea952435a12cdbec920fe68d4b9/examples/react/src/App.tsx): actual key addition, cached identity/logout limitations, popup and wallet-provisioning protocol.
- [Privy browser core SDK](https://docs.privy.io/recipes/core-js): vanilla authentication, OAuth state/PKCE, initialization and logout. Its generic wallet-creation section names EVM/Solana; use reviewed NEAR-specific source/types rather than inferring a NEAR method from those examples.
- [Privy OAuth](https://docs.privy.io/authentication/user-authentication/login-methods/oauth): configured providers, redirects and browser restrictions.
- [NEAR wallet login and function-call keys](https://docs.near.org/web3-apps/tutorials/wallet-login#function-call-keys-at-login): user-paid gas and limited signing capability. Its current plugin example is not a requirement to replace Meta Poo's working local signer.
