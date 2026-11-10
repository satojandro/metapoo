# Intents (1Click) browser transport check — 2026-11-10

ACQ-4, Intents step 1. No funds moved (dry quotes only).

Run first from a cloud session, then **re-run independently from a Chromium tab on
`https://metapoo-testnet.vercel.app`** (crypto-builder, 2026-11-10). Every row below reproduced:
216 tokens, the preflight, the same dry quote (`amountOut` `1384658638547314202334630`, 1.3846 NEAR),
one `appFees` entry at 20 bps to `5880ad2b…47dd`, and the three server-added defaults verbatim. The
live response was also run through this repo's own `parseQuote` / `assertQuoteMatches` /
`providerFeeBps` in a throwaway test (pass), so "our parser accepts it" is checked, not inferred.

**Origin:** `https://metapoo-testnet.vercel.app` (the mainnet page).
**API:** `https://1click.chaindefuser.com` (`VITE_INTENTS_TRANSPORT=direct`).

| Check | Result |
| --- | --- |
| `GET /v0/tokens` with `Origin` | 200, `access-control-allow-origin: *`, 216 tokens |
| Preflight `OPTIONS /v0/quote` (POST, `accept,content-type`) | 204, allows POST and both headers |
| Preflight `OPTIONS /v0/status` (GET, `accept`) | 204 |
| Same three calls from a Chromium tab on the deployed page (`credentials: "omit"`, `redirect: "error"`, as `client.ts` sends them) | tokens 200, quote 201, status 404 with readable body: no CORS or CSP block |
| Site CSP `connect-src` | lists `https://1click.chaindefuser.com` |
| Dry quote, 5 USDC on Base → `nep141:wrap.near`, recipient a never-used 64-hex implicit id | 201, ≈1.38 NEAR out, 37 s estimate, refund fee 2400 (0.0024 USDC) |
| Our parser + `assertQuoteMatches` on that live response | pass |
| Deadline with milliseconds | echoed unchanged (strict match is safe) |
| Provider fee | `appFees` = one entry, recipient `5880ad2b…47dd` (= `REVIEWED_PLATFORM_FEE_RECIPIENT`), **20 bps** (cap in code: 25) |

Server-added `quoteRequest` defaults seen: `confidentiality: "public"`, `quoteWaitingTimeMs: 0`, `insured: false` — all three already accepted by `assertQuoteMatches`.

Result: `INTENTS_BROWSER_TRANSPORT_VERIFIED = true` in `web/src/integrations/release-evidence.ts`. Proxy transport is not needed.

**Not covered here** (still open in ACQ-4): a real (non-dry) deposit proving *native* NEAR lands at a named, an initialized implicit and a **fresh** implicit account (`INTENTS_NATIVE_EVIDENCE`); the reviewed source list (`INTENTS_REVIEWED_SOURCES`); `VITE_ACQUISITION_PLAY_RESERVE_YOCTO`; turning on `VITE_INTENTS_FUNDING_ENABLED` in Vercel.
