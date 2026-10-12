# NEAR Intents and chain abstraction for Meta Poo

Date checked: 11 October 2026. Research only. No dependency and no integration were added. Re-check the links at the end before any later build. The five starting URLs in the agent brief returned HTTP 404 on this date.

## User need

The free board already has a job: look at the wall, connect a NEAR wallet, paint one cell, and trust the result only after a real transaction. The game adds no fee. The wallet may still pay NEAR gas. Sponsorship is off.

Five later ideas get called "chain abstraction." They are different jobs.

1. **Pay an optional fee with an asset the user already holds.**
2. **Sign in with an account from another chain.**
3. **Trigger a game action whose state is on NEAR.** That action is `draw` on the board contract.
4. **Bridge or swap assets before using the game.**
5. **Sponsor a NEAR transaction so the user does not need gas.**

Only goal 4 matches the current Intents documents end to end. A finished swap is not a painted pixel.

## Options

| Goal | What the 11 October 2026 docs support | Verdict |
|---|---|---|
| 1. Pay with an asset they hold | 1Click quotes and settles **listed** assets. A fee still needs a NEAR payment after the asset arrives. An asset already on NEAR can be paid by a direct transfer. | Intents can prepare a listed asset. The fee needs a separate payment step. |
| 2. Sign in from another chain | A foreign key can sign an intent and can map to an account **inside** `intents.near`. That is not an access key on the board. | Not supported by evidence as game login. Needs a NEAR wallet, or a later relayer plus a NEAR key. |
| 3. Trigger the on-NEAR game action | The integration guide's intents move assets. Crate rustdoc adds `AuthCall`, which calls fixed method `on_auth`. The board has no `on_auth`. Mainnet acceptance was not tested. | Not supported by evidence as a way to paint. `draw` needs its own NEAR transaction. |
| 4. Bridge or swap, then play | Quote, deposit or signed intent, solver settlement, status, and a refund address. | Intents directly addresses this for assets on the live list. Playing is still a later NEAR action. |
| 5. Sponsor gas for the paint | Solvers pay gas for `execute_intents` on `intents.near`. NEP-366 is the documented way to relay an arbitrary NEAR call. | Sponsoring `draw` needs a separate relayer. |

## What Intents is documented to do

An intent, in these docs, is an outcome such as "I have token A and I want token B delivered here." Market makers (solvers) compete. The Verifier contract `intents.near` checks the signed intents and settles them. There is **no testnet**. The docs say to test with small mainnet amounts.

**Origin-chain path (1Click).** Read `GET /v0/tokens`, then `POST /v0/quote` at `https://1click.chaindefuser.com`. The user signs a normal transfer on the chain where the asset already lives, to the quoted deposit address. Optional `POST /v0/deposit/submit` speeds detection. The app polls `GET /v0/status`. The docs say 1Click does not take custody: funds go to a quote-specific address and settle on-chain.

**Balance already inside Intents.** A NEP-141, NEP-171, or NEP-245 deposit credits the Verifier ledger. Native NEAR must be wrapped first; the docs say not to send unwrapped NEAR to the contract. For `depositType: INTENTS`, the user signs the payload from `POST /v0/generate-intent`, and the app sends it with `POST /v0/submit-intent`. A named NEAR account must call `add_public_key` first. An implicit account derived from the public key skips that step.

Documented signature standards are NEP-413, ERC-191, TIP-191, raw Ed25519, WebAuthn, TonConnect, and SEP-53. The payload carries the signer, a deadline, a one-time nonce, and the intent list. The NEP-413 recipient is `intents.near`. The nonce salt rotates and must be read before building an intent. Those rules are the documented replay controls for **intents**, not for `draw`.

The integration guide's intent types are: add or remove a public key, ledger transfer, withdraw, storage deposit, and `token_diff`. A batch of token diffs must sum to zero per token or the whole batch fails. Someone else submits `execute_intents` and pays that transaction's NEAR gas: 1Click, the Message Bus, or another solver path. The docs say the protocol can also run without the bus.

Settlement updates the Verifier ledger. Leaving for another chain uses a bridge. The bridge page names three routes with different operators: Omni, a proof-of-authority bridge, and HOT. The Verifier introduction says Intents Technology does not custody those balances.

The app sets `slippageTolerance` in basis points. Examples use 100 (1%). Documented fees, on top of the solver's price: 0.0001% on-chain protocol fee; 1Click adds 0.25% without an API key, or about 0.20% with a key (0.01% for stablecoin and same-asset multichain routes); an app may add `appFees`. A better-than-quote fill on a fresh cross-asset swap is documented as a 50/50 split of the improvement. The 0.2% near-intents.org website fee applies to that site, not automatically to your own app.

**Recovery.** Status values are `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, and `FAILED`. The going-live page says to allow about 15 minutes and points support to Telegram plus the Intents explorer. The status schema says to save the quote and its signature for disputes. Exact-input short deposits are refunded to `refundTo` by the deadline; excess is refunded after the swap. Exceptions: partner-only `ANY_INPUT` has **no refunds**; a withdrawal `msg` (even `""`) uses a transfer-call and is **not** refunded on failure; `AuthCall`'s attached wrapped NEAR is documented as non-refundable if `on_auth` fails.

## Game action, login, and MPOO

**Paint.** A 1Click swap settles a listed asset. It does not call `draw`. The published `defuse_core` 0.1.0 rustdoc, which lists more variants than the integration guide, defines `AuthCall` as `contract_id::on_auth(signer_id, msg)`. The board has no `on_auth`. This research did not simulate `auth_call` on mainnet `intents.near`. Chain Signatures, the other primitive on the NEAR overview page, let a NEAR account sign **other** chains. That is the reverse of logging in from an outside wallet to paint this wall.

**Login.** An Intents implicit account can sign intents against `intents.near`. The board still needs a NEAR access key, or a relayed NEAR transaction signed by one.

**MPOO is not claimed as supported.** On 11 October 2026, `GET /v0/tokens` returned 204 tokens. None had `mpoo` or `nearlytrade` in the symbol, asset id, or contract address. The account name was not treated as evidence. A different asset is listed: `mpDAO` at `nep141:mpdao-token.near`. That listing is not MPOO.

The deposit page says any NEP-141 can be deposited. That is a rule about the standard, not proof of transfer compatibility or membership in the swap list. **12 October update:** the [MPOO readout](2026-10-12-mpoo-live-contract-readout.json) verifies metadata and configured 2% / 3% trading tax with venue and allocation settings. Actual transfers, refunds and Intents deposit compatibility still need trials. Swap support also requires an exact `assetId` on a fresh token list; this historical listing observation does not establish present support. Current on-NEAR payment scope is in the [economy plan](../2026-10-12-paint-economy-and-swap-plan.md).

## Simpler path on NEAR

**Gas.** Keep the user-signed `draw`. If a later phase must remove gas, NEP-366 is the documented tool: the user signs a delegate action, and a relayer the team funds pays the fee. The call still runs as the user. The roadmap already puts this at stage 2, with custody, replay limits, budgets, and a kill switch. The relayer key stays off the web page. The tutorial warns that a relayer can pay gas and still not be repaid if a balance changes, and that the older wallet-selector path could not sign without sending. Whether `@hot-labs/near-connect` can sign a delegate action is unanswered.

**Fee, when the asset is already on NEAR.** After the token contract is read, accept NEAR or a NEP-141 in a payment method that is separate from pixel storage. That is roadmap stage 3. No solver and no bridge.

**Intents.** Roadmap stage 5, and only for a user who holds a **listed** asset and accepts a visible swap before a separate NEAR action.

## Recommended phase

Leave the free board unchanged. If the later pain is gas, add a capped NEAR relayer for `draw`. If the later pain is a fee in an on-NEAR asset, add a direct payment after the token is verified. Use Intents only as a labeled swap in front of those steps. The wall changes only after the board transaction is observed.

## Architecture sketch

```text
Now:     NEAR wallet --signs draw--> board contract --> wall
         Wallet may pay gas. No game fee.

Later:   NEAR key --scoped delegate--> team relayer --pays gas--> board
         Relayer key off the page. Caps and a kill switch required.

Swap:    wallet --quote--> 1Click / solvers --> intents.near
         listed asset arrives at a chosen NEAR account
         then the user still takes the draw path above

A swap status of SUCCESS does not write a pixel.
An Intents account does not become the board signer.
```

## User-visible risks

- A completed swap or a signed intent can be mistaken for a painted cell.
- Cross-chain processing is documented at up to about 15 minutes, and the quote deadline can pass while the user waits.
- Slippage, the protocol fee, the 1Click fee, an app fee, and any unread token tax can change the amount received. A short deposit stays `INCOMPLETE_DEPOSIT` until refund.
- `FAILED` and `REFUNDED` are different. `ANY_INPUT` does not refund. A withdrawal `msg` turns off the Verifier refund.
- Replay protection on an intent does not protect `draw`. A sponsor still needs its own nonce, expiry, and argument binding.
- Token id prefixes differ between intent types. mpDAO on the live list is not MPOO. The wrong asset can be sent to a deposit address.
- Solvers, 1Click, and the bridges are outside this team's control. The proof-of-authority bridge is a different trust model. Compliance screening is documented on quote flows; the player-facing result of a stop was not established.
- Support is documented as Telegram plus the saved quote. There is no testnet, so a mistake is a mainnet mistake. The docs' mitigation is a small amount.

## Integration prerequisites

- The product choice is goal 4, for an asset that appears on a fresh `/v0/tokens` response.
- Fee or destination asset, refund address, maximum slippage, and deadline are written in language a player can read before sending funds.
- A partner API key is in place if the lower fee schedule matters.
- The page stores the quote and signature and polls until a terminal status.
- Swap `SUCCESS` cannot mark a draw successful. MPOO stays excluded until the evidence above exists.
- The threat sketch, which leaves Intents out of scope on purpose, is updated first.
- Docs, the token list, and the fee schedule are read again. This memo's own links can go stale the same way the brief's links did.

A gas-sponsor phase needs its own funded relayer, key custody, caps, replay checks, a kill switch, and a wallet that can sign a delegate action.

## Sunday-team cost

Operating a solver or a bridge is out of proportion to this game. Even a 1Click integration is a production dependency on an external API, external solvers, and external bridges, plus mainnet-only tests and refund support. The documentation move that 404'd the brief is a sample of that upkeep.

The smaller options are the ones already sequenced: an unsponsored `draw`, then maybe a capped relayer or a direct on-NEAR payment. One network, one contract action, one success signal.

## Unanswered

- Does deployed `intents.near` accept `auth_call`, or is that variant only in the crate rustdoc?
- Does `mpoo.nearlytrade.near` implement NEP-141, and does a transfer take a fee? Not read here.
- Can `@hot-labs/near-connect` sign a NEP-366 delegate action without broadcasting it?
- What does a player see if compliance screening stops a quote, and when is money returned?
- What is the gas and storage cost of one `draw`? A sponsor budget needs that number. It is not measured yet.
- Is a future fee NEAR, MPOO, or another asset? Intents cannot be sized until that choice exists.

## Sources

Fetched 11 October 2026. Brief URLs that 404'd: `/tutorials/intents/introduction`, `/tutorials/intents/deposit`, `/tutorials/intents/swap`, `/chain-abstraction/intents/intents-bridge`, `/quest/dapps/building-blocks`.

**Docs.** [Chain abstraction](https://docs.near.org/chain-abstraction/what-is), [Intents overview](https://docs.near.org/chain-abstraction/intents/overview), [What are intents](https://docs.near-intents.org/getting-started/what-are-intents), [1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api), [making a request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request), [signed execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution), [swap types](https://docs.near-intents.org/integration/distribution-channels/1click-api/swap-types), [going live](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/going-live), [fees](https://docs.near-intents.org/resources/fees), [assets](https://docs.near-intents.org/resources/asset-support), [Verifier](https://docs.near-intents.org/integration/verifier-contract/introduction), [account abstraction](https://docs.near-intents.org/integration/verifier-contract/account-abstraction), [intent types](https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution), [signing](https://docs.near-intents.org/integration/verifier-contract/signing-intents), [deposits](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits), [withdrawals](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals), [bridges](https://docs.near-intents.org/integration/bridging/overview), [Message Bus](https://docs.near-intents.org/integration/market-makers/message-bus/introduction), [compliance](https://docs.near-intents.org/security-compliance/risk-and-compliance), [NEP-366](https://docs.near.org/protocol/transactions/meta-tx), [relayer tutorial](https://docs.near.org/web3-apps/tutorials/meta-transactions), [near-connect](https://docs.near.org/tools/near-connect).

**SDKs and source, not installed.** [1Click TypeScript](https://github.com/defuse-protocol/one-click-sdk-typescript), [Go](https://github.com/defuse-protocol/one-click-sdk-go), [Rust](https://github.com/defuse-protocol/one-click-sdk-rs), [SDK page](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk), [Intents SDK](https://github.com/defuse-protocol/sdk-monorepo/tree/main/packages/intents-sdk), [examples](https://github.com/near-examples/near-intents-examples), [Verifier source](https://github.com/near/intents), [Intent enum rustdoc](https://near.github.io/intents/defuse_core/intents/enum.Intent.html), [OpenAPI](https://1click.chaindefuser.com/docs/v0/openapi.yaml).

**Live check, not a docs claim.** `GET https://1click.chaindefuser.com/v0/tokens` on 11 October 2026: 204 tokens; no MPOO; `mpDAO` present at `nep141:mpdao-token.near`.

**Judgment, not a quote from the docs.** A Sunday team should not operate a solver or a bridge. The docs describe those as external roles. They do not forbid taking one on. The cost conclusion is this memo's.
