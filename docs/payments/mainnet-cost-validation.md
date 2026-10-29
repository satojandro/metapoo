# Mainnet payment cost validation — OPEN

Created 2026-10-28. **No Meta Poo mainnet deployment exists**, confirmed by the owner.
All mainnet measurements below are pending. Local unit tests, testnet results and
mPOO token research are not mainnet payment evidence.

## When to return to this checklist

The release owner must open this checklist immediately after the first paid-board
mainnet deployment and before opening paid painting to general users. Keep backlog
item PAY-COST open until evidence is recorded and the owner accepts the costs.
Repeat affected cases after a contract, storage layout, gas budget, payment path or
network-fee change. This is a release gate, not a scheduled reminder or deployment authorization.

## Before spending any mainnet funds

- [ ] Rehearse purchases, painting and refund cases on sandbox/testnet first.
- [ ] Record the approved commit, reproducible WASM artifact/hash, schema, board
  account, mPOO account, pricing owner, network and deployed configuration.
- [ ] Agree a small mainnet test budget, test wallets and responsible operator.
- [ ] Check actual mPOO metadata, tax rules, board token registration and storage funding.
- [ ] Confirm upgrade/recovery authority and retain pre-test account/state snapshots.
- [ ] Verify the frontend targets the paid board and correct network; no mock quotes.

## Required mainnet matrix

Use bounded amounts. Each row starts pending; record transaction hashes, actual
outcomes, balance deltas and costs rather than checking it merely because it ran.

| ID | Case | What must be measured / verified | Status |
|---|---|---|---|
| C01 | Paid-board deployment and initialization | One-time gas, code/state storage, owner, schema, 0.0025 NEAR price | Pending |
| C02 | First credit-account registration | Actual storage bytes versus 0.01 NEAR charge; no credits minted | Pending |
| C03 | Duplicate / incorrect-fee registration | Rejection, attached-deposit recovery, gas still paid, no duplicate ledger | Pending |
| C04 | NEAR purchase: 1, 10 and 100 credits | 0.0025 / 0.025 / 0.25 NEAR deposits; exact credits; gas separately | Pending |
| C05 | Repeated NEAR purchase | Existing-account storage growth and gas versus first purchase | Pending |
| C06 | mPOO registration prerequisites | First-time wallet/board FT registration costs, separate from paint credits | Pending |
| C07 | Direct mPOO purchase, first and repeat | Actual payer debit, board receipt, callback amount, credited amount, all receipt gas; verify tax behavior | Pending |
| C08 | Rejected mPOO purchase | Malformed message, old price, non-multiple, unmet minimum and unregistered credit account: no credits, resolver refund, final net token loss if any | Pending |
| C09 | Rejected NEAR purchase | Old price, non-multiple, unmet minimum and unregistered account: no credits, deposit refunded, gas cost | Pending |
| C10 | First paint into an empty cell | Exactly one credit spent; new pixel bytes, gas and final pixel evidence | Pending |
| C11 | Repaint / overwrite | Same owner and different owner; same and different color; varying account-ID lengths; one credit per submitted entry | Pending |
| C12 | Batches of 1, 10 and 64 entries | Empty / existing / mixed cells; total gas, gas per entry, storage, correct debit | Pending |
| C13 | Repeated coordinates in a batch | Debit per entry, final last-write behavior; ensure UI does not accidentally duplicate entries | Pending |
| C14 | Failed single/batched paint | Insufficient credits, invalid cell/color, over-limit batch: unchanged pixels/credits, actual gas paid | Pending |
| C15 | Drawing-session key | Setup/revoke cost, allowance/nonce changes, paid draw authorization, budget exhaustion behavior | Pending |
| C16 | Owner price update | Authorization, gas, unchanged purchased balances, stale checkout rejection/refund | Pending |
| C17 | Reconciliation and recovery | Wallet cancel, disconnect, RPC timeout, reload after broadcast; no automatic double-payment, final balance refresh | Pending |
| C18 | Larger populated board | Repeat reads/writes as occupancy grows; bounded batch gas; use bounded sampling plus conservative storage projection, not automatic full-board filling | Pending |

Embedded swaps and the inventory shop are deferred. If introduced, add a separate
matrix covering every route leg, tax, slippage, incomplete swaps, failed delivery,
refunds and inventory replacement costs. An external NEARLY purchase is not paint revenue.

## How to calculate costs

1. Fetch complete transaction outcomes with `wait_until: FINAL`, including refund
   receipts. Check every receipt and the final credit/pixel state.
2. Sum `tokens_burnt` once across the transaction outcome and all receipt outcomes;
   divide by 10^24 to report NEAR. Record gas units too. Attached deposits and
   prepaid gas limits are not actual execution fees.
3. Record purchase deposits, actual refunds, FT debits/receipts and registration
   fees separately. Do not infer gas from a wallet balance delta containing these.
4. Read contract `storage_usage` before and after an isolated case. Multiply the
   increase by the network's applicable storage-byte price, recorded with its
   block/config evidence. Storage is locked capital, not a recurring gas burn.
   Concurrent transactions invalidate a simple block-to-block attribution; isolate
   testing or use transaction-specific changes. Deletion can release backing.
5. Separate user-paid gas from any contract-sponsored gas and contract storage.
   Record contract execution rewards separately; do not rely on them for margins.
6. Amortize purchase and onboarding costs explicitly over 1, 10 and 100 pixels;
   divide stroke gas by successful entries. Failed transactions still cost gas.

## Evidence record (one per case / sample)

Store results under `docs/research/mainnet-payments/` when tests actually happen.
Record: case ID, UTC timestamp, commit/artifact hash, network, account IDs, tx hash
and signer, block heights, complete receipt results, amount sent/accepted/refunded,
credits before/after, successful entries, gas and fee totals, storage before/after,
byte price, payer, expected/actual result, and explorer/raw evidence paths.
Use public account IDs only; never store keys or seed phrases. Include failures.
Repeat representative cases and report sample count, median and maximum; one result
is an observation, not a reliable upper bound.

## Acceptance and pricing decision

- [ ] All cases have evidence or an explicit owner-approved deferral and reason.
- [ ] Every accepted payment matches credits; rejected ones reconcile refunds.
- [ ] Registration fee covers measured maximum supported account-record storage.
- [ ] Budget covers deployment/code storage, users and a fully populated board;
  mPOO receipts alone cannot supply NEAR storage backing.
- [ ] 64-entry strokes fit the configured gas budget with documented headroom.
- [ ] Report operating margin and storage capital separately at 0.0025 NEAR/credit.
  Include infrastructure, optional gas sponsorship, failed-call allowance and
  mPOO realizable conversion costs. No dollar profit promise from a NEAR price.
- [ ] Owner approves pricing/reserves and any fee-disclosure changes before public launch.

Sources: [transaction RPC](https://docs.near.org/api/rpc/transactions),
[NEAR storage](https://docs.near.org/protocol/storage/storage-staking),
[NEARLY tax/trading](https://nearly.trade/docs).
