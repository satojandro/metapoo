# Buyback keeper

Work order TR-K ([`buyback-keeper.task.json`](../../docs/implementation/buyback-keeper.task.json)).
Spec: [TOILET round](../../docs/economy/2026-11-02-toilet-round-spec.md) §K (K1–K3, K5), owner
decision T10.

`distribute_near` sends 90% of the board's NEAR revenue to `buyback_account` as a plain transfer.
The board takes mPOO back from that account only, by `ft_transfer_call` with
`msg = {"revenue":{}}`, and the next `distribute_mpoo` splits it 10 / 20 / 70. Nothing swapped the
NEAR in between. This script does: once a run, it swaps one capped chunk of the buyback account's
NEAR to mPOO and sends the mPOO to the board.

**Status:** code and unit tests only. Nothing here has signed a transaction on any network. The
testnet run is a follow-up for Hermes (keys, accounts, a testnet route). The mainnet route below
has quotes and pool reads behind it but has **never been executed**. See "What is not proven".

## What it does

Each run, in order. Every step writes one JSON line.

| step | what happens |
|---|---|
| `preflight` | Reads `get_revenue_state` on the board. Stops, signing nothing, unless `buyback_account` is this account and the route ends in the board's `mpoo_token`. Also checks the account has a storage registration on every token that lands on it (`storage_balance_of`) |
| `return` (`phase: before_swap`) | **Return first.** Any mPOO already on the account, left by an earlier run whose return failed, goes to the board: `ft_transfer_call(board, all, '{"revenue":{}}')`, 1 yocto |
| `unwrap` | Any wNEAR on the account, left by a swap the exchange refunded, is unwrapped (`near_withdraw`) so it gets sized again as NEAR |
| `swap` (`resumed: true`) | If an intermediate token of the route is on the account (a later step failed last time), the rest of the route runs first |
| `size` | `available = spendable NEAR - BUYBACK_GAS_RESERVE`. `chunk = min(available, BUYBACK_MAX_CHUNK_NEAR, largest amount whose quoted price impact <= BUYBACK_MAX_IMPACT_BPS)`. Skipped (`reason: below_minimum`) when the chunk is under `BUYBACK_MIN_CHUNK_NEAR`. `binding` says which cap set the chunk: `balance`, `max_chunk` or `price_impact` |
| `swap` | One transaction per route step. The first wraps and swaps together (`near_deposit` + `ft_transfer_call` on the wrap token). Each step's `min_amount_out` is a **fresh quote taken just before it, less `BUYBACK_SLIPPAGE_BPS`** |
| `return` (`phase: after_swap`) | The mPOO received goes to the board as above |
| `summary` | NEAR swapped, mPOO the board accepted, failure count, exit code |

Price impact is measured against a quote for `BUYBACK_MIN_CHUNK_NEAR / 100`: the reference rate
times the amount is the no-impact output, and the shortfall of the real quote from that is the
impact. Fees are proportional, so they cancel. If the cap breaches the limit, the chunk is found by
bisection (to 0.5% of the cap).

**The tax.** mPOO charges a 2% buy tax on transfers out of RHEA DCL (`get_tax` on
`mpoo.nearlytrade.near`, below). It is taken **after** the exchange's minimum-output check, so
the last step normally lands under the quote, and with 1% slippage, under `min_amount_out` too.
The keeper doesn't treat this as a failure. It logs `quotedOut`, `minAmountOut`, `received`,
`differenceBps`, `warning: "received_below_quote"` and `belowMinimum: true`. Those lines are the
"tax and fees as observed" that K5 needs.

Value moved is measured from **balances before and after** each transaction, never from the
transaction status: `ft_transfer_call` succeeds at the top level even when the receiver refunds
everything. Transactions wait for `FINAL` so the balances read afterwards include every refund.

Example lines (shortened):

```json
{"ts":"…","network":"testnet","board":"board3.OWNER.testnet","buyback":"buyback.OWNER.testnet","route":"…","step":"size","outcome":"sized","available":"19000000000000000000000000","chunk":"2000000000000000000000000","binding":"max_chunk","impactBps":42,"routeQuotedOut":"853075…"}
{"ts":"…","step":"swap","index":2,"resumed":false,"venue":"dcl","tokenIn":"token.rhealab.near","tokenOut":"mpoo.nearlytrade.near","amountIn":"163…","quotedOut":"853075…","minAmountOut":"844544…","received":"836013…","differenceBps":200,"warning":"received_below_quote","belowMinimum":true,"outcome":"swapped","txHash":"…"}
{"ts":"…","step":"return","phase":"after_swap","outcome":"returned","amount":"836013…","accepted":"836013…","txHash":"…"}
```

Outcomes: `ok`, `returned`, `swapped`, `unwrapped`, `sized`, `skipped`, `nothing_to_do`, `failed`
(with `detail`, and for a swap, `left`: where the value now sits).

**Exit codes:** 0 when nothing failed (a skipped run is 0), 1 when any step failed, 2 on a
configuration error.

### Failures leave value where it is

| what failed | where the value is | next run |
|---|---|---|
| the first swap transaction never landed | NEAR on the account | sizes it again |
| the exchange refunded (slippage, no liquidity) | wNEAR on the account | `unwrap`, then sizes it again |
| a later step | the intermediate token (e.g. RHEA) | resumes the route from that step before anything new |
| the return to the board | mPOO on the account | `return` first |
| the board refunded the return (`revenue_rejected: NotBuybackAccount`) | mPOO on the account | the run fails at `preflight` until the board's `buyback_account` is right |

After any swap failure the run doesn't size a new chunk. It still tries to return whatever mPOO
it holds.

## The trust it carries, and why

This is the one trusted step left in the revenue path (spec K, T10). Until a buyback contract
replaces it, 90% of the board's NEAR revenue passes through an account controlled by a key:

- **The key can take everything on the buyback account.** That is the NEAR waiting to be swapped
  and any mPOO waiting to go back. Nothing on chain stops it: the board sends the NEAR away with
  no strings attached.
- **It can't touch the board.** The board only accepts mPOO from this account. It never sends it
  anything but the 90% share. A leaked key loses what is on the account, nothing more.
- **It decides when and whether to buy.** It could stop. It could also trade badly, within the
  configured limits. Anyone can check: `/money` (K4) compares `near_distributed` with
  `mpoo_revenue_received` from board events, plus the NEAR waiting on the account.
- **The owner can move it.** `set_buyback_account` can repoint the 90% once every 7 days. That's
  the recovery path if the key leaks, and the path to a contract (K5) with no board change.

The keeper keeps exposure small by swapping in capped chunks every run and logging every step. One
thing to watch: if hourly revenue is larger than the chunk the price-impact cap allows, NEAR builds
up on the account. That isn't a loss, but it grows what the key controls. The `size` line shows it
(`available` against `chunk`).

## Configuration

Environment variables only. All are checked before anything is signed. Errors name the variable,
never its value. The key is held off the config object's enumerable properties, so it can't be
logged by accident.

| variable | required | notes |
|---|---|---|
| `BUYBACK_NETWORK` | yes | `testnet` or `mainnet`. Account ids with the other network's suffix (anywhere, including the route) are rejected |
| `BUYBACK_RPC_URL` | no | defaults to `https://rpc.testnet.near.org` / `https://rpc.mainnet.near.org`, the same as `ops/keeper`. **Set it.** On 3 Nov 2026 the public mainnet endpoint answered with `-429 "THIS ENDPOINT IS DEPRECATED"` after a few dozen reads |
| `BUYBACK_RPC_API_KEY` | no | bearer token for a paid RPC (FastNEAR). Sent as an `Authorization` header, never in the URL; non-enumerable on the config. From a secret env var only; see [`../../docs/ops/fastnear-rpc.md`](../../docs/ops/fastnear-rpc.md) |
| `BUYBACK_BOARD_CONTRACT_ID` | yes | the board |
| `BUYBACK_ACCOUNT_ID` | yes | the dedicated buyback account, which must be the board's `buyback_account`. Must not be the board |
| `BUYBACK_PRIVATE_KEY` | yes | `ed25519:…` full-access key of that account (below). Secret env var only |
| `BUYBACK_ROUTE` | yes | the swap route as JSON (below) |
| `BUYBACK_WRAP_TOKEN_ID` | no | defaults to `wrap.testnet` / `wrap.near`. The route must start with it |
| `BUYBACK_GAS_RESERVE` | no | NEAR kept back for gas, default `1` (spec K2). At least 0.1 |
| `BUYBACK_MAX_CHUNK_NEAR` | yes | the most NEAR one run swaps. No default: owner's call per network |
| `BUYBACK_MIN_CHUNK_NEAR` | yes | below this the run skips. Must not exceed the max |
| `BUYBACK_MAX_IMPACT_BPS` | no | default 50 (spec K2), 1–1000 |
| `BUYBACK_SLIPPAGE_BPS` | no | default 100 (spec K2), 1–500. Applied to each step's fresh quote |
| `BUYBACK_GAS_SWAP_TGAS` | no | prepaid gas for each swap's `ft_transfer_call`, default 200 (50–290; the first step adds 10 for `near_deposit`) |
| `BUYBACK_GAS_RETURN_TGAS` | no | prepaid gas for the return, default 100 (30–300) |

Amounts are decimal NEAR (`2.5`). Everything is integer arithmetic in yocto, with no floats.

### The route (`BUYBACK_ROUTE`)

The route is configuration, not code (K3). It has 1–4 steps. **Each step is one transaction on one
exchange contract**: an `ft_transfer_call` of the step's first token, swapping through one or more
pools on that exchange, with the output sent back to the account. A step boundary sits wherever the
route changes exchange, because each exchange checks its own minimum.

```json
{"id": "near-ref6458-rhea-dcl-diarhea-mpoo",
 "steps": [
  {"venue": "classic", "exchange": "v2.ref-finance.near",
   "tokens": ["wrap.near", "token.rhealab.near"], "pools": [6458]},
  {"venue": "dcl", "exchange": "dclv2.ref-labs.near",
   "tokens": ["token.rhealab.near", "diarhea.nearlytrade.near", "mpoo.nearlytrade.near"],
   "pools": ["diarhea.nearlytrade.near|token.rhealab.near|10000",
             "diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000"]}]}
```

- `classic` = Ref v2: integer pool ids, quoted with `get_return` per pool. The message is
  `{"actions":[{pool_id, token_in, token_out, amount_in (first only), min_amount_out ("0" except the last)}]}`.
- `dcl` = RHEA DCL: pool ids `tokenX|tokenY|fee`, quoted with `quote`. The message is
  `{"Swap":{"pool_ids":[…],"output_token":…,"min_output_amount":…}}`. These are the same shapes as
  `web/src/integrations/rhea/plan.ts`.
- Validation: steps connect, the first starts with the wrap token, no token repeats, DCL pool ids
  join their two tokens. On **mainnet** only `v2.ref-finance.near` and `dclv2.ref-labs.near` are
  accepted as exchanges. Another exchange needs a code change and review, not an env var.

## The route and its evidence (K3)

Captured 3 Nov 2026, 00:02 UTC, mainnet blocks 222791421–222791460, by
[`scripts/discover-route.js`](scripts/discover-route.js): public read-only view calls, no key,
nothing signed. The full output (every read with block height, the pool scan, the quote table) is
[`evidence/2026-11-03-mainnet-route.json`](evidence/2026-11-03-mainnet-route.json). Reproduce:

```sh
cd ops/buyback && DISCOVER_RPC_URL=https://free.rpc.fastnear.com node scripts/discover-route.js > /tmp/route.json
```

It builds on the web's investigation ([`docs/research/2026-11-03-rhea-route-evidence.md`](../../docs/research/2026-11-03-rhea-route-evidence.md)),
which found the final DIARHEA/mPOO pool live but no complete NEAR→mPOO route. Two things that work
missed:

1. **DIARHEA's own launch quote token is RHEA (`token.rhealab.near`), not REF
   (`token.v2.ref-finance.near`).** `nearlytrade.near get_launch_by_token {"token":"diarhea.nearlytrade.near"}`
   returns `"quote": "token.rhealab.near"` and the pool `diarhea.nearlytrade.near|token.rhealab.near|10000`.
   The web probes used the REF token, whose DIARHEA pools don't exist.
2. **The wNEAR leg is on Ref classic, not DCL.** All four DCL `token.rhealab.near|wrap.near` pools
   are `Running` with `liquidity: "0"` at the current point, and every DCL-only quote returns 0. Ref
   classic pool **6458** (`SIMPLE_POOL`, RHEA/wNEAR, 0.30% fee) holds about 10.03 M RHEA and
   122,129 wNEAR.

**Observed:**

| read | result |
|---|---|
| `mpoo.nearlytrade.near get_tax` | `buy_bps 200, sell_bps 300, pairs ["dclv2.ref-labs.near"], admin nearlytrade.near` |
| `diarhea.nearlytrade.near get_tax` | `buy_bps 100, sell_bps 100, pairs ["dclv2.ref-labs.near"]` |
| DCL `diarhea…|mpoo…|10000` | Running, liquidity 4.15e21 (the NEARLY launch pool for mPOO) |
| DCL `diarhea…|token.rhealab.near|10000` | Running, liquidity 3.30e20 (the NEARLY launch pool for DIARHEA) |
| DCL `token.rhealab.near|wrap.near` at 100/400/2000/10000 | Running, liquidity 0 at the current point |
| DCL `mpoo|wrap.near`, any fee | absent |
| DCL `meta-pool.near|mpoo…|10000` (the mPOO/stNEAR pool, economy doc §14) | Running, liquidity 0 |
| Ref classic, all 8,995 pools scanned | 6458 RHEA/wNEAR (deep). 8713 / 8715 / 8938 DIARHEA/wNEAR (fees 5% / 10% / 7%). 8861 mPOO/stNEAR: 25,497 mPOO against **0.027 stNEAR**, which is too shallow to use. No mPOO/wNEAR pool |
| code hashes | `v2.ref-finance.near` GZmkbfVL…, `dclv2.ref-labs.near` BzhtCCGJ…, `wrap.near` DL2f5xmZ…, `token.rhealab.near` 3XbB1xkQ…. Both NEARLY tokens report `11111111111111111111111111111111` (no local code; they run a global contract, so `view_account` can't pin their code) |

**Candidate quotes** (gross mPOO before the 2% buy tax; impact against a 0.01 NEAR reference):

| route | 0.1 NEAR | 1 NEAR | 2 NEAR | 5 NEAR | 10 NEAR |
|---|---|---|---|---|---|
| **classic 6458 → DCL RHEA→DIARHEA→mPOO** | 42,823 (2 bps) | 427,425 (21) | 853,075 (42) | 2,119,477 (104) | 4,195,632 (205) |
| classic 8715 → DCL DIARHEA→mPOO | 39,738 (5) | 395,533 (52) | 786,995 (103) | 1,937,567 (254) | 3,779,342 (495) |
| classic 8713 → DCL DIARHEA→mPOO | 37,592 (19) | 369,131 (200) | 723,730 (393) | — | — |
| DCL only (any RHEA/wNEAR fee) | 0 | 0 | 0 | 0 | 0 |

The candidate route is the one in the JSON above. It gives the best output at every size, and on
this snapshot the 50 bps impact cap binds at about 2.4 NEAR per chunk. Its cost at zero impact is
about 0.3% + 1% + 1% pool fees plus the 2% tax, roughly 4.3%.

### What is not proven

- **No swap on this route has been executed.** A quote isn't delivery.
- Ref v2 *instant swap*: whether `ft_transfer_call` with `{"actions":[…]}` sends the output back to
  an account with no Ref deposit or registration, as `plan.ts` also assumes.
- DCL multi-pool `Swap`: whether output goes to the sender, and whether all input is refunded when
  `min_output_amount` fails or a pool runs dry (partial fill). The keeper reads `inputLeft` either way.
- How mPOO's 2% tax rounds, and that it is taken once on a multi-pool DCL output. Also whether
  DIARHEA's 1% tax touches DIARHEA that never leaves the DCL inside the swap. If it did, the
  keeper's `differenceBps` would show about 300 instead of 200.
- That the NEARLY token code (global contract, admin `nearlytrade.near`) and its tax stay as read.
- Gas used per step.

The testnet run covers the keeper's own behaviour, but testnet has none of these pools. The
mainnet-only questions above need one small, owner-approved mainnet swap, or a read of the Ref,
DCL and NEARLY token source. Until then, mainnet values stay the owner's call (K2).

## The account and the key

**How it differs from `ops/keeper`:**

| | `ops/keeper` | `ops/buyback` |
|---|---|---|
| key | **function-call** key: two methods on the board, no deposit, small allowance | **full-access** key of a dedicated account |
| why | `distribute_*` take no deposit | wrapping attaches the chunk as a deposit, and every `ft_transfer_call` attaches 1 yocto. A function-call key can attach neither |
| if it leaks | the attacker can trigger distributions anyone can trigger | the attacker can take the NEAR and mPOO on the buyback account, and add or remove its keys |
| holds | gas money | NEAR waiting to be swapped, mPOO waiting to go back, nothing else |

So the account must be **dedicated**: no other funds, no other role, and not the keeper's account.
Its exposure is whatever revenue arrived since the last successful run.

Setup (testnet first; verify the near-cli-rs syntax with `--help`, as in `ops/keeper`):

1. Create the account, with its key generated locally and the private half piped straight into
   the secret store (the same pattern as `ops/keeper` step 2). It is a full-access key, so never
   put it in a file in this repo.
2. Register storage on every token that lands on the account: the wrap token, each step's input
   token and mPOO (`storage_deposit` with `registration_only: true`). On mainnet that's
   `wrap.near`, `token.rhealab.near`, `mpoo.nearlytrade.near`. `preflight` refuses to run without
   it and names the missing tokens.
3. Have the owner point the board at it: `set_buyback_account` (once per 7 days).
4. Run once by hand and read the lines.

**Rotating:** add a new full-access key, update the secret, delete the old key. **If it leaks:**
repoint `buyback_account` to a fresh account straight away. The 7-day limit applies, so do it before
the next `distribute_near` if you can. Then move what's left.

## Toward the buyback contract (K5)

The keeper's limits become the contract's rules. A contract with no owner (as T9) set as
`buyback_account` exposes a permissionless `buy()` that:

- swaps at most one chunk per interval, sized like `sizing.js`: `min(balance - reserve, max chunk,
  impact cap)`;
- sets each step's minimum from its own on-chain view of the pools (or a TWAP), not a caller's
  quote;
- sends the mPOO to the board with `{"revenue":{}}` in the same flow, so no key ever holds the NEAR
  or the mPOO.

Moving there needs no board change: `set_buyback_account` points at the contract. The numbers that
set its caps come from this keeper's logs on testnet and mainnet: `chunk`, `binding`, `impactBps`,
`differenceBps` (tax observed) and slippage refunds. Spec K5 says to specify the contract once the
keeper has run long enough to show them.

## Running it locally

```sh
cd ops/buyback
npm ci
npm test                     # unit tests, no network

export BUYBACK_NETWORK=testnet
export BUYBACK_RPC_URL=https://…                     # a working RPC
export BUYBACK_BOARD_CONTRACT_ID=board3.OWNER.testnet
export BUYBACK_ACCOUNT_ID=buyback.OWNER.testnet
export BUYBACK_MAX_CHUNK_NEAR=2 BUYBACK_MIN_CHUNK_NEAR=0.5
export BUYBACK_ROUTE="$(cat ~/.config/metapoo/buyback-route.json)"
export BUYBACK_PRIVATE_KEY="$(cat ~/.config/metapoo/buyback.key)"   # outside the repo
npm start; echo "exit=$?"
```

Requires Node 22. `near-api-js` is pinned to the same exact version as `ops/keeper`, with a lockfile.

**Scheduling is not wired.** The spec runs it hourly, after the distribution keeper (for example at
minute 37, with the keeper at 17). Whether a full-access key lives in a GitHub Actions secret or
on Hermes's server is the owner's call, so there's no workflow yet. The `ops/keeper` README covers
both options. For this key, the server avoids putting a key that can move funds into the
repository's secret store.

## Tests

```sh
cd ops/buyback && npm test
```

`node:test`, no network. A fake chain (`test/fake-chain.js`) has constant-product pools, an
optional post-min-out token tax, price drift, and a board that refunds a sender other than its
`buyback_account`. Covered:

- **chunk sizing:** balance, max chunk and price impact each binding in turn; skip below the
  minimum, at the minimum when impact is too high, and with no liquidity;
- **return first:** leftover mPOO goes to the board before any swap;
- **failures:** a swap that never lands leaves NEAR. A refunded swap leaves wNEAR, which the next
  run unwraps and swaps. A failed later step leaves the intermediate token, which the next run
  finishes first. A failed or refunded return leaves mPOO, which the next run returns first;
- **received versus quote:** a 2% tax logs `received_below_quote`, `differenceBps: 200` and
  `belowMinimum`;
- **preflight:** wrong `buyback_account`, wrong mPOO token, or a missing storage registration
  means nothing is signed;
- **configuration:** every required variable named at once; bad values in every variable named
  without echoing the value; route errors by step and field; network suffixes; the mainnet
  exchange allowlist; the key never inspected or logged;
- **messages:** Ref classic and DCL swap messages, wrap + swap in one transaction, the exact
  `{"revenue":{}}` return, and real `near-api-js` actions (deposit, gas, `FINAL`).

## Must be verified on testnet (Hermes)

- A testnet route (Ref testnet pools from wNEAR to a test mPOO token) set as `BUYBACK_ROUTE`, and a
  testnet board whose `buyback_account` is the keeper's account.
- One full run: `size`, both `swap` lines and `return` with hashes. The board's
  `mpoo_revenue_received` event for the same amount. `get_revenue_state.mpoo_undistributed` going
  up by it.
- Each failure path once: kill the RPC mid-run, set slippage to 1 bps to force a refund (wNEAR
  left, then unwrapped next run), set the board's `buyback_account` elsewhere (preflight stops).
- Gas actually used per step, to re-size `BUYBACK_GAS_SWAP_TGAS` and `BUYBACK_GAS_RETURN_TGAS`.
