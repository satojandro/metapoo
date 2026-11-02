# 3 November — wallet onboarding and acquisition implementation

## What changed

Three agents implemented the merged PR #54 work orders, with one integration owner for the shared
wallet, readiness, gas budget, capital-operation gateway, ledger and UI wiring. Privy uses the
existing NEAR Connect selector and the existing explicit drawing authorization path. Intents uses
signed exact-input quotes and persistent payment recovery. RHEA uses reviewed route manifests,
checkpoint plans, ordinary wallet approvals and attributable receipt reconciliation.

All three flags default off. No contract change, deployment, account provisioning, signature,
funding transfer or swap was performed. Existing drawing methods and gas allowance were preserved;
players pay their own gas. Acquiring funds/tokens does not buy credits or paint automatically.

## Verification and limits

- Implementation started from merged specs `57ca197` and was rebased onto main `0223870`
  (PR #55). Its `chain-json.ts` extraction is preserved. The PR records the exact final head.
- Node 22.23.4, matching CI's Node 22 major: the final post-reconciliation suite and TypeScript/
  production Vite build passed; the PR records the final test count and remote CI result.
- Review regressions cover immediate disconnect invalidation before a slow provider lookup,
  same-account session changes, sequential registration fallback, corrupt-record isolation,
  original-network recovery after logout, and exact returned transaction-hash binding.
- `wallet-acquisition.test.ts` rejects an existing FullAccess key and wrong receiver/method scope.
  Those two assertions were run against the merged-spec baseline's wallet implementation and
  failed with `expected true to be false`; they pass with the strengthened on-chain permission check.
- [Browser evidence](../research/2026-11-03-acquisition-browser-evidence.json): actual localhost
  fetch could read tokens (200), a dry quote (201), and a deliberately nonpayable status error (404).
  No payable deposit address was created. The unmodified live dry quote is checked with the
  official SDK's signature verifier. Production-origin CORS and actual native delivery remain open.
- The labelled layout fixture at `/scripts/acquisition-browser-fixture.html` was checked at
  390×844 and 1280×900. Document width equalled viewport width. It imported the real browser Privy
  module successfully without initializing authentication. Screenshots are in
  `artifacts/acquisition/`; these are fixture evidence, not a credential-backed login or wallet flow.
- [RHEA research](../research/2026-11-03-rhea-route-evidence.md) records public mainnet reads.
  The DIARHEA/mPOO final pool exists, is running and quotes, but the complete NEAR acquisition
  route and enforceable post-tax net minimum remain unverified. No production manifest is invented.

## Open enablement gates

1. Privy public app/client IDs, same-origin callback configuration, actual testnet provisioning,
   Google/email redirect and popup tests, access-key/paint chain proof, and deployed hosting headers.
2. Intents production-origin CORS, reviewed source route, full receipt trace availability, and native
   delivery evidence for named, initialized implicit and new implicit accounts. New wNEAR-only
   funding is deliberately blocked; there is no sponsored bootstrap or implemented unwrap checkout.
3. RHEA complete route and code hashes, net-tax minimum protection, measured gas ceilings and a
   separately approved bounded mainnet trial. Same-exchange DCL hops can share wrap+transfer approval;
   independent first-time registrations can share an approval when the selected wallet supports it.
4. Runtime dependency audit reports one high-severity Zod advisory propagated through four Privy
   packages (`npm audit --omit=dev`, 3 Nov). npm reports no compatible automated fix. Keep Privy disabled
   until a compatible patched provider dependency is reviewed. Do not force a breaking Zod major
   into the authentication SDK. Existing dev-tool audit findings are not newly fixed in this work.

## Learned

A live signed dry quote can include server-added public defaults and a platform fee even when the
application did not request an app fee. Validate the reviewed defaults, display the fee, and strip
server-added fields before the commit request; echoing the response can accidentally request a fee.

A localStorage read/set lease is not atomic across suspended tabs. Capital approvals require browser
Web Locks; older browsers fail closed instead of relying on a false mutex. This is a deliberate
narrowing of the spec's proposed fallback. Read-only history is still accessible. Pending gateway
records are released only through matching original hashes, signer/receiver/actions and final
receipts, under the same lock; a missing callback hash remains unresolved and is never auto-retried.

Explicit pre-sign cancellation is different from an unknown wallet result. The owned Privy Cancel
button emits a typed rejection only before invoking the signer; the gateway releases that unsent
attempt without charging gas. Generic popup closure, provider rejection strings/codes and RPC errors
remain unknown. A partial registration batch preserves and verifies the already submitted subset
before offering a fresh review of the unsent remainder; it never resends automatically.

The provider SDK's generated-function dependency imports Node's `util`. A passing Vite build that
externalizes it is not browser compatibility. The build now explicitly resolves the pinned browser
polyfill. Privy code stays lazy-loaded; the SDK chunk is large and remains a performance follow-up.

## Handoff

Review the shared spec and feature evidence before enabling anything. Treat implemented,
fixture-tested, browser-import-tested and chain-verified as separate statuses. The PR description
contains backlog transitions and remaining gates; the merge owner updates `docs/backlog.md` on main.
