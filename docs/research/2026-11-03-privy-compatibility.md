# Privy through NEAR Connect — compatibility checkpoint

Checked 3 November 2026 against implementation base `57ca197` (PR #54 specifications). This is source/package and fixture evidence. No Privy credentials were supplied, no player account was provisioned live, and no transaction was signed or sent.

## Exact runtime tuple

- `@hot-labs/near-connect` **0.11.4** (existing dependency; resolved package reviewed).
- `@peerfolio/privy-near-connect` **0.0.8**.
- Direct `@privy-io/js-sdk-core` **0.72.0**.
- The committed lockfile owns transitive versions/integrities. No `latest` runtime URLs.
- `web/src/integrations/privy/vendor-executor.js` is an exact unmodified copy of the installed adapter's `dist/executor.js`; SHA-256 **16b05e82289d0d56bcada4df387cb63e4ccbe1390907c3cf6fe9e94f7e31c132**. The adjacent `VENDOR-LICENSE.txt` preserves MIT attribution. A regression test compares the asset with the installed package and recorded hash. Vite's URL asset handling serves this script from the application deployment; no mutable remote executor is fetched.

## Confirmed APIs and differences from examples

1. Actual near-connect `WalletManifest.platform` is a string array (`['web']`), not the object used by upstream README examples. All `WalletFeatures` booleans are required; unsupported signing/delegate features are explicitly false. Actual `WalletPermissions` has no `isPrivyConnect` field. Application integration uses `registerWallet` after `whenManifestLoaded`, retaining the default wallet list.
2. `initSigningPage` is a real framework-independent export. It takes exact `allowedOrigins`, `debug: false`, optional explicit linked `wallet`, `rpcOptions` and AbortSignal. The real complete linked-account record is validated before passing it; metadata is never fabricated or blanket-cast.
3. The actual core SDK OAuth `generateURL` result is **`{url: string}`**. A generic documentation snippet treats it as a URL string; the implementation reads `.url` and the compatibility test fixes that boundary.
4. The core SDK exports `create` for wallet provisioning. The reviewed upstream NEAR example invokes it with `{fetchPrivyRoute, getCompiledPath, app:{appId}}` and `{request:{chain_type:'near'}}`. The installed declarations support this exact call. Existing linked NEAR wallet metadata is reused; auth user IDs and EVM/Solana wallet addresses never become board identities.
5. The installed sign-page runtime's `ncSignIn` calls `addFunctionCallAccessKey` when `addFunctionCallKey` is supplied. It forwards receiver, explicit method list, and limited gas allowance and awaits completion. This is source evidence beyond a manifest capability claim.
6. A no-key sign-in returns implicit account metadata without an account RPC lookup. It does not create/fund an on-chain NEAR account. AddKey and capital approvals require shared readiness to verify account existence, expected implicit key/full-access provider key, and positive storage-aware native NEAR. Actual transaction budgeting is still the host gateway's responsibility.
7. Upstream `getAccounts` returns a cached account ID and `signOut` only removes it. Application code must invalidate its host identity immediately and separately call Privy logout. Drawing-key storage/authority remains unchanged.
8. The runtime defaults to mainnet if its incoming payload omits `network`. The new signing page rejects missing/mismatching networks before provisioning/auth controls, supplies the configured RPC, and validates again before approval. `signDelegateActions` is rejected.
9. Upstream's default signing callback picks the first linked NEAR wallet. To preserve explicit wallet selection the page first receives a request to clear the executor's READY timeout, then authenticates/selects the wallet and performs a second same-payload handshake bound to that exact validated wallet. OAuth callback reloads repeat the handshake with the still-pending opener. This is fixture-tested; real OAuth popup/COOP behaviour remains a browser acceptance gate.
10. AddKey reuses the existing `connectWallet({authorizeDrawingSession:true})` re-sign-in path. The host additionally publishes a public pending record matching account/network/epoch, exact generated public key, board, methods and allowance. The popup requires a fresh matching record. No second AddKey transaction builder or drawing secret transfer is introduced.

## Testnet support: bounded finding

The installed connector advertises testnet and its actual provider code recognizes `testnet`; the NEAR raw-signing primitive signs the supplied transaction bytes, and the application explicitly selects the testnet RPC/network. Provisioning a Privy `near` wallet creates a network-neutral key/address identity; account initialization still occurs separately on the chosen NEAR network. Tests verify explicit network/RPC selection, no mainnet default, exact SDK API compatibility, and rejection of absent/unfunded account readiness.

**Not verified:** whether the configured Privy application permits NEAR wallet provisioning/raw signing for the real intended users and testnet browser flow. No claim of provider-side live compatibility follows from types/source. This remains a specific credential-backed checkpoint: create the app/client, enable Google and email/NEAR extended-chain wallets as required, allow exact app/callback origins, run Google/email login on the actual hosting headers, receive testnet NEAR, verify implicit access key, approve existing AddKey, and prove popup-free drawing via nonce/allowance and pixel read-back. Do not substitute a mainnet transaction if testnet provisioning/signing fails.

## Integration and operational boundaries

The real standalone entry is `web/privy-sign.html` → `integrations/privy/entry.ts`. Disabled/incomplete configuration and a direct visit without an opener do not initialize signing. All user-visible approvals require a button click. OAuth codes/state are removed from the callback URL after processing, including failure. The page stores no provider credentials in the acquisition operation ledger.

The host must publish `setPrivyHostIdentity` on identity/epoch changes. Capital/AddKey approvals re-check it around provider/readiness awaits. The identity record contains only public address, network and numeric epoch. Valid local drawing continues independently of Privy token freshness; no provider login is requested per paint. Pending provider failures cannot automatically resend a transaction.

Initial public config is `VITE_PRIVY_ENABLED=false`; `VITE_PRIVY_APP_ID`, `VITE_PRIVY_APP_CLIENT_ID`, exact same-origin `VITE_PRIVY_SIGN_PAGE_URL`, existing `VITE_NEAR_NETWORK`, `VITE_NEAR_RPC_URL`, and `VITE_CONTRACT_ID`. None is a server secret. Provider auth tokens stay in the provider's SDK storage. No relayer, sponsorship, funding treasury or full-access browser key is introduced.

## Sources and reproducible checks

- [NEAR Privy tutorial](https://docs.near.org/web3-apps/tutorials/privy).
- [Inspected adapter source](https://github.com/beneviolabs/privy-near-connect/tree/bef71302bdcb3ea952435a12cdbec920fe68d4b9); exact published runtime bytes are checked locally rather than assuming a source/tag relationship.
- [Core browser SDK documentation](https://docs.privy.io/recipes/core-js), whose low-level integration guidance recommends discussing the integration with Privy. Provider support status remains open; this is not a request to stop fixture implementation.
- `NODE_OPTIONS=--no-experimental-webstorage npm test -- src/integrations/privy` from `web/`; tests cover exact executor pin, published APIs, metadata/identity selection, host epoch races, absent-account rejection, no auto-sign, missing-network rejection, expired auth, callback cleanup and no retry after unknown signing outcome.
- Full test/build/CI and credential-backed browser/chain evidence are reported by the integrator separately. Fixture tests are not live proof.
