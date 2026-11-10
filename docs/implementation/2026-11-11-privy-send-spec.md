# PRIVY-SEND — Send NEAR, TOILET and mPOO out of an account

Date: 11 November 2026. Status: implementation specification; no app code changed, nothing signed or broadcast by this document. Mockups: [`mockups/2026-11-11-privy-send.html`](mockups/2026-11-11-privy-send.html).

Read [the Privy NEAR Connect spec](2026-11-03-privy-near-connect-spec.md) and [the shared integration contract](2026-11-03-wallet-funding-integration-spec.md) first. They own Privy authentication, the sign page handshake, operation context, identity epochs, the approved-transaction gateway and gas policy. This document owns one new capability: a player whose account is a Privy embedded wallet can move native NEAR, TOILET and mPOO to another NEAR account from inside the game. Companion: [the self-custody spec](2026-11-11-privy-self-custody-spec.md). Task list: [`privy-withdrawal.tasks.json`](privy-withdrawal.tasks.json).

## 1. Result and scope

A connected player opens **Send** from the wallet panel, chooses an asset (NEAR, TOILET or mPOO), enters a recipient and an amount, and reviews the plan in the game. The Privy approval window then shows a plain-language review built from the exact payload. Approve sends one transaction. The game confirms the outcome from chain receipts and balances, never from a returned hash alone.

This is a launch blocker. Today a Privy player can paint, buy credits and stake, but has no way to move value out, because `web/src/integrations/privy/approval.ts` throws "This wallet request contains an unsupported action" (line 304 on `f252aee`) for anything except `DeleteKey` (drawing key only), `AddKey` (drawing key only) and `FunctionCall`.

In scope:

- Native NEAR `Transfer` to any valid NEAR account.
- NEP-141 `ft_transfer` of TOILET and mPOO only, with an optional preceding NEP-145 `storage_deposit` that registers the recipient on the same token contract.
- Matching reviewed branches in the Privy approval screen. Every existing guard stays.
- The Send UI is offered to every connected wallet. Non-Privy wallets review in their own UI. The new approval branches matter only for Privy.

Out of scope: `ft_transfer_call`, memos, NFTs, any other token, cross-chain withdrawal (1Click outbound is a later phase), RHEA swaps (separately flagged), sponsored gas, `DeleteAccount`, scheduled or recurring sends, an address book, and contract changes. `AddKey(FullAccess)` stays rejected on every path in this document; see the self-custody spec for its separate, strictly confirmed path.

## 2. Evidence baseline

Repository baseline is `main` at `f252aee6a496159f9c5ab0ac4e2c78833870407a` (10 Nov). Reconcile `approval.ts`, `sign-page.ts`, `wallet.ts` and `integrations/approved-transactions.ts` against current main before you write code.

Facts this design relies on. Each was checked in source:

1. **The pinned connector already signs these actions.** In `@peerfolio/privy-near-connect` 0.0.8 (npm tarball, `dist/chunk-K2UUKYDB.js`), `toNearAction` maps `Transfer` to `actions.transfer(BigInt(params.deposit))` and `FunctionCall` to `actions.functionCall(...)`. Our approval screen is the only gate. No vendor change is needed.
2. **Multi-transaction batches are sequential and stop at the first failure.** `AccountWithPrivySigner.signAndSendTransactions` delegates to `@near-js/accounts` `Account.signAndSendTransactions`, which signs and sends each transaction in turn. Earlier transactions stay committed when a later one fails. Re-verify against the installed `@near-js/accounts` at SEND-0.
3. **Actions inside one transaction are atomic.** A transaction becomes one receipt on its receiver. If any action in that receipt fails, every action's state change in it is reverted, and attached deposits are refunded. Only burnt gas is lost. `storage_deposit` and `ft_transfer` both target the token contract, so they can share one transaction.
4. **TOILET** (`contracts/toilet`) uses `near-contract-standards` FT and storage management: 18 decimals (`lib.rs:210`), and `storage_balance_bounds().min` is about 0.00125 NEAR (125 bytes × 10¹⁹ yocto/byte). Token account: `VITE_TOILET_ID`.
5. **mPOO** is `mpoo.nearlytrade.near` on mainnet (`MPOO_ACCOUNT` in `web/src/paint-wallet.ts`). Its decimals are expected to be 18 (RHEA spec §Discovery). `contracts/paid-board/src/revenue.rs` notes that "mPOO's transfer runs its tax check" and budgets 15 TGas per `ft_transfer`. **Whether a plain wallet-to-wallet `ft_transfer` deducts tax is not established.** See gate SEND-LIVE and open question Q2.
6. No current app flow signs `ft_transfer`. `storage_deposit` is signed today by staking (`wallet.ts`, `args: {}` on the staking contract), mPOO registration before staking claims (`registration_only: true`, for the signer), and RHEA plans. All of those register the **signer**. A `storage_deposit` for a **third party** is new.
7. **The generic `FunctionCall` branch accepts any receiver and any method** (approval.ts lines 281–302). Its only bounds are gas, argument shape and an exact displayed deposit. Today, an `ft_transfer` would already pass it, rendered as "Calls ft_transfer on …" with raw arguments. Send must not rely on that. §4.4 tightens it for the methods this feature owns. Broader allowlisting is open question Q1.

## 3. Transaction shapes

Send always produces **exactly one transaction**. That single decision removes the multi-transaction partial-failure case from Send entirely (§6.6).

| Asset | `receiverId` | Actions, in order |
|---|---|---|
| NEAR | recipient | `Transfer { deposit: amountYocto }` |
| TOILET / mPOO, recipient registered | token contract | `FunctionCall ft_transfer { receiver_id, amount }`, gas 30 TGas, deposit `1` |
| TOILET / mPOO, recipient not registered | token contract | `FunctionCall storage_deposit { account_id: recipient, registration_only: true }`, gas 10 TGas, deposit = `storage_balance_bounds().min`; then the `ft_transfer` above |

Gas: 30 TGas for `ft_transfer` covers mPOO's tax check with headroom over the board's 15 TGas, and unused gas is refunded. 10 TGas covers a `near-contract-standards` storage registration. Store these as constants `SEND_FT_TRANSFER_GAS` and `SEND_STORAGE_DEPOSIT_GAS` in `web/src/integrations/send/plan.ts`. The approval screen accepts `ft_transfer` gas in `(0, 50 TGas]` and `storage_deposit` gas in `(0, 30 TGas]`.

`amount` is a decimal string of the token's smallest unit. Arguments are exactly those keys, with no `memo` and no `msg`.

## 4. Approval screen (`web/src/integrations/privy/approval.ts`)

### 4.1 Unchanged guards

All of these keep running first and in their current order: exact `targetOrigin`; payload network equals configured network; `signerId` (when present) equals the selected wallet; host identity matches for anything except a no-key sign-in; `signDelegateActions` rejected; 1–16 transactions; 1–16 actions per transaction; receiver account syntax. The `DeleteKey` branch stays limited to the current drawing key. The drawing-key `AddKey` branch is unchanged and still throws on `FullAccess`. Approve still re-runs `reviewPrivyRequest` and `assertReady`, and re-checks host identity, immediately before signing.

### 4.2 Classify before rendering

Add `classifySend(transactions, wallet, sendPolicy)`, called after the batch checks and before the per-action loop. A batch is a **send batch** if any action is a `Transfer` or a `FunctionCall` named `ft_transfer`, or if it contains a `storage_deposit` whose `account_id` is not the signer. A send batch must match one row of §3 exactly, or the request is rejected with "This transfer request isn't one Meta Poo can show you safely." In particular, a send batch must contain:

- exactly one transaction;
- no `AddKey`, `DeleteKey` or other method, in that transaction or alongside it;
- for `Transfer`: exactly one action, `deposit` a positive atomic integer within 40 digits, and a receiver that is not the signer;
- for tokens: `receiverId` in the **sign-page allowlist** (§4.3); `ft_transfer` last; deposit exactly `"1"`; `args` exactly `{receiver_id, amount}`; `receiver_id` a valid account other than the signer and other than the token contract itself; `amount` a positive atomic integer;
- for a `storage_deposit` before it: the same token contract; `args` exactly `{account_id, registration_only: true}`; `account_id` equal to the `ft_transfer` `receiver_id`; and a deposit equal to the sign page's own read of `storage_balance_bounds().min`, capped at `SEND_STORAGE_CAP_YOCTO` (0.01 NEAR).

`args` arrive as an object or as UTF-8 JSON bytes. Decode the bytes, parse them as JSON and validate the result. Rejected: invalid UTF-8, extra keys, numbers instead of strings, duplicate keys, and keys that differ in Unicode normalisation.

### 4.3 Sign-page token allowlist and metadata

The allowlist is compiled into the sign-page bundle from build-time configuration, never from the payload or the game page: `TOILET_ID`, plus `MPOO_ACCOUNT` on mainnet or `VITE_MPOO_ID` on testnet (new, optional). An empty entry means that asset is not offered. Extend `PrivyConfig` with `sendTokens: readonly {contractId, symbol, decimals}[]`, with decimals pinned at 18 for both.

Before rendering a token review, the sign page reads `ft_metadata` from `config.rpcUrl`. A `decimals` value different from the pinned value, or an RPC failure, rejects with "We couldn't check this token right now. Nothing was sent." An unknown token contract rejects with "Meta Poo can only send TOILET and mPOO from this window."

### 4.4 Tighten the generic branch for these methods

The generic `FunctionCall` branch must throw for `ft_transfer`, and for any `storage_deposit` whose `account_id` is present and not the signer, whenever `classifySend` did not claim the batch. Existing self-registrations (staking, mPOO, RHEA) keep their current path and rendering. `ft_transfer_call` is not changed here (credit checkout and RHEA use it); see Q1.

### 4.5 What the review shows

Return a `PrivyReview` with these values. All values are text nodes, and amounts are formatted with `formatUnits` from exact integers.

| Field | NEAR transfer | Token transfer (+ registration) |
|---|---|---|
| eyebrow | `Send NEAR` | `Send TOILET` / `Send mPOO` |
| title | `Send 2.5 NEAR` | `Send 1,000 TOILET` |
| lede | "This moves NEAR out of your Meta Poo account. Transfers can't be undone, so check the recipient." | same, with the token name |
| rows | To (mono) · Amount · Network fee "Under 0.001 NEAR" · From (mono) | To (mono) · Amount · Token contract (mono) · If registration: "Also pays 0.00125 NEAR to open a TOILET balance for the recipient" · From (mono) |
| notes | "Double-check the recipient. If it's wrong, Meta Poo can't get it back." | plus, with registration: "The recipient doesn't hold TOILET yet. Registration and transfer happen together: if the transfer fails, the registration is undone too and only the network fee is spent." |
| details | `Transfer: <yocto> yoctoNEAR to <receiver>`, network | each action's method, args JSON, deposit, gas |
| approveLabel | `Send 2.5 NEAR` | `Send 1,000 TOILET` |
| requiresFunds / requiresHost | true / true | true / true |

The approve button repeats the amount, so a player who skims still sees what they are sending. The "earlier ones still happen" note is never shown for a send batch, because a send batch is one transaction.

### 4.6 Sign-page defence in depth

Before enabling Approve on a send batch, the sign page re-checks named recipients with `view_account` (§5.2) and, for tokens, `storage_balance_of(receiver_id)`. If a registration action is present but the recipient is already registered, the screen shows "Already registered. The 0.00125 NEAR registration fee will be refunded." `near-contract-standards` refunds a `registration_only` deposit for a registered account. If no registration action is present and the recipient is unregistered, reject with "The recipient can't receive TOILET until their account is registered. Go back and send again." Never add or change actions on the sign page: it reviews, it does not plan.

## 5. Game-side Send (`web/src/integrations/send/**`, `web/src/app/send-sheet.ts`)

### 5.1 Form

The form opens from a **Send** button in the wallet panel under "Your account", and is hidden while no account is connected or `VITE_SEND_ENABLED` is not `true`.

1. **Asset**: chips for NEAR, TOILET and mPOO, each with its live balance. NEAR shows available-to-send (§5.4). Hide an asset with no configured contract. A balance read failure shows "Balance unavailable — retry" and disables that asset, never zero.
2. **To**: a single-line input with `autocapitalize=off`, `autocorrect=off` and `spellcheck=false`. Trim whitespace, and lowercase only if the whole value is otherwise valid; never silently rewrite characters. A **Paste** button reads the clipboard when the browser allows it.
3. **Amount**: a decimal text input using `inputmode=decimal`. A Max button sits beside it, and the symbol is shown as a suffix. Parse to atomic units with an exact decimal parser (no `Number`, at most `decimals` fractional digits).
4. **Review**: the primary button, disabled until every rule in §5.2–5.5 passes. It shows an in-game summary first (recipient, amount, any registration fee, fee estimate), then opens the wallet.

### 5.2 Account-id validation

Apply these in order, with the first failure shown under the field:

- 2–64 characters, matching `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$`, the NEAR account-ID rule. Message: "That isn't a NEAR account. Accounts look like alice.near or a 64-character code."
- **Implicit NEAR account**: 64 lowercase hex characters. This is valid even if the account doesn't exist yet. A native transfer creates it, and a token transfer registers it. Show the hint: "This looks like a brand-new account. Make sure you copied all 64 characters."
- **ETH-implicit account**: `0x` followed by 40 lowercase hex characters. It must already exist (`view_account`), because creating one through a plain transfer is not something this feature should rely on. If it is absent: "That account doesn't exist on NEAR yet."
- **Named account** (anything else): it must exist on the configured network. Call `view_account` through the existing structured RPC (`integrations/rpc.ts`). An unknown-account error means absent, with "No NEAR account called bob.near exists on mainnet." A timeout or other failure is *unknown*, never absent: "We couldn't check that account right now. Try again." The Review button stays disabled while the state is unknown. Mainnet accepts `.near` and other top-level names, but warns "This is a testnet account" for `.testnet`. Testnet does the reverse.
- **Self**: if the recipient equals the connected account, block with "That's your own account. Enter a different recipient."
- **Contracts that would trap tokens**: for a token send, block the token contract itself, the board `CONTRACT_ID` and the staking contract with "Tokens sent to this contract can't be recovered. Send to a personal account." A plain `ft_transfer` to a contract does not call `ft_on_transfer`, so the tokens are stranded. For NEAR sends to those contracts, show a warning instead of blocking.

Debounce existence checks (300 ms), and discard any result whose input or account epoch has changed since the check began.

### 5.3 Storage registration (NEP-145)

For a token send, once the recipient passes §5.2:

1. `storage_balance_of({account_id: recipient})` on the token contract.
2. If the result is `null`, read `storage_balance_bounds()` and use `.min` (about 0.00125 NEAR on TOILET). Plan the registration actions from §3.
3. Tell the user, inline under the amount: "**alice.near doesn't hold TOILET yet.** Sending will also pay 0.00125 NEAR to open a TOILET balance for them. This is a one-time network charge, not a Meta Poo fee." Add the deposit to the NEAR needed (§5.4).
4. If either read fails, mark the plan unknown and disable Review, with "We couldn't check whether alice.near can receive TOILET. Try again." Never guess "registered".
5. A `.min` above `SEND_STORAGE_CAP_YOCTO` blocks with "This token's registration cost has changed. Sending is paused." Investigate before raising the cap.

### 5.4 Max and the NEAR gas floor

**Floor: `SEND_GAS_FLOOR_YOCTO` = 0.01 NEAR (10²² yocto)**, kept back after every send.

Why 0.01 NEAR: NEAR charges attached gas up front at the current gas price and refunds unused gas after execution. At the protocol minimum price (10⁸ yocto per gas, so 0.0001 NEAR per TGas):

- a token send with registration attaches 40 TGas, about 0.004 NEAR prepaid, plus a 0.00125 NEAR deposit;
- a `DeleteKey` for the drawing key and an `AddKey` for self-custody each cost about 0.0005 NEAR.

0.01 NEAR leaves room for at least one further token send with registration, plus both key operations, with about 2× headroom for gas-price rises (the price can rise up to 1% per congested block). Without a floor, a player who sends "all" their NEAR first is left holding TOILET and mPOO that they cannot move, because they cannot pay gas. At current prices 0.01 NEAR is well under a dollar. It is not a fee: it stays in the account. It is independent of the drawing key's allowance, which is a spending cap rather than a balance (11-03 spec §5).

Computation, all in exact integers via `computeSpendableNative` (`integrations/gas-budget.ts`):

- `available` is `spendableBeforeGasYocto` from `resolveAccountReadiness`, already net of storage staking and locked balance.
- `gasCeiling` is `estimateGasCeiling(totalAttachedGas, gasPrice)`, the existing conservative 2× margin, for this send's transaction.
- **NEAR Max** is `available − gasCeiling − SEND_GAS_FLOOR_YOCTO`, floored at 0.
- **Token Max** is the full `ft_balance_of`. The NEAR needed, `gasCeiling + registrationDeposit + floor`, must be at most `available`. If it isn't: "You need about 0.006 NEAR for network fees to send TOILET. Add NEAR first." Show the amount needed, rounded up to 3 significant figures.
- An amount typed above NEAR Max is blocked, not clamped: "You can send up to 2.4873 NEAR. Meta Poo keeps 0.01 NEAR so you can still pay fees later." The Max button shows the exact figure with a "Keeps 0.01 NEAR for fees" caption. There is no override. A player leaving for good uses self-custody, then their own wallet.
- Re-read the balance and gas price when Review is pressed and again right before the wallet opens. If Max has fallen below the amount, return to the form with "Your balance changed. Check the amount."

### 5.5 Other rules

- The amount must be greater than 0. Show "Enter an amount".
- A token amount must not exceed its balance. Show "You have 1,204.5 TOILET".
- Each Send captures an `OperationContext`. A change of account, network or epoch before signing aborts with "Your connected account changed. Nothing was sent."
- Send takes the cross-tab capital lock (`withCapitalLock`) for the whole time from approval to confirmation. A second send, a credit purchase or a swap waits, with "Another payment is still in progress."
- The local drawing key is never used. It can't sign `Transfer` or `ft_transfer`, and this feature must not add those methods to its scope.

### 5.6 Wallet layer (`web/src/wallet.ts`, shared owner)

Extend the shared gateway rather than adding a second spending API:

- `ApprovedTransactionRequest.purpose` gains `"send"`.
- `ApprovedNearAction` gains `{type: "Transfer", params: {deposit}}`. The acquisition validator already rejects non-`FunctionCall`, so acquisition is unaffected.
- A new `validateSendTransaction(tx, request, sendPolicy)` mirrors §4.2 on the game side and is used when `purpose === "send"`. The gateway's other checks (epoch, `maxNativeSpendYocto`, unknown broadcast) apply unchanged.
- `signAndSendApprovedTransactions` gates `send` on `VITE_SEND_ENABLED`, independently of the Intents and RHEA flags. The send budget uses `playReserveYocto = SEND_GAS_FLOOR_YOCTO`, not the acquisition reserve.
- `approval.maxNativeSpendYocto` is the transfer amount (NEAR) or the registration deposit (token), plus `gasCeiling`.

## 6. Outcome states

### 6.1 Success

Success requires a final execution outcome with `SuccessValue` on every receipt of the transaction. For tokens, it also requires an NEP-141 `ft_transfer` event log for the exact `receiver_id` and `amount`, or a sender balance drop of at least `amount`. Show "Sent", the amount, the recipient (mono, with a copy button), and an explorer link for the hash (add a transaction counterpart beside `accountExplorerUrl` in `web/src/app/revenue-panel.ts`, or move both into a shared helper). Refresh balances. For mPOO, if the event log shows the recipient got less than `amount` (tax), say so: "alice.near received 970 mPOO after mPOO's transfer tax."

### 6.2 Rejected in the wallet

The user pressed Cancel before signing (`PRIVY_UNSUBMITTED_REJECTION`). Return to the form with the values kept and the note "Cancelled. Nothing was sent." This is not an error state.

### 6.3 Failed on chain

The receipt failed, for example because the recipient was unregistered after a race, the balance changed, or the token is paused. Show "The transfer didn't go through. Your TOILET is still in your account; only the network fee was spent." A registration in the same transaction was rolled back as well, so do not say it happened. Keep the raw error behind "Technical details", with secrets redacted.

### 6.4 Unknown

The broadcast may have happened (timeout, closed popup after signing, lost response). Show "We can't confirm this transfer yet." Record the hash or uncertainty in the operation store. Reconcile by looking up the transaction status by hash when known, and otherwise by comparing balances against the pre-send snapshot, for up to 2 minutes and then on demand. **Never automatically resend.** Disable Send for this asset until the state resolves or the player explicitly marks it "I've checked, start a new send". That choice still requires a full new review.

### 6.5 Error copy

| Case | Copy |
|---|---|
| Sign page refuses the request | "This transfer can't be approved here. Nothing was sent. Close this window and try again from the game." |
| Insufficient NEAR for fees | "You need about {x} NEAR for network fees. Add NEAR first." |
| Recipient check unavailable | "We couldn't check that account right now. Try again." |
| Token metadata changed | "We couldn't check this token right now. Nothing was sent." |
| Wrong network | "This app is on {network}. Switch your wallet's network and try again." |
| Account changed | "Your connected account changed. Nothing was sent." |
| Privy session expired | "Sign in again to approve this transfer." (re-auth in the window; never resubmit) |
| Popup blocked | "Your browser blocked the approval window. Allow pop-ups for this site and press Review again." |

### 6.6 Partial-failure note behaviour

- Send always produces one transaction. A send batch with more than one transaction is rejected by §4.2, so the existing note ("This sends N transactions in order. If a later one fails, the earlier ones still happen.") never appears on a Send review.
- When a send contains registration and transfer, show the atomic note from §4.5 instead.
- For every other batch (non-Send), the existing multi-transaction note keeps its current wording and condition (`transactions.length > 1`). Acceptance test: a two-transaction staking batch still shows it, and a registration-plus-transfer Send does not.

## 7. Acceptance criteria

1. A Privy player on testnet sends NEAR to a named account, an existing implicit account and a fresh implicit account. Each is confirmed by receipt, and balances move by exactly the amount, plus the fee for the sender.
2. A Privy player sends TOILET to a registered recipient (one action) and to an unregistered recipient (two actions, one transaction). The recipient's `storage_balance_of` becomes non-null and their `ft_balance_of` rises by exactly `amount`.
3. The approval screen shows the decoded recipient, an amount with correct decimals, the token contract, the registration fee when present, and "Send {amount} {symbol}" on the Approve button.
4. Every guard in §4.1 still passes its existing tests. Existing drawing-key, staking, buy-credit and RHEA reviews render exactly as before (snapshot tests).
5. NEAR Max leaves at least `SEND_GAS_FLOOR_YOCTO + gasCeiling` before the send and at least the floor after it, checked on testnet.
6. Self-send, a nonexistent named account, an unavailable RPC, an over-balance amount and a trapped-contract recipient are each blocked with the §5.2/§6.5 copy. An unavailable RPC never shows as zero or absent.
7. An unknown broadcast never triggers a resend, and a reload shows the pending operation.
8. No send uses the drawing key. The drawing key's on-chain permission is unchanged after the feature ships.

## 8. Test plan

Unit tests in `web/src/integrations/privy/privy.test.ts`, in a new `describe("reviewed sends")` block. Each rejection asserts `toThrow()` and that `sign` was never called:

- **Accepted**: a NEAR `Transfer`, a TOILET `ft_transfer`, a TOILET `storage_deposit` + `ft_transfer`, and the same for mPOO, each with the exact review rows and approve label. `args` as bytes and as an object review identically.
- **Wrong deposit**: `ft_transfer` deposits of `0`, `2`, `"01"` and `1000000000000000000000000`; a `storage_deposit` deposit of `0`, one below `.min`, and one above `SEND_STORAGE_CAP_YOCTO`; and a `Transfer` deposit of `0` or a non-integer.
- **Unknown token contract**: `ft_transfer` on `wrap.testnet`, on an account that differs only in case or by a trailing dot, and on `toilet.testnet.evil.testnet`.
- **Shape**: extra `args` keys (`memo`, `msg`); `amount` as a number; `receiver_id` equal to the signer or to the token contract; `storage_deposit.account_id` different from `receiver_id`; `storage_deposit` after `ft_transfer`; `registration_only` false or absent for a third party; two `ft_transfer`s; `Transfer` plus `FunctionCall` in one transaction; a send batch of two transactions; a send transaction followed by an unrelated transaction.
- **FullAccess `AddKey`**: rejected alone; rejected inside a send batch; rejected after a valid `Transfer`; rejected as `addFunctionCallKey` on `signIn`. The existing "rejects sponsorship, full-access additions…" test is kept unchanged.
- **Generic branch tightening**: `ft_transfer` that `classifySend` did not claim throws; a third-party `storage_deposit` alone throws; the self-registration shapes used by staking and RHEA still review.
- **Decimals drift**: `ft_metadata` returns 24 or the RPC fails, and the review rejects.
- **Network**: a mainnet token contract in a testnet payload; a missing network.
- **Identity**: a host epoch change between review and Approve aborts before `sign`.

Game-side tests in `web/src/integrations/send/*.test.ts` and `web/src/app/send-sheet.test.ts`:

- Account-ID table: valid named, implicit and ETH-implicit inputs; uppercase; leading or trailing dots; `a`; 65 characters; `alice..near`; Unicode look-alikes (Cyrillic `а`).
- An existence-check RPC timeout is *unknown*, not absent. Stale debounce results are dropped.
- Max arithmetic with exact bigints at the edges: available equal to the floor plus the gas ceiling gives a Max of 0; one yocto more gives a Max of 1 yocto.
- Registration is planned only when `storage_balance_of` is `null`. A read failure disables Review.
- Gateway: `purpose: "send"` is rejected when the flag is off; it rejects a payload that differs from the reviewed plan; and an unknown broadcast is recorded and not retried.

Browser and chain evidence (testnet, gate SEND-TESTNET): each acceptance item 1–2 with redacted hashes, before and after balances and `storage_balance_of`; a rejected-in-window case; a forced receipt failure (send to a recipient whose registration a second tab removes between review and approve), showing the registration rolled back; a popup closed after signing, which ends in the unknown state and reconciles.

Mainnet gate SEND-LIVE (separately authorised, bounded): send 1 mPOO between two team-controlled accounts and record whether the recipient receives the full amount. This settles Q2 and the §6.1 tax copy. mPOO Send stays disabled (`VITE_SEND_MPOO_ENABLED`) until this evidence is recorded.

Run focused tests, then `npm test` and `npm run build` from `web/`. A code PR needs `## Learned` in its description.

## 9. Open questions for review

- **Q1. Generic `FunctionCall` allowlist.** The sign page accepts any method on any contract with any deposit (§2.7). That is the real reason players "can't move funds" today: the game doesn't ask, not that the approval screen refuses. A compromised game bundle could request `ft_transfer_call` or a deposit-bearing call to an attacker contract, and it would review as "Calls X on Y". Recommendation: a follow-up task (listed as SEND-HARDEN) to allowlist receivers and methods the game actually uses (board, staking, TOILET, mPOO, wrap, RHEA exchange). This is out of scope here only so Send isn't blocked on it.
- **Q2. mPOO transfer tax** on plain `ft_transfer`. This is unknown until SEND-LIVE. If tax applies, should the form show "recipient receives about X" from `get_tax`, or should mPOO Send stay disabled?
- **Q3. Floor value.** Is 0.01 NEAR acceptable as a hard floor with no override? The alternative is an "I'm leaving, send everything except the fee" mode that keeps only the gas ceiling.
- **Q4. Send for non-Privy wallets.** The spec offers Send to every wallet for consistency. The alternative is Privy-only, which is a smaller surface.
- **Q5. ETH-implicit recipients.** Allowed only if they already exist. Is that worth supporting in v1 at all?
