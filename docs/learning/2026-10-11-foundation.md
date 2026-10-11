# Learning session: foundation scaffold

- Date: 11 October 2026
- Learner: foundation pass (agent), for the maintainer to reread
- Agent or task: Stage 0, shared decisions and mock board
- Goal in one sentence: Show a free pixel wall and stop draws until overwrite rules are chosen.
- Environment: mock for the page, local for the tests and the production build
- Files or contract methods explored: the agent pack `01` through `09`; new `shared/` checks; no contract methods exist yet

## Before starting

- What do I think should happen? A first version might paint pixels. The pack says to stop if the overwrite rule is not chosen.
- What terms or steps are unfamiliar? A NEAR "view" is a free read. A "call" is a signed change. Gas is the network fee. Storage staking is NEAR locked for the bytes a contract stores.
- What is the smallest experiment that can answer one question? Can the page explain a blocked draw without pretending a transaction exists?

## What I did

1. Read the pack. Confirmed there was no package, contract, or wallet code.
2. Wrote the overwrite options in `docs/00-shared-decisions.md` and left the choice open.
3. Added shared checks, a mock page, and local tests. Did not add a Rust crate.

## What I observed

- Expected result: valid pixels are still rejected with `OWNERSHIP_RULE_UNRESOLVED`.
- Actual result: see the test run recorded in the handoff. The page shows that same sentence when Draw is pressed.
- Evidence: `node --test` on `shared/board-rules.test.ts`, `npm run build` in `frontend/`, and a browser pass on the local dev server.
- What this evidence proves: the mock page and the local checks agree, and the TypeScript builds.
- What it does not prove: no testnet transaction, no mainnet read, no live wallet, no measured storage cost.

## What I learned

- New term and plain-language definition: WebAssembly is the form NEAR uses to run a contract. Rust is a common way to produce that form. The page is a separate program that asks the contract to do the work.
- One idea I can explain to someone else: the browser checks are for clear errors. The contract is the bouncer. Both have to know the same rule.
- One thing I would check next time: that a "success" message is impossible unless a transaction id came back.

## Problems and decisions

- Error or confusing behavior: the milestone wants a drawing action, and the brief forbids inventing who may overwrite.
- Likely cause: those two instructions meet at the contract method.
- How I narrowed it down: the contract brief says to recommend and stop when the coordinator has not chosen.
- Decision made and why: ship a read-only mock with one draw button that explains the block. The action is visible, and it cannot lie about a transaction.
- Open question for the coordinator: which overwrite option should be accepted?

## Next small practice

- Exercise: pick one overwrite sentence and say what a second paint by a different account should do.
- Expected result: either "the color changes and the artist changes" or "the contract rejects the second paint."
- How I will know it worked: the sentence matches a future contract test name, and the rules panel uses the same sentence.
