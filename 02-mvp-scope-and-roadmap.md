# 02 MVP Scope and Staged Roadmap

## Sunday MVP: one complete loop

### Include

- A responsive single-page pixel board, provisionally 128 × 128.
- A limited palette and one clear pixel action.
- Read-only board access without a wallet.
- NEAR wallet connect/disconnect and network identity display.
- Contract-backed write flow with pending, confirmed, rejected, and failed states.
- Pixel ownership state and event/history data sufficient to explain the current board.
- A non-sponsored wallet path, even if sponsorship research is still underway.
- Optional capped sponsorship only after the security and budget checks in this pack pass.
- A short rules panel, transaction explorer link, and basic operational instructions.
- Local tests and a testnet rehearsal before any mainnet use.

### Exclude

MPOO transfers, NEAR application payments, creator fees, treasury routing, MPDAO accumulation, buybacks, Intents, cross-chain action execution, rage quit, user-created assets, and marketplace features.

## Roadmap gates

| Stage | Outcome | Gate to advance |
|---|---|---|
| 0. Foundation | Repository map, threat sketch, rules decision, technical spike | Owners, network, contract state model, and pixel ownership semantics are written down |
| 1. Free board MVP | A user can connect and draw on one shared board | Acceptance criteria pass on local/test environment; wallet failure cases are handled |
| 2. Bounded gas sponsorship | Selected users can draw without holding gas, under explicit limits | Sponsor key custody, replay protection, abuse controls, budget alerting, and kill switch reviewed |
| 3. Optional MPOO and NEAR payments | A user may choose a payment route for clearly described features | Token contract and behavior verified; fee math, storage, refunds, tax and failure handling reviewed |
| 4. Creator fees and MPDAO treasury | Creator fees and game revenue can flow to a transparent treasury | Legal/product policy, custody, accounting, access controls, reporting and governance reviewed |
| 5. NEAR Intents / chain abstraction | Research-backed path to authorize or settle selected actions across networks | Supported assets and workflows confirmed; threat model and user recovery designed; no hidden bridging |
| 6. Opt-in rage quit research | Optional exit rights are explored for a future Moloch-style design | Independent economic, contract-security, governance, and UX review; no MVP dependency |

## Pixel tenure reward experiment

Treat time-based rewards as a later experiment, not part of the Sunday MVP. Begin with a non-financial tenure statistic or a bounded points trial. Add token payouts only after the overwrite rule, earning interval, anti-abuse limits, reward asset, finite budget, and payout source are approved.

## Schedule discipline

A Sunday MVP is a scope constraint, not a promise of mainnet launch. If the shared board, wallet action, or clear confirmation does not work by the agreed checkpoint, ship a truthful test environment demo and document the missing piece. Do not add token economics to compensate for an incomplete game loop.

## Dependency order

Pixel semantics and contract state shape precede frontend write integration. The chain-abstraction agent works independently as a research spike and does not block the free board. The contract and frontend agents agree on an interface before parallel implementation. Token and treasury phases begin only after the MVP has been demonstrated and the relevant facts are verified.

