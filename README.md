# Meta Poo Agent-Ready Pack

This pack gives a small team a shared product brief, technical boundaries, staged plan, parallel Cursor workflow, focused agent assignments, and learning record. The first milestone is a working, free pixel-graffiti board on NEAR with wallet connection and transparent transaction status.

The project starts in a newly created clean repository; it is not a Berry Club fork. Berry Club is inspiration for the product concept only. The kickoff prompt instructs Cursor to scaffold from scratch if the repository is empty and to inspect any starter files before building on them.

## Read in this order

1. 01 Product requirements
2. 02 MVP scope and roadmap
3. 03 Architecture and contracts
4. 04 Cursor orchestration
5. 05 Contract agent brief
6. 06 Frontend agent brief
7. 07 Chain abstraction research brief
8. 08 Acceptance security and QA
9. 09 Learning journal
10. 10 Cursor kickoff prompt

## Evidence labels

- Supplied context: facts or directions provided in the referenced conversation or this request. They have not been independently checked against chain state.
- Design assumption: a provisional product or engineering choice to make the MVP implementable.
- Open question: a choice or fact that must be resolved before the affected phase.
- Verified research: a technical statement checked against linked primary documentation on 11 October 2026. This does not verify any project-specific contract or deployment.

## Important boundary

Pixel takeover and any time-based reward are unresolved product decisions. The pack proposes a no-payout MVP and asks the team to choose who may overwrite a pixel before implementation.

The conversation supplies MPOO contract account mpoo.nearlytrade.near, deployer account meta-poo-shitcoin.near, NEAR mainnet as the intended network, and a reported 2% buy / 3% sell tax. Treat these as unverified inputs. Do not claim the token contract, tax behavior, ownership, or mainnet deployment has been independently verified. Token transfers are outside the MVP.

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
- `web` — Vite page: read-only board without a wallet, connect/disconnect on testnet, palette + keyboard selection, `draw` via wallet when `VITE_CONTRACT_ID` is set, success only after tx id + `get_pixel`

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
