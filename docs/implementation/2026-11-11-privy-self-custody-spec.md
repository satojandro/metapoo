# PRIVY-CUSTODY — Self-custody panel for Privy accounts

Date: 11 November 2026. Status: implementation specification; no app code changed, no key added or exported by this document. Mockups: [`mockups/2026-11-11-privy-self-custody.html`](mockups/2026-11-11-privy-self-custody.html).

Read [the Privy NEAR Connect spec](2026-11-03-privy-near-connect-spec.md) and [the Send spec](2026-11-11-privy-send-spec.md) first. Send moves value. This document gives a player control of the account itself, so leaving Meta Poo or losing Privy access never strands their funds. Task list: [`privy-withdrawal.tasks.json`](privy-withdrawal.tasks.json).

## 1. Result and scope

A connected Privy player opens **Self-custody** in the wallet panel. It shows the keys on their account in plain language and offers two ways to hold the account themselves:

- **Path A: add your own key.** The player creates a key in a wallet they control, pastes its public key, and approves `AddKey(FullAccess)` after a strong confirmation in the Privy window. Optionally, later, they **graduate**: they remove Privy's key with `DeleteKey`, signed from their own wallet.
- **Path B: export the Privy key.** This is conditional on a live test (§6) and is not promised. If it ships, it is an isolated page and never part of the main app bundle.

Background: the Privy embedded wallet is a plain NEAR implicit account. The address is the hex of an Ed25519 public key, and that key is a FullAccess key held by Privy. NEAR accounts can hold several FullAccess keys, and each one alone can move all funds, add keys or delete keys. Self-custody is therefore a key-management feature, not a transfer.

Out of scope: seed-phrase generation inside Meta Poo, social recovery, multisig, key rotation for non-Privy wallets, `DeleteAccount`, and anything that loosens the drawing-key branches.

## 2. Evidence baseline

Baseline `main` at `f252aee6a496159f9c5ab0ac4e2c78833870407a`.

1. `approval.ts` has two `AddKey` surfaces. The first is `signIn.addFunctionCallKey`, checked against `PendingDrawingAuthorization`. The second is a transaction `AddKey` (lines 223–280), which throws "Only a limited drawing key can be added here." for `FullAccess` and pins receiver, methods, allowance, public key and session to the pending drawing record. **Neither branch changes.**
2. The `DeleteKey` branch accepts only `params.publicKey === drawingPublicKey` on the signer's own account. **Unchanged.**
3. The pinned connector (`@peerfolio/privy-near-connect` 0.0.8, `toNearAction`) maps `AddKey` with `permission === "FullAccess"` to `actions.addFullAccessKey(pk)`, and also maps `DeleteKey`. The capability exists below our gate.
4. Privy's own key for the account is `ed25519:` + base58 of the 32 bytes encoded in the hex address. `runtime.ts::assertReady` already derives it (`expectedKey`) and `resolveAccountReadiness` checks it is present.
5. Privy key export findings are in §6.1.

## 3. The panel (`web/src/app/self-custody-panel.ts`)

The panel lives in the wallet panel under "Your account" as a disclosure titled **"Self-custody"**. It is hidden unless the connected wallet is Privy (`manifest.id === PRIVY_WALLET_ID`) and `VITE_SELF_CUSTODY_ENABLED=true`. Content:

1. **Keys on this account.** Read with `view_access_key_list`, refreshed when the panel opens and after every approval. Each row has a plain label and the key, truncated as `ed25519:7xKp…Qm3d`, with copy:
   - "Privy (your sign-in)" if it equals the derived Privy key. Badge: Full access.
   - "This browser's drawing key" or "Drawing key (another browser)" for FunctionCall keys on `CONTRACT_ID` with the draw methods. Badge: Paint only.
   - "Your key" for any other FullAccess key. Badge: Full access.
   - "Other limited key" for any other FunctionCall key, showing its receiver.
   - An RPC failure shows "We couldn't load your keys. Retry." It never shows an empty list.
2. **Status line.** One of:
   - "Only Privy can sign for this account."
   - "You and Privy can both sign for this account."
   - "Only your own wallet can sign for this account. Privy sign-in can no longer approve anything." (graduated, §5)
3. **Actions.** "Add your own key" (Path A); "Remove Privy's key", shown only when a "Your key" row exists (§5); and "Export your Privy key", shown only when Path B is enabled (§6).
4. **Disclosure, always visible when more than one FullAccess key exists:** "**Both keys can move all your funds.** Anyone who gets either one can empty this account, and Meta Poo can't undo it. Keep your own key as safe as a bank password."

## 4. Path A: add your own key

### 4.1 Game-side steps

1. **Explain.** "Create a key in a wallet you control, such as a Ledger or a wallet app that can show you a public key. Paste the **public** key here. Never paste a private key or recovery phrase." See Q1 on naming wallets.
2. **Paste.** The input accepts `ed25519:<base58>`. Validate that it decodes to exactly 32 bytes. Reject the following:
   - `secp256k1:` keys (not supported in v1);
   - anything that looks like a private key: `ed25519:` with 64 decoded bytes, a 12 or 24-word phrase, or a 64 or 128-character hex string. Message: "That looks like a private key. Don't share it with anyone, including us. Paste the public key instead.";
   - the Privy key: "That's Privy's key, already on your account.";
   - any key already on the account: "That key is already on your account.";
   - a drawing key.
3. **Show it in chunks** of 4 characters with a "Does this match your wallet?" prompt. Then **Continue**.
4. **Record the intent.** Write `PendingSelfCustodyKey` to the same storage the sign page reads (alongside `PendingDrawingAuthorization` in `session.ts`, new key `metapoo:privy:pending-self-custody:v1`): `{accountId, networkId, sessionEpoch, publicKey, kind: "add-full-access", createdAtMs}`, with a 10-minute expiry. There is one pending record at a time, and Cancel clears it.
5. **Ask the wallet.** Send one transaction through a new `signAndSendSelfCustodyKey(context, publicKey)` in `wallet.ts`: receiver = the signer, actions = `[AddKey {publicKey, accessKey: {permission: "FullAccess"}}]`. This function only accepts Privy wallets, takes the capital lock and does not use the acquisition gateway. Its only job is this one action.
6. **Confirm on chain.** Success requires `view_access_key(accountId, publicKey)` to return `permission: "FullAccess"`. A returned hash alone is not success. Then clear the pending record, refresh the key list and show the "You and Privy can both sign" state with the two-key disclosure.

The confirmation in step 3 is a convenience. **The security boundary is the Privy window** (§4.2), because a compromised game page could skip any game-side screen.

### 4.2 New approval path in `approval.ts`

Add `reviewSelfCustodyAddKey(...)`. It is a **separate function, dispatched before the per-action loop**, and selected only when the batch is exactly one transaction with exactly one action: `AddKey` with `accessKey.permission === "FullAccess"`. Every other `FullAccess` occurrence still reaches the existing branch and throws as today. The existing drawing-key code is not edited.

It rejects unless all of the following hold:

- the common guards (§4.1 of the Send spec) pass, including host identity;
- `receiverId === wallet.address`;
- `params.publicKey` is a canonical `ed25519:` base58 32-byte key, is not the Privy key, is not the current drawing key, and is not already on the account (the sign page reads `view_access_key`; an RPC failure rejects);
- `getPrivyPendingSelfCustodyKey(storage)` matches `accountId`, `networkId`, `sessionEpoch`, `publicKey` and `kind`, and is unexpired;
- the batch has no other transaction and no other action.

It returns a `PrivyReview` with a new optional field:

```ts
confirm?: {
  /** Characters the player must type, compared case-sensitively. Never rendered. */
  suffix: string;            // last 8 base58 characters of the key
  acknowledgement: string;   // checkbox label
};
```

The sign page shows:

- eyebrow `Self-custody`, title `Add your own key`;
- lede: "This gives a key you control full access to your Meta Poo account. Privy keeps its key too, so both can sign.";
- rows: Adds "A full-access key" · Key `ed25519:7xKpR2…` followed by `••••••••` (first 6 visible, last 8 masked) · Account (mono);
- warning block (`--mp-bad` border): "**Both keys can move all your funds.** If this key isn't yours, or someone else can see it, they can empty this account. Meta Poo can't reverse it.";
- field: "Type the **last 8 characters** of the public key, exactly as your wallet shows them";
- checkbox: "I created this key myself and I'm the only one who has it";
- Approve label `Add my key`.

Approve stays disabled until the typed value equals `suffix` and the box is checked. Approve re-runs the review, including the pending-record match and the on-chain "not already present" read, before calling `sign()`.

Why mask the suffix and ask the player to type it from their own wallet, rather than retype what we show: if the game page or the clipboard swapped in an attacker's key, a player copying from our screen would confirm the attacker's key. Typing from their wallet compares against the source of truth. Eight base58 characters is about 47 bits. Grinding an Ed25519 key with a chosen 8-character suffix *and* a matching visible prefix is far beyond a real-time clipboard attack, while staying typeable on a phone. See Q2.

Requests that still reject:

- `FullAccess` in `signIn.addFunctionCallKey` (not a field it supports; existing branch);
- `FullAccess` in a batch with any other action or transaction;
- `FullAccess` for another account;
- `FullAccess` with no pending record, an expired one or a mismatched one;
- every existing drawing-key rejection.

### 4.3 Removing a key you added

The panel offers **Remove** on each "Your key" row, for mistakes and lost devices. This is a second new function, `reviewSelfCustodyRemoveKey`, dispatched the same way:

- one transaction, one `DeleteKey`, receiver = signer;
- `publicKey` equals an unexpired `PendingSelfCustodyKey{kind: "remove-own-key"}`;
- the key is on chain with `FullAccess`;
- the key is **not** the Privy key.

Copy: "Remove this key? After this, only Privy can sign for your account." No typed confirmation is required, because removing an extra key only narrows access. The existing drawing-key `DeleteKey` branch is untouched. Privy's own key can never be removed through the Privy window (§5).

## 5. Graduate: remove Privy's key

Graduating makes the player's own wallet the only way to control the account. It is optional, offered only after a "Your key" row has been on chain for at least 24 hours (Q3), and it is **irreversible from Meta Poo's side**.

**Rule: Privy's key is removed only by a transaction signed with the player's own key, never by the Privy window.** The Privy approval screen keeps rejecting `DeleteKey` of the Privy key, and no new branch accepts it. Why:

- If the player's added key is wrong, lost or not really theirs, a Privy-signed `DeleteKey` would lock them out forever, and funds would be stranded or stolen.
- Requiring a signature from the player's own wallet proves they control a FullAccess key on the account at the moment it matters. A `DeleteKey` signed by a key that isn't FullAccess fails on chain.

Flow:

1. The panel shows the **graduation warning** screen:
   - title: "Remove Privy's key?"
   - body: "After this, **Privy sign-in can't approve anything for this account**: no painting authorisation, no buying, no sending. Only your own wallet can. **If you lose your own key, nobody can recover this account, including Meta Poo and Privy.** This can't be undone."
   - a checklist of three boxes, all required: "I've signed in with my own wallet at least once"; "I've backed up my own key or recovery phrase"; "I understand this can't be undone".
   - a typed confirmation: the player types `REMOVE`.
2. **Connect the same account with the other wallet.** Prompt: "Disconnect Privy and connect this account with your own wallet." The game checks that `accountId` is unchanged and the wallet is not Privy. The game does not hold the private key at any point.
3. **Sign the removal.** Send one transaction from that wallet: `DeleteKey {publicKey: <derived Privy key>}` on the signer. The non-Privy wallet shows its own review. Our in-game warning (step 1) is shown immediately before the wallet opens.
4. **Confirm on chain.** `view_access_key` for the Privy key returns `UNKNOWN_ACCESS_KEY`. Then show the graduated state.
5. **Graduated state.** If the player later signs in with Privy, the game detects that the Privy key is absent and shows: "This account is now controlled by your own wallet. Connect with that wallet to continue." It disables every approval through Privy. The 11-03 readiness check already fails on `expectedKeyMatches === false`; map that to this copy instead of a generic error. Existing drawing keys keep working until revoked, because they are separate FunctionCall keys.

If no compatible wallet can connect this implicit account through NEAR Connect, graduation is not offered (Q1).

## 6. Path B: export the Privy key (conditional)

### 6.1 What Privy's docs say (read 10 Nov 2026)

Confirmed in Privy's documentation:

- NEAR is a **Tier 2** chain ("Privy decodes and signs transactions"). The chains page lists "Create and export wallets" for Tiers 1–3, and the export page says "Key export is available for all wallets on every supported tier."
- **Client-created wallets "can only be exported via the `exportWallet` method in the React SDK"**, which is `useExportWallet` from `@privy-io/react-auth`. It opens a Privy modal in which the key is assembled on a separate origin, so the app never sees it. It is "only available in web environments". Mobile apps use a hosted React page in a WebView.
- The exported NEAR key format is listed as "ed25519: prefixed". The byte length (32-byte seed or 64-byte expanded key) and the encoding after the prefix are **not stated**.
- `getWalletPrivateKey` (programmatic, HPKE-encrypted to an app key) requires Privy Support to enable it, is "only supported for TEE-based wallets", and lists only Ethereum and Solana formats. **Not usable for us.**
- REST `POST /v1/wallets/{wallet_id}/export` authenticates with the **app secret** (Basic auth) and is aimed at server-created wallets. Meta Poo has no backend holding a Privy app secret, and must never ship one in `VITE_*`. **Not usable.**
- "Wallet export is restricted to wallet owners and enabled by default, unless explicitly disabled by a DENY policy." The docs also note that users can export with their own access token even if the app never calls `exportWallet`.

Checked locally:

- `@privy-io/js-sdk-core` 0.72.0 (our pinned core SDK) contains no export method, no HPKE code and no `/export` route. Search the npm tarball's `dist/` for `export*Wallet`, `getWalletPrivateKey`, `hpke` and `wallets/*/export`.
- `@peerfolio/privy-near-connect` 0.0.8 signs through `embeddedWallet.signWithUserSigner` and has no export entry.

**Not confirmed.** The live test must settle all of these:

1. Whether `exportWallet` in `@privy-io/react-auth` accepts a NEAR wallet created through `js-sdk-core` `create({chain_type: "near"})`. Privy's React extended-chain export may require the wallet's address and chain type, and may only list EVM and Solana in its modal.
2. Whether a React-SDK page on our origin, with the same `appId`, reuses the js-sdk-core session (both use `privy:*` localStorage keys), or needs a fresh login.
3. The exact key format, and whether it imports into Meteor, MyNearWallet or `near-cli-rs` as-is.
4. Whether our wallets are TEE-based or on-device. This affects which export paths apply.

### 6.2 If the test passes

Add an isolated `web/privy-export.html` entry, the only React code in the repo, lazy and separate from both the wall and `privy-sign.html`. It uses pinned `@privy-io/react-auth` and calls `exportWallet({address})` for the selected NEAR wallet only. Meta Poo never reads, stores, logs or transmits the key, and the modal is Privy's. Before opening it, show: "Your private key gives **full control** of this account. Anyone who sees it can take everything. Don't screenshot it or paste it into chats. Meta Poo will never ask for it." After export, show the two-key disclosure from §3, because Privy still holds its copy. Graduation (§5) remains the way to make the account exclusively the player's.

### 6.3 If it fails

Ship Path A alone. Record the evidence (versions, error, wallet type) in `docs/research/`, and ask Privy support whether core-SDK NEAR wallets can be exported. Do not use the REST endpoint or ship an app secret. Do not reimplement Privy's key assembly.

### 6.4 Security note for Hermes

Because export is "enabled by default" and possible "with their own access token", an attacker who steals a player's Privy access token (for example through XSS on our origin) may be able to export the key whether or not we build Path B. Path B does not create that exposure. Deciding whether to add a DENY export policy (which would also block Path B) is Q4.

## 7. Acceptance criteria

1. The panel lists keys correctly for: a fresh Privy account (Privy only); a painter (Privy + drawing key); after Path A (Privy + your key); and after graduation (your key, plus any drawing key). An RPC failure never shows an empty list.
2. Path A on testnet: a key generated offline (for example a fresh recovery phrase from a NEAR key tool, or a Ledger NEAR app public key) is added. `view_access_key` shows FullAccess, and the player then signs a NEAR transfer with that key through a non-Privy route.
3. The Privy window rejects FullAccess with no pending record, a mismatched key, a wrong suffix or an unchecked box (Approve disabled), a different account, an extra action or transaction, or a key already present.
4. Every existing drawing-key test passes unchanged. The drawing `AddKey` branch source is unchanged in the diff (reviewer check).
5. Graduation is impossible through the Privy window. After graduation on testnet, Privy sign-in shows the graduated copy and cannot approve anything.
6. Path B is behind `VITE_PRIVY_EXPORT_ENABLED`, default false, and stays off until §6.1's four unknowns are recorded as passed.

## 8. Test plan

Unit tests in `web/src/integrations/privy/privy.test.ts`, in `describe("self-custody keys")`:

- **Accepts** one `AddKey(FullAccess)` matching the pending record, and returns `confirm.suffix` equal to the last 8 characters. **Accepts** one `DeleteKey` of a pending "your key".
- **Rejects** `AddKey(FullAccess)` in each of these cases:
  - no pending record, or an expired one;
  - a different `publicKey` or `sessionEpoch`;
  - the receiver is not the signer;
  - the key is Privy's key or the drawing key;
  - a 64-byte key or a non-canonical base58 key;
  - two actions, two transactions, or `FullAccess` alongside a `Transfer`.
- **Rejects** `FullAccess` in `signIn.addFunctionCallKey`.
- **Rejects** `DeleteKey` of the Privy key in all of these forms: alone, with a matching "remove-own-key" record that names it, and in a batch.
- **Regression**: the existing "rejects sponsorship, full-access additions, arbitrary key deletion and invalid gas" and "permits only the already approved drawing-key scope" tests, byte-for-byte unchanged.

Sign-page component tests in `sign-page.test.ts`:

- Approve stays disabled until the suffix matches case-sensitively and the box is checked.
- Pasting into the suffix field is allowed (some wallets only let you copy), but whitespace is trimmed.
- The masked characters never appear in the DOM.
- A stale review (the pending record cleared in another tab) aborts at Approve.

Game-side tests:

- Public-key parser, with the private-key and phrase detectors.
- Key-list labelling.
- The graduation checklist and `REMOVE` gate.
- Graduated-state detection from `expectedKeyMatches === false`.

Testnet evidence (gate CUSTODY-TESTNET):

- Path A end to end.
- Removal of an added key.
- Graduation with a non-Privy wallet connected to the same implicit account.
- A Privy sign-in after graduation.

Record redacted hashes and before/after `view_access_key_list`. Never include private keys.

Path B live test (gate CUSTODY-EXPORT-LIVE): run on testnet with a throwaway Privy user, then once on mainnet with a team account holding a dust balance. Record the four unknowns in §6.1.

## 9. Open questions for review

- **Q1. Which external wallets do we name?** The flow needs a wallet that can (a) show a public key for a new key or a Ledger path, and (b) later sign for an existing implicit account, for example Ledger via a NEAR Connect wallet, or Meteor/MyNearWallet importing a recovery phrase created offline. This needs a hands-on check before we write help copy.
- **Q2. Suffix length.** 8 characters is the proposal. 10 raises the grinding cost about 3,400×, at the price of more typing on mobile.
- **Q3. Graduation waiting period.** 24 hours after adding a key is proposed. It gives time to notice a key that isn't yours and remove it. Zero is the alternative.
- **Q4. Export policy.** Keep Privy's default (export enabled) for player sovereignty, or add a DENY policy and rely on Path A only?
- **Q5. React on an isolated page.** Path B needs `@privy-io/react-auth` on its own entry. That is consistent with the 11-03 spec's "isolated React page only with documented blocker" rule, but it adds a dependency. Acceptable?
