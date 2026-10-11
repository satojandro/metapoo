# Learning session: foundation scaffold

- Date: 11 October 2026
- Learner: foundation pass (agent), for the maintainer to reread
- Agent or task: Stage 0, shared decisions and holding board
- Goal in one sentence: Show a free pixel wall and stop draws until overwrite rules are chosen.
- Environment: local empty board picture; wallet connector aimed at testnet for identity only; local Node and `cargo test`
- Files or contract methods explored: pack `01` through `09`; `shared/`; `web/`; holding methods `get_board`, `get_pixel`, `draw` in `contracts/board`

## Before starting

- What do I think should happen? A first version might paint pixels. The pack says to stop if the overwrite rule is not chosen.
- What terms or steps are unfamiliar? A NEAR "view" is a free read. A "call" is a signed change. Gas is the network fee. Storage staking is NEAR locked for the bytes a contract stores.
- What is the smallest experiment that can answer one question? Can the page explain a blocked draw without pretending a transaction exists?

## What I did

1. Read the pack. Confirmed there was no package, contract, or wallet code at the start.
2. Wrote the overwrite options in `docs/00-shared-decisions.md` and left the choice open.
3. Merged two partial scaffolds into one holding build: Ink palette, `overwrite_rule: "unresolved"`, `shared/`, `web/`, `contracts/board`.
4. Wired the page draw button through `prepareDraw`, which never opens a signing prompt for paint.

## What I observed

- Expected result: valid pixels are still rejected with the unresolved-rule block.
- Actual result: shared tests, web tests/build, and `cargo test` in `contracts/board` (see handoff after cleanup).
- What this evidence proves: the local checks agree, and the TypeScript builds.
- What it does not prove: no testnet draw transaction, no mainnet read, no measured storage cost, no WASM deploy.

## What I learned

- New term and plain-language definition: WebAssembly is the form NEAR uses to run a contract. Rust is a common way to produce that form. The page is a separate program that asks the contract to do the work.
- One idea I can explain to someone else: the browser checks are for clear errors. The contract is the bouncer. Both have to know the same rule.
- One thing I would check next time: that a "success" message is impossible unless a transaction id came back.

## Problems and decisions

- Error or confusing behavior: two scaffolds disagreed on palette names and on `undecided` vs `unresolved`.
- Likely cause: parallel drafts before a single source of truth was locked.
- How I narrowed it down: compared `shared/board.json`, `shared/palette.ts`, `web/`, and `contracts/board`.
- Decision made and why: one Ink palette, one `unresolved` marker, holding contract that rejects every draw, page that explains the block.
- Decision made later the same day: **Open wall** accepted. Contract stores sparse pixels; page still blocks send until a contract id is set.

## Next small practice

- Exercise: pick one overwrite sentence and say what a second paint by a different account should do.
- Expected result: either "the color changes and the artist changes" or "the contract rejects the second paint."
- How I will know it worked: the sentence matches a future contract test name, and the rules panel uses the same sentence.
