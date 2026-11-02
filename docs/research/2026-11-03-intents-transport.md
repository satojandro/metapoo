# Intents transport and native delivery evidence

Checked: 3 November 2026. Implementation baseline: `57ca197`; source lives under
`web/src/integrations/intents/`. This record is not live funding proof.

## Current provider contract

- Official TypeScript package installed by the integration owner: exact
  `@defuse-protocol/one-click-sdk-typescript@0.1.26`. The client calls its real
  `verifyQuoteSignature()`; a fixture test verifies that fabricated signatures fail.
- The runtime uses validated REST calls for `GET /v0/tokens`, `POST /v0/quote`, and
  `GET /v0/status?depositAddress=...&depositMemo=...`. Memo is retained when present.
- Public direct transport carries no partner credential. Current authentication documentation
  accepts `X-API-Key` for the partner JWT and also accepts `Authorization: Bearer`. A future
  keyed mode needs an independently configured same-origin server proxy; no secret belongs in Vite.
- Quote mode is exact input with source-chain deposit and refund addresses and an external NEAR
  recipient. No confidential ledger, programmable withdrawal message, fee recipient, or mPOO
  Intents destination is accepted.

Sources read: [quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote),
[status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status),
[authentication](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication),
[quote signature verification](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature),
[official SDK](https://github.com/defuse-protocol/one-click-sdk-typescript).

## Gates still open

1. **Browser transport:** the integration owner subsequently captured actual browser requests from
   localhost: tokens returned 200, a dry quote returned 201, and a fixture-address status lookup
   returned a readable 404. The unchanged public dry quote is preserved at
   `web/src/integrations/intents/fixtures/live-dryquote-2026-11-03.json`; its real vendor signature
   passes the installed SDK verifier. It contains no payable deposit address. The deployed Meta Poo
   origin is still unverified, so the production `transportVerified` flag remains false. A shell
   HTTP request or a fake fixture is not CORS evidence. Do not use `mode:no-cors`, which produces
   an unreadable response and cannot establish an authenticated payable address.
2. **Native delivery:** no live transaction proves 1Click sends native NEAR rather than wNEAR for
   the configured route. Preserve the three separate proof flags: initialized named, initialized
   implicit, and fresh implicit matching the connected expected Ed25519 public key. Every flag
   defaults false and needs a durable evidence reference. A nonexistent named account always
   blocks. `nep141:wrap.near` alone does not prove any of those cases.
3. **Receipt trace availability:** native attribution needs executed receipt bodies and their
   successful outcomes. If the configured RPC/indexer cannot return the relevant receipt actions,
   status remains `settled_verifying`; neither provider SUCCESS nor a balance increase substitutes
   for attributable delivery. Do not synthesize a Transfer receipt from an observed balance delta.
4. **Wrapped delivery:** this implementation intentionally refuses new payable wNEAR-only funding
   routes. It can represent already recovered wrapped delivery, but does not introduce an unwrap
   signing path without separate reviewed native-gas/storage prerequisites. No sponsorship exists.

The user-facing fallback is direct native NEAR receive instructions. Historical operation tracking
stays available even when new funding is disabled or the user disconnects.

## Verification performed

Focused command (from `web/`):

`NODE_OPTIONS=--no-experimental-webstorage npm test -- src/integrations/intents`

Result: 33 tests passed across amount parsing, provider boundaries, signature rejection,
authority/persistence/recovery, native receipt attribution and inline panel expiry/accessibility
behaviour. `npx tsc --noEmit` also passed after all parallel feature drafts were present. Full-suite,
production build and browser evidence are recorded by the integration owner. No real quote was
funded, no wallet signed, and no deployment occurred in this work.

## Live dry-quote schema correction

The browser response echoed additional defaults: `confidentiality=public`, `quoteWaitingTimeMs=0`,
`insured=false`, and one 20-bps platform fee for recipient
`5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd`.
The adapter permits only those exact nonprogrammable defaults and that reviewed fee recipient,
with a total cap of 25 bps. Unknown fields, alternative recipients, extra fee rows, larger fees,
and programmable withdrawal messages remain rejected. The UI displays the provider-reported fee;
an absent fee field is described as unitemized, never assumed free.

Most importantly, committing a quote copies only the application's original request fields.
It never sends the server-added fee/default fields back as user `appFees`, which could otherwise
change the fee schedule or add fees twice. Tests cover this second POST body as well as value-based
comparison of normalized fee arrays during status recovery. The live dry quote establishes schema
and signature compatibility, not native delivery, tax behaviour, payable commit, or settlement.
