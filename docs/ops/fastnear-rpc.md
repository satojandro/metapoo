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

The trap this replaces: `quoteRepaint` once issued ≈129 RPCs for a single 64-cell stroke
(`docs/learning/traps.md`). At that shape, 500k credits is a few thousand strokes.

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
