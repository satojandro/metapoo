# First mainnet buyback run — 2026-11-10

The keeper's first successful end-to-end run on mainnet: NEAR from credit sales swapped to
mPOO and returned to the board. Everything below is from `~/Library/Logs/metapoo/buyback-2026-11-10.log`
and read back from chain via RPC.

## What blocked it (root cause)

Every attempt from 9 Nov 21:23 UTC failed at the first swap with
`NotEnoughBalanceError: balance: 0.376193…, cost: 0.486094…` — the cost decomposes exactly as:

| component | yoctoNEAR |
|---|---|
| wrap deposit (the chunk) | 274373874747706410000009 |
| 1 yocto (`ft_transfer_call`) | 1 |
| 210 Tgas prepaid at **1e9 yocto/gas** | 210000000000000000000000 |
| tx→receipt conversion at 1e8 | 1720945728733500000000 |
| total | **486094820476439910000010** ✓ |

Mainnet is on protocol version 88 with `min_gas_price = 1000000000` (1e9 yocto/gas,
"1 NEAR per Pgas") — the minimum gas **purchase** price is now 10x the old 1e8 minimum, while
`gas_price` RPC still reports 1e8 (the burn price). The keeper was sized for the old world:
`BUYBACK_GAS_RESERVE=0.1` covered ~1e14 gas at 1e8 but only half of one 210 Tgas transaction at
1e9. No run could ever succeed; the failure cost nothing (rejected at validation, nothing burned).

**Fix:** `BUYBACK_GAS_RESERVE` 0.1 → 0.5 in the runner (owner-approved). The spec K2 default of
1 NEAR was already sized for this; the testing round had lowered it assuming 1e8.

## Second blocker found by the first run

The swap legs succeeded immediately; the return to the board failed with
`The receiver is not registered` — the **board** had no storage registration on mPOO
(min = max = 0.00125 NEAR). Registered 10 Nov ~00:30 UTC, tx
[`AHoZVVMve46w4VPFy7ZBsb5nsAMfQNF6h9qsmAVZcebE`](https://explorer.near.org/transactions/AHoZVVMve46w4VPFy7ZBsb5nsAMfQNF6h9qsmAVZcebE),
signed by the buyback account, verified by `storage_balance_of` read-back.
The keeper's preflight only checks registrations for tokens landing on the *buyback* account;
the board's own registration on its revenue token is a gap it cannot see. Candidate follow-up:
preflight warning when the board is unregistered on the final token.

## The successful runs (01:23 UTC, chunk capped at 0.1 NEAR for the first live swap)

| tx | what |
|---|---|
| [`68DyXw3CSBApAbKdZTrRERT3UYcWZA9snMsb96MirvaU`](https://explorer.near.org/transactions/68DyXw3CSBApAbKdZTrRERT3UYcWZA9snMsb96MirvaU) | 10 Nov 00:23 — wrap + Ref 6458: 0.1 NEAR → 9.3519 RHEA, `differenceBps: 0` |
| [`2tQ69RTKPWrBvqoBUHPRTYa2AZuwGfwDHsmAVhNbtrtX`](https://explorer.near.org/transactions/2tQ69RTKPWrBvqoBUHPRTYa2AZuwGfwDHsmAVhNbtrtX) | DCL → mPOO: 45,855.5798 mPOO vs quote 46,791.4080 — `differenceBps: 200` (the 2% buy tax, taken once, below `min_amount_out` as predicted, logged `belowMinimum`, not fatal) |
| [`APueiH7YocrJTRH7VETLurGaFCHHnpF2dGetNxu8gLYQ`](https://explorer.near.org/transactions/APueiH7YocrJTRH7VETLurGaFCHHnpF2dGetNxu8gLYQ) | 01:23 — return first: the stranded 45,855.58 mPOO to the board, accepted in full |
| [`EpE2RF4Bj16ZoRScvfCJayL5k251qBmquuyXJBfuho2i`](https://explorer.near.org/transactions/EpE2RF4Bj16ZoRScvfCJayL5k251qBmquuyXJBfuho2i) | second chunk: wrap + Ref |
| [`4GoQBJ2qydu3qkKfzEbGKGHy7RZC6wr37ssAc6YzPfJe`](https://explorer.near.org/transactions/4GoQBJ2qydu3qkKfzEbGKGHy7RZC6wr37ssAc6YzPfJe) | second chunk: DCL → mPOO |
| [`GbiBAb54TtPzd9SykoAKMzfvBaW5vzx89M2tLiYiejti`](https://explorer.near.org/transactions/GbiBAb54TtPzd9SykoAKMzfvBaW5vzx89M2tLiYiejti) | after-swap return: 45,936.7474 mPOO to the board, accepted in full |

Summary line: `outcome ok, failures 0, nearSwapped 0.2, mpooReturned 91792.327…`.

Chain read-back after the run: `get_buyback_totals.mpoo_returned = 91792327323990483231931`,
`get_revenue_state.mpoo_undistributed` = the same, awaiting the next `distribute_mpoo`
(10/20/70 split, stakers' 70% via the staking contract).

## "What is not proven" items this run answers

- Ref v2 instant swap **does** send the output back to an account with no Ref registration
  (RHEA landed on the buyback account).
- DCL multi-pool `Swap` **does** send the output to the sender; a failed `min_output_amount`
  was not observed (nothing to report on partial fill).
- mPOO's 2% tax is taken **once**, after the exchange's minimum check, on the multi-pool DCL
  output — `differenceBps` measured exactly 200, not ~300, so DIARHEA's 1% tax did not touch
  the DIARHEA that stayed inside the DCL.
- Gas: the wrap+Ref tx prepaid 210 Tgas; the DCL step and both returns also succeeded at the
  configured gas, so 200/100 Tgas attachments are sufficient on mainnet.

Still unproven: behaviour when `min_output_amount` fails or a DCL pool runs dry (partial fill),
and whether the NEARLY token tax stays as read — both need a forced-refund run to observe.

## Config state after this evidence

Runner: `BUYBACK_GAS_RESERVE=0.5`, `BUYBACK_MIN_CHUNK_NEAR=0.05`,
`BUYBACK_MAX_CHUNK_NEAR=0.5` (restored after the capped first swap succeeded, owner-approved).

## Same wall hits the distribution keeper (same day)

The 02:07 UTC keeper run failed `distribute_mpoo` with the identical v88 arithmetic: gas account
`247460301…803147` held 0.0506 NEAR, the 150 Tgas attach costs 0.1509 prepaid at 1e9/gas
(`balance: 50588562031272499999984, cost: 150918984523193500000000`). That keeper had never sent
a transaction before (its full-access-free gas account was never drained). Owner funded it
(+0.5 NEAR, 10 Nov ~03:00 UTC).

**Recipients of the mPOO split must be storage-registered on mPOO.** An owner-signed
`distribute_mpoo` from the web dashboard partially succeeded: staking contract (70%) and the
burn sink (20%) are registered and were paid; the team account transfer (10%) failed with
`The receiver is not registered` and was refunded to `mpoo_undistributed` (state showed exactly
10% of the returned amount left). Registrations added 10 Nov, signed by the buyback account:

- board `fcd66acf…` (tx `AHoZVVMve46w4VPFy7ZBsb5nsAMfQNF6h9qsmAVZcebE`, ~00:30 UTC)
- team `816562893d…186ab51` (~03:05 UTC, before the 15:07 AEDT retry)

Burn sink `000…000` and staking `57590a9e…` were already registered.

**Outcome (verified on chain):** the 15:07 AEDT keeper run distributed the remaining 10% —
tx [`5iLY26JEnX921ufAvbpqLSdy1hoKpVTBMVUwitJq8kJ2`](https://explorer.near.org/transactions/5iLY26JEnX921ufAvbpqLSdy1hoKpVTBMVUwitJq8kJ2),
then `sync_inflow` on the staking contract
([`2dwcf2FUBroKvr8RRZ5D7CJDugZCBxSKwStSpcjV6zsJ`](https://explorer.near.org/transactions/2dwcf2FUBroKvr8RRZ5D7CJDugZCBxSKwStSpcjV6zsJ)).
`get_revenue_state.mpoo_undistributed` = 0; team balance = the exact 10%
(9179232732399048323193 raw). First complete revenue loop: credits → NEAR → 90% buyback →
swap → mPOO returned → 10 / 20 / 70 split, every share delivered.

**Preflight gap (candidate follow-up):** the buyback keeper's preflight checks storage
registrations only for tokens landing on the buyback account. Neither keeper checks that the
split's recipients (team, burn, staking) are registered on mPOO — both failures today were of
this class.
