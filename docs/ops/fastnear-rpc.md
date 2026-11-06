# RPC: endpoint, credential, and what it costs

**Authoritative for:** which JSON-RPC host each part of the project talks to, how the
FastNEAR key is supplied, and where request consumption is actually visible.

## Hosts

| purpose | endpoint |
|---|---|
| testnet reads | `https://rpc.testnet.fastnear.com` |
| mainnet reads | `https://rpc.mainnet.fastnear.com` |
| historical state / transaction logs | `https://archival-rpc.{testnet,mainnet}.fastnear.com` |
| no-credential default (fallback) | `https://rpc.{testnet,mainnet}.near.org` |

`read-rpc.ts` (web) and `ops/keeper/src/config.js` ship the NEAR Foundation endpoints as
defaults. `VITE_NEAR_RPC_URL` / `KEEPER_RPC_URL` move a deployment onto FastNEAR.

## Credential

One FastNEAR key works across their regular RPC, archival RPC and indexed APIs. Two
transport forms work; **the header is the default here** because it keeps the key out of
URLs and request logs:

```
Authorization: Bearer $FASTNEAR_API_KEY
?apiKey=$FASTNEAR_API_KEY        # documented alternative, leaks into logs
```

The key lives in Bitwarden Secrets Manager as `FASTNEAR_API_KEY`. Never put it in a
committed file:

```bash
export FASTNEAR_API_KEY="$(bws secret get 44086ddf-7754-429e-ba85-b4f9005130ac \
  --output json | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])')"
```

Where each surface picks it up:

| surface | variable | notes |
|---|---|---|
| web (browser) | `VITE_NEAR_RPC_API_KEY` | **published in the bundle** — see the caveat below |
| keeper | `KEEPER_RPC_API_KEY` | sent as a header; non-enumerable on the config object so it cannot reach a log |
| buyback | `BUYBACK_RPC_API_KEY` | same rule as the keeper |
| one-off scripts / harness | `FASTNEAR_API_KEY` | header added next to `Content-Type` |

The key is only attached to hosts it was issued for: the configured endpoint, plus other
FastNEAR hosts when the configured endpoint is FastNEAR's. A read that falls back to
`rpc.near.org` never carries it (`web/src/rpc-auth.ts`).

## What a request costs

FastNEAR's paid plans are sold as **requests per month** (Dev ≈ 10M, Pro ≈ 36M, Business ≈
100M), and the signup trial is **500,000 credits**. Treat one JSON-RPC request as one
credit's worth of consumption until the dashboard says otherwise — it is an estimate, not
a published price list.

Two consequences that shaped the code:

1. **Anonymous traffic is not billed to us.** A request without a key is answered from the
   shared public pool (no `x-rate-limit-score` header) — lower, unpublished limits, no
   credit spend. Keyed traffic gets the headroom *and* the bill.
2. **`x-rate-limit-score` is not a budget.** It reads `1000000` on every keyed response,
   before and after traffic. It is a plan score, not remaining credits. Do not build a
   meter on it.

What one page view costs, measured on 2026-11-05 against `board3.metapoo-player1.testnet`
(128×128, 8 painted cells): **2 requests** — one `get_board` plus one `get_pixels` page, because
`get_pixels` walks painted cells only, not the whole grid. Cost grows with content:
`1 + ceil(painted / 256)` page requests, plus one block read when the load pins a block. A fully
painted 128×128 board is therefore 66 requests. At 500k credits that is roughly 7.5k cold loads of
a *full* board, or ~166k loads of a fresh one — unbilled today, because the deployed page uses the
anonymous endpoint.

The trap this replaces: `quoteRepaint` once issued ≈129 RPCs for a single 64-cell stroke
(`docs/learning/traps.md`). That shape, not the board load, is what would eat the trial.

## Indexed APIs we use, and what they change

One key covers the indexed surfaces too, but they **answer without a key** (verified 2026-11-05):
`POST https://tx.test.fastnear.com/v0/account` returned `200` to an unauthenticated request, and the
host answers the browser CORS preflight with `access-control-allow-headers: content-type, accept,
authorization`. That is why `/money` can use them from the browser without shipping a credential.

| use | call | why |
|---|---|---|
| buyback ledger (`web/src/app/buyback-ledger.ts`) | `POST /v0/account` for the **buyback account's** history `{account_id, desc:true, limit, resume_token}`, then `POST /v0/transactions` `{tx_hashes: ≤20}` | one listing page plus one request per 20 transactions, instead of one archival RPC request per transaction |
| index freshness | `GET /status` → `latest_block_timestamp` | the scan refuses to report from a stopped index |
| account panels | `GET https://api.fastnear.com/v1/account/{id}/full` | balances, FTs, NFTs and staking in one call |

**Trap: `is_event_log` does not mean "emitted an event".** It means *this account is named in*
an event's data. Measured on 2026-11-05: board3 emitted 17 `EVENT_JSON` logs across 38
transactions and 3 rows were flagged; board5 emitted 23 and **none** were flagged. The 3 flagged
board3 rows were MPOO purchases, flagged because the token's `ft_transfer` names the board as
`new_owner_id`. A split's data holds `team_account` and `buyback_account` but never the board, so
filtering the board by that flag drops **every** `near_distributed` and the ledger reports
`0 NEAR, complete: true`. Ask the index about the account the money moved to (the buyback), not
the account that emitted the log.

`/v0/account` filters that matter: `is_event_log`, `is_function_call`, `is_success`, `desc`,
`from_tx_block_height` / `to_tx_block_height`, `limit` ≤ 200. Pagination is an opaque
`resume_token`; reuse it exactly as returned.

**These are indexes, not the chain.** `/status` reported 2.4–3.4 s of sync lag on both networks.
Use them for history and balances; never for post-transaction confirmation, nonces or access-key
checks — those stay on RPC.

## Where consumption is actually visible

`https://dashboard.fastnear.com` → project → usage. The number behind that page is
`GET /api/usage`, which answers `401 Unauthorized` to the API key, to `x-api-key`, to
`?apiKey=` and to a forged cookie: it wants a **human NextAuth session**, not a key. There
is no documented usage API.

So the only honest ways to see consumption are:

- read the dashboard (authoritative, manual), and
- keep our own request counts for the paths we control (keeper, scripts, harness).

Do not claim a credit figure from anything but the dashboard.

## Browser keys: the caveat

Vite inlines every `VITE_*` value into the shipped JavaScript. A key set through
`VITE_NEAR_RPC_API_KEY` is therefore readable by any visitor and can be spent against the
quota. FastNEAR's mitigation is a **browser key** — a key restricted to your site's
`Origin`/`Referer` with a per-key rate cap — and that restriction is a **paid-plan
feature**; it is disabled on the free trial.

Until the project is on a paid plan:

- keep `VITE_NEAR_RPC_API_KEY` empty for the deployed page, or
- put a server-side proxy in front of FastNEAR (Vercel function) that injects the header,
  and point `VITE_NEAR_RPC_URL` at the proxy.

FastNEAR keys are rate-limit credentials, not NEAR account keys: a leaked one cannot move
funds. The exposure is quota, bounded by a per-key rate cap and ended by rotation.

## The deployed page needs the key at build time

The anonymous path is not merely slower, it fails outright under load: a tester's paint died on
`-429 Rate limits exceeded ... get a subscription at https://faslnear.com/` because the shared
public pool is per client and a visible tab's polling spends it. Meanwhile reads without a key
report no `x-rate-limit-score` header at all, and the same read with our key reports one — that
header is the cheapest way to check whether a build carries the credential.

So the hosted build is made with the key in the environment, never in a committed file:

```bash
export VITE_NEAR_RPC_API_KEY="$(bws secret get 44086ddf-… --output json \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])')"
vercel build --prod && vercel deploy --prebuilt --prod
```

**A rebuild without that export silently produces a page on the anonymous pool.** Nothing in the
build fails; the first symptom is a 429 on someone else's paint. If you deploy, check the header
before you call it done.

The key is readable in the bundle, by design, for the testing round. Before real users: the
Vercel-function proxy above, so the key stays server-side and per-IP limits come back.
