# Meta Poo

A communal pixel wall on NEAR: 128×128, eight colours, open wall — whoever paints a square last owns
its colour, and every square records who painted it and when. Berry Club is the technical reference;
r/place is the interaction reference.

## Where the project actually is

Re-derived 2026-10-29 at `main` = `09965fe`. Re-check with `git log` and on-chain reads before you
trust any row.

| piece | state | evidence |
|---|---|---|
| **Paid wall** (`contracts/paid-board`, schema 4) | **Live on testnet** at `board3.metapoo-player1.testnet`. Prepaid credits (NEAR; mPOO path in contract only), repaint pricing 1/2/4 credits by cell age, pause, bounded price changes, treasury withdrawal | [deployment record](docs/payments/testnet-deployment-2026-10.md); 86 contract tests |
| **Page** (`web/`) | Buys credits with NEAR, shows the repaint price, paints strokes through a drawing key. **No recorded end-to-end journey yet** | 257 tests, build clean; `PAY-INTEGRATION` in the [backlog](docs/backlog.md) |
| **TOILET** (`contracts/toilet`) | **Live on testnet** at `metapoo-toilet.testnet`, 1B cap, no owner. Emission is claim-based; the default rate is 0 (not re-read on chain for this table). No claim or staking UI | 24 contract tests |
| **Free wall** (`contracts/board`, schema 2) | Retired as a product; testnet fixture at `wall.berrywall1.testnet` | 23 contract tests |
| **Mainnet** | **Nothing deployed.** Blockers are listed in the [code audit](docs/2026-10-29-code-audit.md) | — |

A credit costs **0.0025 NEAR** (owner-configurable within ×2 per day). A cell costs 1 credit when empty
or untouched for an hour, 2 when last painted 10–60 minutes ago, and 4 under 10 minutes.

## Read next

- [`AGENT.md`](AGENT.md) — the entry point for any agent, and the definition of done.
- [`docs/README.md`](docs/README.md) — the map: one authoritative document per topic.
- [`docs/backlog.md`](docs/backlog.md) — what is left, each row with its proof.
- [`docs/learning/traps.md`](docs/learning/traps.md) — mistakes that already cost this project time.
- [`docs/payments/`](docs/payments/) — the paid model, its decisions, and the mainnet cost gate.
- [`docs/2026-10-29-code-audit.md`](docs/2026-10-29-code-audit.md) — findings and the order of work toward mainnet.

Everything else is in [`docs/archive/`](docs/archive/README.md). Nothing there is instruction.

## Run it

```bash
# page: tests + production build
cd web && npm install && npm test && npm run build

# contracts (local tests only — not a chain)
cd contracts/paid-board && cargo test
cd contracts/toilet && cargo test
cd contracts/board && cargo test
```

Point the page at a deployment by copying `web/.env.example` to `web/.env` (see
[`web/README.md`](web/README.md)). `.env.example` already names the testnet paid board.

## Repository

```
contracts/paid-board   paid schema-4 wall: credits, repaint pricing, safety, TOILET emission
contracts/toilet       TOILET NEP-141 token: 1B cap, emitter-only mint, venue tax
contracts/board        free schema-2 wall (testnet fixture)
shared/                board.json + TypeScript rules the page and contracts both enforce
web/                   Vite + TypeScript page
docs/                  decisions, roadmap, backlog, payments, economy, learning records
```

Bounties, prints, the history service and the pressure simulation were removed on 2026-10-29. They are
recoverable from the tag `archive/pre-cleanup-2026-10-29`.

## Evidence boundary

Prices, balances and settlement claims in this repository are **local test results or on-chain reads
named at the point of use**. Contract-level purchases and paints have been exercised on testnet by a
script harness (see the deployment record); a recorded run through the page has not. No mainnet deployment
exists, and the mainnet cost matrix (`docs/payments/mainnet-cost-validation.md`) is entirely pending. Do not
treat a green test run as evidence that a transaction happened.
