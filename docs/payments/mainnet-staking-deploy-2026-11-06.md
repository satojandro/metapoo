# Staking contract deploy + board activation — 2026-11-06

`contracts/toilet-staking` deployed to mainnet and the testing board pointed at it by owner
decision. The board's `set_staking_contract` is callable **once, ever**; this record is the
chain evidence for that call.

## Account

| | |
|---|---|
| Contract | `57590a9ebbf63e72818971b1cfa9cba992839c1b5763e54d54dd631db9fef55c` (implicit) |
| Funded by owner | 4.0 NEAR |
| Key | full-access key on the Mini (`~/.near-credentials/mainnet/` + keys dir). **Retained for the testing round** so the account can later be deleted and the ~2.3 NEAR storage reclaimed. Must be deleted before any launch board points at a production staking contract (README procedure) |

## Artifact

| | |
|---|---|
| source | `main` (toilet-staking crate; sim + 28 unit tests green before deploy) |
| build | `cargo near build non-reproducible-wasm` |
| size | 227,092 B |
| sha256 | `aa4b899db186ac4832d6d4e5f9c198663de0334df8b9368e8c6922d8a2edeeed` (bs58 `CTm7dvDgof6oTFwxeRmDCyFN6fbxMNkGWTdgsWaz3fHv` — matches live code hash exactly) |

## Transactions

| Step | Result |
|---|---|
| `near deploy` (self-signed) | code hash `CTm7dvDg…sWaz3fHv` live |
| `new(toilet, mpoo, board)` | succeeded — binds `a571dead…801ee`, `mpoo.nearlytrade.near`, board `fcd66acf…76f59e`. No owner, no upgrade, immutable from here |
| `storage_deposit` on TOILET (0.002) | succeeded, self-signed |
| `storage_deposit` on mPOO (0.002) | succeeded, self-signed |
| `storage_deposit` burn address `000…0` on TOILET (0.002, fee signer) | succeeded — required for the unstake burn |
| **`set_staking_contract("57590a…")` on the board, 1 yocto, signed by the board's own key (owner)** | **succeeded — one-time, irreversible** |

First call attempt without the 1-yocto deposit panicked `Requires attached deposit of exactly 1
yoctoNEAR`; second attempt with it succeeded. No state was touched by the failed call.

## Verification (live reads)

- `get_revenue_state.staking_contract` on the board → `57590a9e…fef55c`.
- `get_config` → toilet/mPOO/board/burn bindings correct, `drip_bps` 1000, `exit_tax_bps` 1000.
- `get_pool` / `get_accounting` → pool 0, staked 0, released 0 (clean start).
- Storage registrations verified on both tokens for the staking contract; burn address registered on TOILET.
- Balance after everything: 3.9936 NEAR on the staking account.

## Web

No frontend change needed: the stake page reads the staking contract id from the board's
`get_revenue_state` (the "board publishes its staking contract" path), so
https://metapoo-testnet.vercel.app picks the contract up on the next load.

## What is still unproven

- A real `stake` (TOILET `ft_transfer_call` with `msg stake`) from a wallet.
- The mPOO inflow path: the board only forwards the stakers' 70% inside `distribute_mpoo`, and
  no distribution has ever run (`withdrawable_near` 0; keeper not running). First inflow
  needs the board topped up ~1.1+ NEAR past its reserve and a keeper or manual
  `distribute_near` → swap → `distribute_mpoo` chain.
- `sync_inflow` keeper flag (defaults off) still to be enabled when the keeper is stood up.

## Traps hit

- `near` CLI 0.30.1 subcommand chain is strict:
  `as-transaction <acct> <method> json-args '<json>' prepaid-gas '<N> Tgas' attached-deposit
  '<N> NEAR' sign-as <signer> network-config mainnet sign-with-keychain send`. Deposits need a
  unit (`0 NEAR`, `1 yoctoNEAR`), bare `0` is rejected.
- Hand-written credential JSON must use **base58** for `public_key`, not base64.
