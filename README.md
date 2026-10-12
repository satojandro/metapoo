# Meta Poo

This pack gives a small team a shared product brief, technical boundaries, staged plan, parallel Cursor workflow, focused agent assignments, and learning record. The first milestone is a working, free pixel-graffiti board on NEAR with wallet connection and transparent transaction status.

The project was scaffolded from the original agent pack. Berry Club / NEAR Place is a technical reference for communal board patterns (batching, refresh, drawing sessions) as well as product inspiration. Reddit r/place is the primary interaction reference for zoom, pan, and precise placement.

## Current reading path

Start with the [core pixel-board handoff](docs/implementation/core-board.md): established rules, implemented modules, remaining live checks, and what agents must preserve. Then read the [full product PRD](docs/2026-10-12-product-prd.md) for **pressure-priced painting, historical prints and Art Bounties**, and the [agent delivery plan](docs/implementation/delivery-plan.md). These specifications include user journeys, magic moments, the missing-feature inventory, domain interfaces and implementation handoffs. They describe the next product, not shipped features; mystery cards are excluded.

1. [Shared decisions](docs/00-shared-decisions.md) — implemented Open wall rules and confirmed next-phase economy decisions.
2. [Frontend guide](web/README.md) and [board contract guide](contracts/board/README.md) — running code, interfaces and verification limits.
3. [Economy plan](docs/2026-10-12-paint-economy-and-swap-plan.md) — the single current plan for MPOO-only paint purchases, TOILET longevity/burn, MPOO staking/payouts and the optional inventory shop.
4. [MPOO mainnet evidence](docs/research/2026-10-12-mpoo-live-contract-readout.json) — exact observed settings and block references; no transfer trial.

The implemented board is free. The economy above is planned, not enabled. Its latest decisions replace the original pack's optional NEAR payment and earlier NEAR payout proposals. Update the economy plan in place rather than creating another overlapping proposal.

October 2026 board work (viewport, shared updates, drawing session, 3D stall):

- Assessment / plan: `docs/2026-10-12-board-review-and-next-steps.md`
- Interaction brief: `docs/2026-10-12-viewport-and-interaction-brief.md`
- Stall visual references: `docs/2026-10-12-stall-visual-references.md`
- Saturated palette proposal (not shipped): `docs/2026-10-12-palette-proposal.md`
- Frontend how-to and known limits: `web/README.md`

## Original agent pack

These files preserve the original free-MVP scope, assignments and longer-term ideas. For current decisions and economy scope, use the reading path above.

1. [Product requirements](01-product-requirements.md)
2. [MVP scope and roadmap](02-mvp-scope-and-roadmap.md)
3. [Architecture and contracts](03-architecture-and-contract-seams.md)
4. [Cursor orchestration](04-cursor-parallel-agent-orchestration.md)
5. [Contract agent brief](05-agent-brief-contract.md)
6. [Frontend agent brief](06-agent-brief-frontend.md)
7. [Chain abstraction research brief](07-agent-brief-chain-abstraction-research.md)
8. [Acceptance security and QA](08-acceptance-security-and-qa.md)
9. [Learning journal](09-learning-journal.md)

## Evidence labels

- Supplied context: facts or directions provided in the referenced conversation or this request. They have not been independently checked against chain state.
- Design assumption: a provisional product or engineering choice to make the MVP implementable.
- Open question: a choice or fact that must be resolved before the affected phase.
- Verified research: a technical statement checked against linked primary documentation on 11 October 2026. This does not verify any project-specific contract or deployment.

## Important boundary

Pixel takeover is accepted as **Open wall**. Continuous tenure, payments and rewards are next-phase work, with rules and unset parameters in the economy plan. The implemented contract records the latest write time, not a separate continuous-tenure clock.

Read-only mainnet queries identified MPOO at `mpoo.nearlytrade.near`, its launch creator `meta-poo-shitcoin.near`, 18 decimals and configured 2% buy / 3% sell tax. The linked readout records exact blocks and tax allocations. Transfer/refund/burn behavior has not been trialled, and no live game deployment is established by that token inspection. Token transfers remain outside the implemented free MVP.

## Code in this repository

The files above are the product pack. The overwrite rule is **accepted: Open wall**. The contract can paint in local tests. The page still will not send a draw until a contract account id is configured.

Start here:

1. `docs/00-shared-decisions.md` — accepted Open wall rule, ride-along choices, interface
2. `docs/threat-sketch.md` — what this scaffold protects against
3. `contract/DESIGN.md` — broader contract notes

Runnable pieces:

- `shared/board.json` — board size, palette, and `overwrite_rule: "open_wall"`
- `shared/` — TypeScript checks and types shared with the page
- `contracts/board` — Rust contract: sparse pixels, Open wall `draw`, local unit tests
- `web` — Vite page: read-only board without a wallet, paginated `get_pixels` load/refresh, connect/disconnect on testnet, palette + keyboard selection, `draw` via wallet when `VITE_CONTRACT_ID` is set, success only after tx id + `get_pixel`

### Local checks

```bash
# Shared rule tests
node --test shared/board-rules.test.ts

# Page tests and production build
cd web && npm install && npm test && npm run build

# Contract unit tests (local only; not a NEAR node)
cd contracts/board && cargo test
```

Point the page at a deploy: copy `web/.env.example` → `web/.env` and set `VITE_CONTRACT_ID` (see `web/README.md`). Nothing here has been deployed by default. The token accounts named above are not used by this code.

## Next agents

| Agent | Role | Status |
|---|---|---|
| **05 Contract** | Smart contract logic, tests, example calls, deploy docs | **Done in-repo** (local tests). See `contracts/board/`. Testnet deploy is a human step via `contracts/board/DEPLOY.md`. |
| **06 Frontend** | Wire wallet + board UI to a configured contract | **Done in-repo** (mock/unit + build). Live testnet draw needs your `VITE_CONTRACT_ID`. See `web/README.md`. |
| **07 Research** | Chain-abstraction memo only | Ready anytime; no MVP code edits. |

Contract logic lives under `contracts/board/`. Frontend work is separate under `web/`.
