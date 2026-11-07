# Meta Poo

A communal pixel wall on NEAR where **the economy is the gameplay**. Whoever paints a square last owns
its colour. Fresh paint costs more to cover, holding squares earns the TOILET memecoin, and every
credit bought feeds a buyback of mPOO for TOILET stakers. Berry Club is the technical reference;
r/place is the interaction reference.

**Live (mainnet testing round):** https://metapoo-testnet.vercel.app. This is a beta. The board will
be paused and this TOILET will become worthless after the round. The NEAR you spend there is real.

## NEAR HACKATHON

Submitted to **Games With Real Economies** and **Memecoins With Mechanics**.

| | |
|---|---|
| Baseline (before the 2026-10-19 announcement, not for judging) | tag [`pre-hackathon`](https://github.com/satojandro/metapoo/tree/pre-hackathon) = `ff08ccf` (2026-10-18). A free, unpaid 128 × 128 wall contract (`contracts/board`) and an early page |
| Built in the hackathon window | everything after that tag: [`pre-hackathon...main`](https://github.com/satojandro/metapoo/compare/pre-hackathon...main). The final tag `hackathon-submission` goes on the submitted commit |
| Pre-existing third-party pieces | mPOO (`mpoo.nearlytrade.near`) is an existing token by NEARLY, not ours. Meta Poo buys it back and distributes it. RHEA / Ref pools are used for the swap route |

**What was built in the window:**

- **Paid wall contract** (`contracts/paid-board`, schema 4). Prepaid credits bought with NEAR, and repaint pricing by paint age.
- **Revenue split.** 10% team and 90% buyback on NEAR, then 10 / 20 / 70 on mPOO, with the 70% going to stakers.
- **Emission and safety.** Claim-based TOILET emission per held square per second, pause, bounded price changes, and one-time staking hook-up.
- **TOILET token** (`contracts/toilet`). NEP-141 with a 1B hard cap and emitter-only minting. Buy/sell tax is 2% / 3%, of which 30% goes to the treasury and 70% is burned.
- **TOILET staking** (`contracts/toilet-staking`). Stake TOILET to earn mPOO, which drips at most 10% of the pool per day. A paperhand tax burns 10% of every unstake.
- **Keepers** (`ops/keeper`, `ops/buyback`). The hourly revenue distribution and the NEAR → mPOO buyback run unattended.
- **The page** (`web/`).
  - Art / Price / Age / Turf views of the wall, and a tile inspector that works on hover.
  - Credit purchase and stroke painting.
  - A **drawing key**: a function-call key scoped to the board, so painting needs one wallet approval instead of a popup per square.
  - TOILET, Stake and "Where the money goes" pages.

### How the mechanics work

**Gameplay: the wall's economy.**

- **Repaint pricing.** A square costs 1 credit when it is blank or untouched for an hour, 2 credits when it was painted 10–60 minutes ago, and 4 under 10 minutes. New work gets a moment on the wall before it is cheap to cover.
- **Credits.** A credit costs 0.0025 NEAR. The owner can change this, but only within ×2 per day.
- **Turf.** Squares you hold accrue TOILET for as long as nobody paints over them. The Turf view shows who holds the most.
- **No wallet popup per square.** After one approval, a stroke of many squares is painted through the drawing key.

**Memecoin: the loop TOILET lives in.**

`credits bought (NEAR)` → `distribute_near`: 10% team, 90% buyback account → buyback keeper swaps
NEAR → mPOO and returns it to the board → `distribute_mpoo`: 10 / 20 / 70, with the 70% going to the
TOILET staking pool → stakers earn mPOO, and unstaking burns 10% of the TOILET. TOILET trades carry
a 2% / 3% tax, 70% of which is burned.

### Built with

- **Contracts:** `near-sdk` 5.29.1 and `near-contract-standards`, built with `cargo near`.
- **Page:** Vite, TypeScript, Vitest, happy-dom.
- **Wallets and RPC:** `@hot-labs/near-connect`, `@near-js/*`, `qrcode`, FastNEAR RPC.
- **Built but switched off:** Privy login (`@privy-io/js-sdk-core`, `@peerfolio/privy-near-connect`), NEAR Intents 1Click funding (`@defuse-protocol/one-click-sdk-typescript`) and the RHEA mPOO swap. These are fixture-tested only and stay off behind `VITE_PRIVY_ENABLED`, `VITE_INTENTS_FUNDING_ENABLED` and `VITE_RHEA_MPOO_SWAP_ENABLED`.
- **AI-generated code:** much of this repository was written by AI coding agents, Claude Code and OpenAI Codex, working from owner decisions and work orders in `docs/`. The owner reviewed and merged the pull requests.

## Where the project actually is

Re-derived 2026-11-07 at `main`. Chain values are `final`-block reads on mainnet that day. Re-check
before you trust any row.

| piece | state | evidence |
|---|---|---|
| **Paid wall** (`contracts/paid-board`, schema 4) | **Live on mainnet** (testing round) at `fcd66acf…f59e`. 64 × 64, 604 squares painted | `get_board`, `get_pixels`; [deploy record](docs/payments/mainnet-test-deployment-2026-11-05.md), [upgrade record](docs/payments/mainnet-board-version-upgrade-2026-11-06.md) |
| **TOILET** (`contracts/toilet`) | **Live on mainnet** at `a571dead…01ee`. Total supply ≈ 6,105 TOILET, minted only by painting | `ft_metadata`, `ft_total_supply`; [deploy record](docs/payments/mainnet-test-deployment-2026-11-05.md) |
| **TOILET staking** (`contracts/toilet-staking`) | **Live on mainnet** at `57590a9e…f55c`, wired to the board | [staking record](docs/payments/mainnet-staking-deploy-2026-11-06.md) |
| **Keepers** (`ops/keeper`, `ops/buyback`) | Scheduled hourly on mainnet since 2026-11-06. **No buyback swap has executed yet**: the route is validated by quotes only | [revenue automation record](docs/payments/mainnet-revenue-automation-2026-11-06.md) |
| **Page** (`web/`) | Deployed at the URL above, on mainnet | `npm test`: 879 tests; `npm run build` clean |
| **Testnet** | Paid board `board3.metapoo-player1.testnet`, TOILET `metapoo-toilet.testnet`. `web/.env.example` points here | [testnet record](docs/payments/testnet-deployment-2026-10.md) |
| **Free wall** (`contracts/board`, schema 2) | Retired; testnet fixture at `wall.berrywall1.testnet` (pre-hackathon baseline) | — |

**Not a production launch.** The mainnet accounts are burnable implicit accounts for a testing round.
The launch blockers are in [`docs/payments/mainnet-deploy-runbook.md`](docs/payments/mainnet-deploy-runbook.md)
and [`docs/backlog.md`](docs/backlog.md).

## Run it

```bash
# page: tests + production build
cd web && npm install && npm test && npm run build

# contracts (local tests only — not a chain)
cd contracts/paid-board && cargo test
cd contracts/toilet && cargo test
cd contracts/toilet-staking && cargo test
cd contracts/board && cargo test

# keepers (unit tests)
cd ops/keeper && npm install && npm test
cd ops/buyback && npm install && npm test
```

Point the page at a deployment by copying `web/.env.example` to `web/.env` (see
[`web/README.md`](web/README.md)). `.env.example` names the testnet paid board.

## Read next

- [`AGENT.md`](AGENT.md): the entry point for any agent, and the definition of done.
- [`docs/README.md`](docs/README.md): the map, with one authoritative document per topic.
- [`docs/backlog.md`](docs/backlog.md): what is left, each row with its proof.
- [`docs/learning/traps.md`](docs/learning/traps.md): mistakes that already cost this project time.
- [`docs/payments/`](docs/payments/): the paid model, deployment records and the mainnet cost gate.
- [`docs/economy/`](docs/economy/): the TOILET economy and round spec.

## Repository

```
contracts/paid-board      paid schema-4 wall: credits, repaint pricing, revenue split, TOILET emission
contracts/toilet          TOILET NEP-141 token: 1B cap, emitter-only mint, buy/sell tax
contracts/toilet-staking  stake TOILET, earn mPOO, 10% burn on unstake
contracts/board           free schema-2 wall (pre-hackathon baseline, testnet fixture)
shared/                   board.json + TypeScript rules the page and contracts both enforce
web/                      Vite + TypeScript page
ops/                      revenue keeper, buyback keeper, deploy guard
docs/                     decisions, roadmap, backlog, payments, economy, learning records
```

## Evidence boundary

Prices, balances and settlement claims in this repository are **local test results or on-chain reads
named at the point of use**. A green test run is not evidence that a transaction happened. The mainnet
cost matrix ([`docs/payments/mainnet-cost-validation.md`](docs/payments/mainnet-cost-validation.md)) is
not complete, and no buyback swap has executed on mainnet yet.

## Licence

[MIT](LICENSE).
