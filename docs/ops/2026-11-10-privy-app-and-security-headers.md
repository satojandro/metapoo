# Privy app credentials and security headers — 2026-11-10

Status: **repo wiring done and verified; four dashboard settings remain (listed at the end).**
Production is unaffected: the live page still ships `VITE_PRIVY_ENABLED=false`, and the
security headers are in Report-Only mode.

## 1. There are two Privy apps, and the app secret is not used by this build

| Product | App ID (public) | Secret | Used by |
| --- | --- | --- | --- |
| VenekoVox / ETHGlobal Online '26 | `cmtq…ef375` | `PRIVY_APP_SECRET_VENEKOVOX` | the VenekoVox repo |
| **Meta Poo** (created 2026-11-10) | `cmw9wgh0f00500gkxkxsjy2hg` | `PRIVY_APP_SECRET_METAPOO` | `web/` |

They are **different applications**. An app ID from one cannot authenticate the other, and a
secret only works with its own app ID.

Meta Poo's web client is a static Vite bundle: it uses the **app ID only**. The app secret
exists for the day a server-side flow (server-controlled wallets, policy management, admin
reads) needs `https://api.privy.io`, and it stays in Bitwarden until then. Because Vite inlines
every `VITE_*` value into the shipped bundle, an app secret must never carry that prefix.

Bitwarden still holds two secrets under the identical key `PRIVY_APP_SECRET`. `bws 2.0.0`
rejects `secret edit` with 404, so this could not be fixed from the CLI — rename them in the
Bitwarden UI to `PRIVY_APP_SECRET_VENEKOVOX` / `PRIVY_APP_SECRET_METAPOO`.

### App ID vs app client ID

`VITE_PRIVY_APP_CLIENT_ID` is **not** the app ID. It names an *app client*: a per-platform
settings profile (session duration, allowed origins, cookie enablement) that overrides the
app's defaults. `@peerfolio/privy-near-connect`'s README tells you to create one
(Dashboard → Configuration → App settings → **Clients** → “Create Client”).

**It is not required.** `js-sdk-core@0.72.0` destructures `clientId` into an internal
`appClientId` that is read only behind truthiness guards — a `privy-client-id` request header
and a `client_id` query param on the embedded-wallet iframe. With no client ID the SDK falls
back to the app's default settings; login and NEAR wallet provisioning are unaffected. Only
per-environment session duration and per-client origins are lost.

`config.ts` used to treat an empty client ID as fatal, which took the whole connector down for
a value that is optional by contract. That check is gone (see the comment above
`readPrivyConfig`), with a test pinning the behaviour, so a real app client can be added later
without blocking the integration. Verified live: with only the app ID set, "Google or email"
appears in the wallet picker at `localhost:5173`.


## 2. What changed in the repo

- `web/.env.development` — committed dev defaults: `VITE_PRIVY_ENABLED=true`, the Meta Poo app
  ID, and `/privy-sign.html`. `web/.env` is gitignored, so social login used to depend on who had
  hand-edited their machine; on a fresh checkout "Google or email" simply was not in the wallet
  picker. `.env` (and `.env.local`) still win per machine.
- `readPrivyConfig` now mirrors `src/config.ts` and treats an unset `VITE_NEAR_NETWORK` as
  `testnet` instead of failing. Requiring that variable made the whole connector disappear
  whenever it was not in the loaded env files — indistinguishable from "Privy is broken". An
  explicit `mock`/`localnet` is still refused. Verified: with only `.env.development` present
  (no `.env` at all) the wallet picker lists Google or email.

- `web/vercel.json` — added, on every route: `Content-Security-Policy-Report-Only`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (camera/microphone/geolocation off). The existing asset-cache and
  `nosniff` rules are unchanged.
- `web/.env.production` and `web/.env` — `VITE_PRIVY_ENABLED=false`, the Meta Poo app ID,
  `VITE_PRIVY_SIGN_PAGE_URL=/privy-sign.html`, and an empty client ID.
- `web/.env.example` — documents that the client ID is a separate value and that this app ID
  is not the VenekoVox one.
- `web/.gitignore` — `.env*` now carries the `!.env.example` / `!.env.production` exceptions
  the repo root already had, so the two committed config files stay committed.

### The policy

`connect-src` carries Privy (`auth.privy.io`, `*.rpc.privy.systems`), WalletConnect,
Coinbase Wallet, and this app's actual chain endpoints: FastNEAR, dRPC, both NEAR public
RPCs, both nearblocks APIs, and 1Click. `frame-src`/`child-src` carry the Privy iframe,
WalletConnect verify, and Cloudflare Turnstile. `frame-ancestors 'none'` is the CSP half of
`X-Frame-Options: DENY` and does not conflict with Privy: what *we* embed is governed by
`frame-src`, what may embed *us* is governed by `frame-ancestors`.

## 3. Evidence

- `npm run build` — passes.
- `npm test` — 948 passed, 16 failed. All 16 failures are pre-existing on `feat/agents-page`
  (`src/integrations/privy/sign-page.test.ts`, `src/wallet-restore.test.ts`); they reproduce
  identically with these changes stashed.
- Preview `metapoo-testnet-qevuq673z-…` serves the Report-Only header plus `X-Frame-Options:
  DENY`, and still serves hashed assets with `immutable` caching.
- **Enforcement tested before recommending it.** A throwaway preview with the header renamed
  to `Content-Security-Policy` verified, from inside the page:
  POST `rpc.mainnet.fastnear.com` → `200 chain=mainnet` (allowed), `fetch('https://auth.privy.io/')`
  → not blocked, `fetch('https://api.github.com/')` → blocked. The wall still rendered with
  one canvas. The committed file was then reverted to Report-Only.
- Building for Vercel requires `vercel build --yes --environment preview` followed by
  `vercel deploy --prebuilt`; a plain `vercel deploy` fails remotely because it uploads
  `web/` alone and the `@shared/*` alias resolves outside that directory.

## 4. Remaining dashboard settings (all require the Privy dashboard)

1. **Allowed origins** — `https://metapoo-testnet.vercel.app`, `http://localhost:5173` and
   `https://metapoo.xyz` (added 2026-11-10, read back from `GET /v1/apps/{app_id}`).
   `metapoo.xyz` is allowlisted but **not live**: it resolves to a parking IP
   (`162.255.119.147`) and `https` times out, so it needs DNS pointed at Vercel before it
   appears in copy or invites.
2. **Google OAuth — done 2026-11-10** via Privy's default credentials (Login methods →
   Socials → Google). `google_oauth` now reads `true`; no Google Cloud project was needed.
   Own credentials remain optional, for consent-screen branding only, and require
   `https://auth.privy.io/api/v1/oauth/callback` as the redirect URI.

3. **App client — optional, not a blocker.** Create one from Configuration → App settings →
   **Clients** if you want per-environment session duration or per-client origins, and put its
   value in `VITE_PRIVY_APP_CLIENT_ID`. Everything works without it; `VITE_PRIVY_ENABLED` can be
   flipped today.

4. **NEAR embedded wallets are unproven.** `embedded_wallet_config.mode` is
   `user-controlled-server-wallets-only` with `ethereum`/`solana` entries and no NEAR
   section; whether `create({chain_type: "near"})` is accepted for this app is exactly the
   checkpoint `docs/research/2026-11-03-privy-compatibility.md` already flags. Test on
   testnet before promising Google login to real users. `captcha_enabled` and `mfa_methods`
   are both empty today.

## 5. Promotion

Report-Only → enforced is one string: rename
`Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `web/vercel.json`.
Do it after Privy login has actually run in a preview (its iframe and any wallet SDK workers
are the parts the policy has not exercised yet), then re-test on every Privy SDK bump.
