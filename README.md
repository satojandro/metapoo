# Meta Poo

A communal pixel wall on NEAR: 128×128, eight colours, open wall — whoever paints a square last owns
its colour, and every square records who painted it and when. Berry Club is the technical reference;
r/place is the interaction reference.

## Where the project actually is

| piece | state | evidence |
|---|---|---|
| **Free wall** (`contracts/board`, schema 2) | **Live on testnet** at `wall.berrywall1.testnet` — drag strokes, drawing sessions, 2,301 painted cells | `get_board` / `get_pixels` on testnet |
| **Paid wall** (`contracts/paid-board`, schema 4) | **On `main`, not deployed.** Prepaid credits bought with NEAR or direct mPOO; repaint pricing 1/2/4 credits by cell age; 54 contract tests | `main` = `0a3e284`; `cargo test` |
| **Checkout + repaint UI** | **Not built.** The panel is read-only. Task orders in `docs/implementation/` | `pay-checkout.task.json`, `pay-recency-ui.task.json` |
| **TOILET economy** | **Specified, not built.** Fixed cap, issuance, staking claim, burns | `docs/economy/` |
| **Mainnet** | **Nothing deployed.** | owner decision 2026-10-28 |

A pixel currently costs **0.0069 NEAR** on the paid board (owner-configurable), with a repaint costing
more the sooner it happens: 1 credit for an empty cell or one untouched for an hour, 2 at 10–60 minutes,
4 under 10 minutes.

## Read next

- [`AGENT.md`](AGENT.md) — the entry point for any agent, and the definition of done.
- [`docs/README.md`](docs/README.md) — the map: one authoritative document per topic.
- [`docs/backlog.md`](docs/backlog.md) — what is left, each row with its proof.
- [`docs/learning/traps.md`](docs/learning/traps.md) — mistakes that already cost this project time.
- [`docs/payments/`](docs/payments/) — the paid model, its decisions, and the mainnet cost gate.

Everything else is in [`docs/archive/`](docs/archive/README.md). Nothing there is instruction.

## Run it

```bash
# page: tests + production build
cd web && npm install && npm test && npm run build

# contracts (local tests only — not a chain)
cd contracts/board && cargo test
cd contracts/paid-board && cargo test
```

Point the page at a deployment by copying `web/.env.example` to `web/.env` and setting
`VITE_CONTRACT_ID` (see [`web/README.md`](web/README.md)). The free board's testnet id is already the
default in `.env.example`; the paid board has never been deployed.

## Repository

```
contracts/board        free schema-2 wall (testnet fixture)
contracts/paid-board   paid schema-4 wall, credits + repaint pricing
contracts/bounties     art-bounty escrow (separate, not wired to payments)
contracts/prints       historical print mints (separate)
shared/                board.json + TypeScript rules the page and contracts both enforce
web/                   Vite + TypeScript page
docs/                  decisions, roadmap, backlog, payments, economy, learning records
```

## Evidence boundary

Prices, balances and settlement claims in this repository are **local test results or on-chain reads
named at the point of use**. No paid flow has been settled on testnet yet, no mainnet deployment exists,
and the mainnet cost matrix (`docs/payments/mainnet-cost-validation.md`) is entirely pending. Do not
treat a green test run as evidence that a transaction happened.
