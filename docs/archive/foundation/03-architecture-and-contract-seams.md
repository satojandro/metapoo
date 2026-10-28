# 03 Architecture and Contract Seams

## System shape

Keep the MVP on one NEAR network. A reasonable initial shape is:

- Frontend: board renderer, palette, wallet connection, transaction state, read adapter, write adapter.
- Game contract: board configuration, pixel state, claim/update rule, ownership or attribution, emitted events, admin controls if needed.
- Read path: direct contract views for small boards, or a replaceable indexer/cache if performance requires it. Reads must not become an alternate authority.
- Sponsor service: optional and separate from game logic; validates a narrowly scoped user action and applies budgets before signing or relaying.
- Configuration: network ID, contract ID, supported wallet adapters, feature flags, sponsor status, palette and board dimensions.
- Future payment adapter: isolated interface for optional NEAR or MPOO payment paths. No token assumptions should leak into pixel state logic.
- Future treasury adapter: separate accounting and payout interface. Do not give game contract broad control over treasury assets.

## Contract responsibilities

The game contract should enforce the chosen pixel rule, validate coordinates and palette values, update pixel ownership/state, and emit enough data for the UI and indexers to reconstruct changes. Define whether an owner may recolor, whether another account may overwrite, and if updates expire. Use explicit types and bounded inputs. Avoid unbounded per-call loops or user-controlled storage growth.

Suggested conceptual operations, subject to agent research:

- Read board metadata and pixel state.
- Claim or update a pixel with coordinates and a palette index.
- Read an individual pixel and its current owner.
- Read or page through event-backed history if contract storage supports it.

Do not implement token transfer hooks in the MVP. Do not assume the project should deploy a new MPOO token contract: the supplied MPOO account is intended to be an existing token contract reference.

## Contract interfaces and seams

Keep these conceptual interfaces small and replaceable:

- GameBoard: readBoard(), readPixel(x, y), draw(x, y, color), getPixelHistory(x, y).
- Wallet: connect(), disconnect(), accountId, networkId, signAndSend(action).
- GasSponsor: requestSponsoredAction(action, userSignature) returning a transaction reference or an explicit rejection. It must have policy limits and be independently disableable.
- PaymentProvider (future): quote(option), preparePayment(option), observePayment(reference). No payment methods are called in the free MVP.
- TreasuryRouter (future): recordRevenue(source, amount, asset), transferToTreasury(amount, asset). It needs separate access controls and reporting; these are design placeholders, not an implemented contract API.

The interface names are illustrative. The agents must inspect the repository and installed SDKs before settling on language, framework, wallet connector, or exact method signatures.

## Pixel ownership semantics

“Pixel ownership” is a product rule, not just a data field. It may mean the current account can change the pixel, that another user cannot, or that the most recent writer is credited. Choose one meaning, define if it can be transferred or expires, and display it plainly. Never imply legal ownership of art or exclusive rights beyond the implemented rule.

For a provisional 128 × 128 board, 16,384 pixels is small enough to be explored as a bounded design, but the contract storage model, read costs, event volume, and UI loading approach still need measurement. Store only what the game needs; consider whether empty pixels are implicit defaults.

## Tenure and overwrite seam

The contract and frontend must use one agreed overwrite rule. A useful MVP data shape can distinguish the current artist from the pixel's visual state and record the successful write time. A later-phase candidate is to close a tenure interval when a different artist successfully overwrites the pixel, and count `min(end time - start time, per-claim cap)` toward a finite season pool. A season cutoff closes remaining intervals. Same-artist recolors would not reset the clock under this candidate. This is a proposal to evaluate, not settled economics.

Recolor, empty pixels, downtime, duplicate writes, account switching, and same-account updates need defined treatment. Any eventual settlement must use per-pixel, per-account, and season caps, be replay-safe, and explain how Sybil farming is addressed.

Do not pay rewards on every block or let a pixel accrue unlimited value while untouched. Consider a capped tenure statistic or points first. Token rewards would need a finite pool, per-pixel/account/season caps, replay-safe settlement, transparent accounting, and a chosen reward asset and funding source. This seam is a design question, not a current contract feature.

## Token and revenue assumptions

Supplied but not chain-verified:

- Intended MPOO token contract account: mpoo.nearlytrade.near.
- Deployer account: meta-poo-shitcoin.near.
- Intended network: NEAR mainnet.
- Reported token tax: 2% on buys and 3% on sells.

The product request says free drawing now, optional MPOO and NEAR payments in later phases, and a future MPDAO treasury accumulating MPDAO from creator fees and game revenue. These are roadmap intentions, not current behavior. Do not infer that a token tax applies to a game contract transfer; verify contract code and transfer behavior before integrating. A transfer tax can alter received amounts, refunds, and accounting.

## Treasury and rage quit seams

Initially the treasury is centrally steered and transparent. If this becomes a real feature, define the controlling account or multisig, allowed assets, purpose of each inflow, fee schedule, reporting cadence, pause process, and upgrade/admin powers. Creator fee routing must be explicit, bounded, and observable.

Moloch-style rage quit is future opt-in research only. Model exits only after defining shares or units, snapshot timing, liabilities, queued transactions, illiquid assets, and what happens to assets that cannot be distributed. Do not market an exit right until the contract can honor it under adversarial conditions.

## Chain abstraction seam

Treat NEAR Intents as a future capability to investigate, not a promise of cross-chain drawing. Its documented patterns involve user intent signing and an execution/settlement flow; a swap or deposit integration is not the same as authorizing a game action on another chain. The research brief must determine whether the intended experience needs funds, identity, transaction execution, or just a payment option, and propose the simplest supported path.

Technical references checked 11 October 2026:

- NEAR dApp building blocks describe contracts, wallet, frontend, and network as distinct components: https://docs.near.org/quest/dapps/building-blocks
- NEP-141 and NEP-145 standards are listed by the official NEP index; NEP-145 explains user-funded storage management: https://near.github.io/NEPs/ and https://github.com/near/NEPs/blob/master/neps/nep-0145.md
- NEAR Intents integration overview: https://docs.near.org/tutorials/intents/introduction
- NEAR Intents deposit and swap workflows: https://docs.near.org/tutorials/intents/deposit and https://docs.near.org/tutorials/intents/swap

