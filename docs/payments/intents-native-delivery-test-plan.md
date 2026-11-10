# Intents native-NEAR delivery test — brief for Hermes

ACQ-4, Intents step 2. Step 1 (browser transport) passed on 2026-11-10:
[`intents-transport-check-2026-11-10.md`](intents-transport-check-2026-11-10.md).

## What we need to prove

That a 1Click swap into `nep141:wrap.near` with `recipientType: DESTINATION_CHAIN` lands as
**native NEAR** (not wNEAR) in the recipient account, for all three account types the code
gates on (`INTENTS_NATIVE_EVIDENCE` in `web/src/integrations/release-evidence.ts`):

| Field | Case | How |
| --- | --- | --- |
| `uninitializedImplicit` | 64-hex account that is **not on chain yet** (a brand-new Privy player) | Deposit **A** |
| `initializedImplicit` | Same account after it exists | Deposit **B** |
| `initializedNamed` | A named account such as `something.near` | Deposit **C** |

The first case matters most. wNEAR can't fund an account that doesn't exist yet: it has no
storage and no NEAR to unwrap with. If the first deposit arrives as wNEAR, or fails, then
Intents can't onboard a new player as built.

## Budget

Three deposits of **1–2 USDC on Base** (≈0.28–0.55 NEAR each at today's price). You need a
Base wallet with ~6 USDC plus a little ETH for Base gas. Use that wallet's address as `refundTo`.

## Recipients

- **A and B:** the owner's Privy account (`cc9a…d113`). Copy the full 64-character id from the
  wallet panel ("Your account" → Copy address, once the branch with that block is deployed)
  or ask the owner. Check first that it is still **not on chain** (step 1 below). If it already
  exists, sign in to Privy with a fresh email to get a new account and use that for A.
- **C:** any named mainnet account the owner controls.

## Per deposit

Set `R` to the recipient and `REFUND` to your Base address. RPC: `https://rpc.mainnet.fastnear.com`.

1. **Before:** record native balance and wNEAR balance.

   ```bash
   curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$R\"}}"
   ```

   ```bash
   curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"wrap.near\",\"method_name\":\"ft_balance_of\",\"args_base64\":\"$(printf '{"account_id":"%s"}' "$R" | base64 -w0)\"}}"
   ```

   For A, the first call must return an `UNKNOWN_ACCOUNT` error. Save both outputs.

2. **Real quote** (`dry: false`, 1 USDC = `1000000`). Save the whole response.

   ```bash
   curl -s https://1click.chaindefuser.com/v0/quote -H 'content-type: application/json' -d "{\"dry\":false,\"swapType\":\"EXACT_INPUT\",\"slippageTolerance\":100,\"originAsset\":\"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near\",\"destinationAsset\":\"nep141:wrap.near\",\"amount\":\"1000000\",\"depositType\":\"ORIGIN_CHAIN\",\"recipientType\":\"DESTINATION_CHAIN\",\"refundType\":\"ORIGIN_CHAIN\",\"recipient\":\"$R\",\"refundTo\":\"$REFUND\",\"deadline\":\"$(date -u -d '+20 min' +%Y-%m-%dT%H:%M:%S.000Z)\",\"depositMode\":\"SIMPLE\"}"
   ```

   Check before paying: `quote.depositAddress` is present, `quoteRequest.recipient` is exactly
   `R`, and `appFees` is one entry to `5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd`
   at ≤25 bps (20 seen on 10 Nov). Stop and report if any of these differ.

3. **Pay:** send exactly `amountIn` USDC on Base to `quote.depositAddress` before the deadline.
   Record the Base tx hash.

4. **Poll** every ~15 s until the status is `SUCCESS`, `REFUNDED` or `FAILED`. Save the final response.

   ```bash
   curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=<depositAddress>"
   ```

5. **After:** repeat step 1. Also fetch each NEAR tx hash from the final status
   (`swapDetails.destinationChainTxHashes`, or wherever it appears):

   ```bash
   curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"EXPERIMENTAL_tx_status\",\"params\":{\"tx_hash\":\"<hash>\",\"sender_account_id\":\"$R\",\"wait_until\":\"FINAL\"}}"
   ```

   If `sender_account_id = R` is rejected, retry with the tx's signer, or look the hash up on nearblocks.io.

## Pass criteria (each deposit)

- Status `SUCCESS`.
- Native `amount` rose by roughly `amountOut` (minus at most a tiny storage amount). For A,
  the account now **exists**.
- wNEAR `ft_balance_of` is **unchanged** (0 for A).
- The NEAR-side receipt that credits `R` is a native **Transfer** (or `near_withdraw` → Transfer)
  to `R`, not only an `ft_transfer` of wNEAR.

## What to send back

For each deposit: recipient, quote JSON, Base tx hash, final status JSON, before/after
`view_account` and `ft_balance_of`, NEAR tx hash(es), pass/fail. If A arrives as wNEAR or
fails, **stop there** and don't run B or C; that result changes the design.

Claude then fills `INTENTS_NATIVE_EVIDENCE` (`reference` = the record doc, plus the three
booleans) and writes `docs/payments/intents-native-delivery-<date>.md`.
