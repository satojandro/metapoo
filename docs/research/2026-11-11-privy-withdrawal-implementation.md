# PR #103 implementation checkpoint

Base: `b1358d1` (main, including merged #103). Branch: `codex/privy-withdrawal`.
This is an initial implementation checkpoint, not release acceptance. All new feature flags default off.

## Implemented in this checkpoint

- SEND-0: whole-batch Send classification, positive exact amounts, pinned token allowlist, duplicate JSON key rejection, exact 1-yocto transfers, independently read capped registration minima, metadata and recipient/storage rechecks. The generic branch cannot accept unreviewed transfers. Existing drawing AddKey/DeleteKey branches are unchanged.
- SEND-1: `purpose: send`, Transfer action union, same gateway/capital lock/unknown-broadcast ledger, 0.01 NEAR reserve, native-transfer reconciliation tied to the original signer/receiver/amount.
- SEND-2 first pass: default-off wallet entry, asset selection, recipient and exact decimal amount, Max, in-game review, pre-sign re-planning, confirmed/cancelled/failed/unknown messages and explicit pending reconciliation. Token success additionally checks the sender balance change. The staking recipient block reads `get_revenue_state`; the repository does not configure staking through an environment variable.
- CUSTODY-0: separate full-access review dispatch, expiring public intent, independent key-existence read, masked suffix plus acknowledgement, fresh review after readiness, and an explicit ban on deleting the derived Privy key even if a forged drawing-key record names it.
- CUSTODY-1 first pass: default-off Privy-only panel, public-key input, key list, add/remove-own-key operations, on-chain key-state confirmation, and unresolved-attempt protection. No private key is created, exported, persisted or logged.

## Still required before release

| Work item | Remaining work / gate |
|---|---|
| SEND-0 | Full mockup state coverage; dynamic signing-page fee estimate. Independent review of the new authority boundary. |
| SEND-1 | Wallet integration tests covering real identity switches and provider outcomes for new requests. |
| SEND-2 | Live balance asset chips, paste affordance, debounced validation and disabled Review while reads are unknown, richer per-field messages, mPOO delivered-amount/tax evidence, bounded polling and complete recovery UX, browser tests of all states at mobile and desktop sizes. Current form validates on Review and blocks before wallet invocation. |
| SEND-TESTNET | Real Privy native sends to named/existing/fresh implicit accounts; token registered/unregistered sends; registration rollback; rejection and lost-response recovery. No send was executed here. |
| SEND-LIVE | Separately authorized 1-mPOO test between team accounts, tax/delivery evidence. `VITE_SEND_MPOO_ENABLED=false`. |
| SEND-HARDEN | Proposed receiver/method policy below requires a product decision and implementation/tests. The broad existing generic FunctionCall policy remains. |
| CUSTODY-1 | External-wallet graduation flow, verified 24-hour observation policy, full key-list labels/copy controls, post-graduation sign-in copy, and complete component/browser state tests. Graduation is not offered while compatibility is unverified. |
| CUSTODY-TESTNET | Actual add-key, external signing, remove-own-key, and graduation evidence; identify a compatible external wallet before naming it in help copy. |
| CUSTODY-EXPORT-LIVE | Isolated throwaway React-SDK prototype and authenticated NEAR export/import trial. No prototype or export route shipped. The four SDK/session/format/wallet-type unknowns in the spec remain unanswered. |

## SEND-HARDEN proposal

Use feature-owned receiver/method validators, not one broad method-name list. Proposed receiver bindings:

- Configured board: current draw, credit purchase/registration, claim and revenue-distribution methods; administrative methods additionally need the current admin flow's checks.
- Configured TOILET: staking `ft_transfer_call` with exact staking receiver and message, plus supported self-registration.
- Board-reported staking contract: self-registration, `unstake`, `claim_rewards` with their exact argument/deposit/gas shapes.
- Configured mPOO: current credit checkout and self-registration; RHEA contracts and route arguments use the existing acquisition policy.
- Wrapped NEAR / RHEA: existing reviewed unwrap, wrap and swap validators.
- Send: this checkpoint's dedicated classifier.

Require fixture reviews for every existing flow before enabling that restriction. Reject an unlisted receiver even if its method name matches an approved one. Do not expand this policy from request-supplied metadata. This is a proposal, not an enabled launch gate.

## Verification and evidence limits

- Full suite, typecheck and build are verified on the **CI runtime (Node 22.14.0)**, which is the only runtime that counts: `NODE_OPTIONS=--no-experimental-webstorage` on Node 26 fixes the localStorage noise but changes Web Locks availability too, and that is how this branch first looked green while CI was red. At `f78da29`: **109 files / 1072 tests pass**, `tsc --noEmit` clean, `vite build` clean.
- CI is the gate, not a local run: the suite must be green on `.github/workflows/ci.yml`'s Node 22 pin.
- New regressions include `requires the masked suffix and checkbox, then rejects an intent cleared during readiness`, `enforces its floor even if a caller supplies zero reserve`, `records uncertainty before broadcast and never automatically repeats a send`, and duplicate-key/registration/metadata rejection cases.
- Initial test run before implementation failed loading the absent Send planner; the implemented planner then passed. Existing Privy tests were not rewritten to accept new behavior.
- Local browser smoke check rendered the Send form. The standalone preview initially omitted the application's required polyfills; adding the existing `polyfills.ts` import fixed it. Temporary preview HTML was removed. This is not a mobile/full-state acceptance test.
- Read-only testnet `view_access_key_list` of configured board `board3.metapoo-player1.testnet` succeeded at block `277122366`, hash `FtDWEKZamHfgXeLNx4LGG7wEERiY4RDUk4LWCPxGVDGm`, returning one FullAccess key. This establishes public RPC/key-list access only; it does not demonstrate any new transaction or player-key change.
- No contract changes, live spending, key changes, deployment, merge, export, or feature enablement.

## Learned

The installed `@near-js/accounts` **2.5.1** `lib/esm/account.js:238` uses `Promise.all` inside `signAndSendTransactions`. The pinned Privy connector **0.0.8** delegates to that method. This contradicts PR #103's sequential-batch assumption. Send's one-transaction design avoids that issue. Existing non-Send review copy claiming batches run “in order” needs a separate correction; it was preserved here to keep the specified existing review behavior unchanged. Same-receiver action atomicity is documented in [near-sdk's batch API](https://docs.rs/near-sdk/latest/near_sdk/env/fn.promise_batch_create.html).

The wall disposal fixture also inherited `VITE_TOILET_ID` from a local `.env`, making an optional claim widget add a third subscription. Reproduced on unchanged `b1358d1` with `VITE_TOILET_ID=toilet.testnet`, then pinned the fixture's TOILET configuration to empty. Its subscription checks now describe the two widgets actually under test.

## Review pass (11 November, independent review)

Findings from reviewing this branch against the merged specs, and what changed:

1. **CI was red and the local run could not show it.** `send/gateway.test.ts` walked the real `withCapitalLock`, which fails closed without `navigator.locks`. Node 26 (this machine) ships Web Locks, the CI pin (Node 22) does not, so the suite was green locally and red on CI: 3 failed / 1053 passed on Node 22. The fixture now stubs the lock exactly as `intents/panel.test.ts` does and restores it afterwards; the production guard is untouched. Verified green on Node 22 and on CI at `334b449`.
2. **A key change that failed on chain blocked every later payment.** `metapoo:custody:attempt:<net>` was cleared only when the intended key state appeared. An attempt that *failed* therefore never cleared it, and `readBudget` refused Send, credit purchases, acquisition and RHEA swaps with "Refresh your keys" — advice that could not clear the marker either. A failed key change wedged the account until localStorage was edited by hand. The marker now carries the transaction hash (recorded before the confirmation read), and `reconcileCustodyAttempt` settles it in order: the key list, then the transaction (a `Failure` clears it, because nothing changed), then an explicit human override for a lost outcome, which re-reads the key first so it can never bury a change that landed. A read failure throws instead of clearing. `f0fe31f`; the regression test fails if the failure branch is removed.
3. **Recipient input was rewritten silently.** `planSend` lowercased unconditionally, so invalid input became some other account instead of an error. Spec §5.1 allows a case-only correction and nothing else; `normalizeRecipient` implements exactly that, with tests for double dots, a leading separator, a Cyrillic look-alike and an over-length id.
4. **The batch note claimed an order that does not exist.** The copy now says "at once … if one fails, the others can still happen", and spec §2.2/§6.6 record the measured `Promise.all` behaviour. This supersedes the "needs a separate correction" note above — it is corrected here.
5. **`mpoo.nearlytrade.near` was hardcoded in two config modules** while `MPOO_ACCOUNT` already existed; both import the constant now.
6. **The sign window rendered nothing while the review's RPC reads were outstanding**; it now says "Checking this request with the chain…".

Not changed, deliberately: SEND-HARDEN (the generic `FunctionCall` allowlist) is an owner decision under spec Q1 and can break credit checkout and RHEA, which use `ft_transfer_call`; the feature flags stay off; no live gate was executed; no graduation flow was invented while external-wallet compatibility is unverified.
