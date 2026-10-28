# 2026-10-28 — TOILET immutability (D4)

## Learned

A transfer-call resolver's result describes receiver consumption of the net
delivered amount. Protocol-retained tax belongs in a separate event, not added
to that return value. Keeping tax in the callback payload preserves observability
without changing refund, rounding or supply accounting.

Emitter-only controls need a callable path from the emitter contract. The paid
board now forwards its owner's pause request to the specified token with exactly
1 yoctoNEAR and 10 Tgas, returning the promise for receipt inspection. It adds no
state and remains callable while the board is paused. Emission and emitter handoff
passthroughs are still outside this task; this change does not implement rewards.

The token has no owner, tax setter or replacement administrative account. The
entire validated tax configuration is stored unchanged at initialization. Removing
the owner changes its Borsh layout: fresh initialization only, no migration.

The task brief said "do not add an upgrade entrypoint to either contract". The run
removed the board's existing `upgrade()` to satisfy that reading; review reverted it.
The sentence meant *add*: the board custodies credits and pixels and must stay
repairable, while the token's frozen config leaves nothing worth a code-swap power.
Lesson for the next brief: say "keep X" or "remove X", never "do not add X" when X
already exists.

## Evidence

Baseline at `77672e3` on `codex/toilet-d4-immutable`:
`cargo test --locked` passed 18 token tests and 63 board tests.

Before changing resolver implementation, `cargo test --locked resolver_full_`
exited 101 with **0 passed, 2 failed**:

- `tests::resolver_full_rejection_returns_zero`: actual 30, expected 0.
- `tests::resolver_full_consumption_returns_net_delivered`: actual 1000, expected 970.

Both regressions pass after the fix and assert the resolver event fields.
Other coverage checks emitter handoff revokes prior authority, initializer and
third-party rejection, exact deposits, configured tax equality, recipient
registration, net refunds and the board receipt's target/payload/deposit/gas.
The callback payload test also checks that tax remains present.

Required verification, run separately in each contract directory with the
specified stable toolchain PATH and DYLD_LIBRARY_PATH:

| Command | contracts/toilet | contracts/paid-board |
|---|---|---|
| `cargo test --locked` | 22 passed, 0 failed | 64 passed, 0 failed |
| `cargo build --locked --release --target wasm32-unknown-unknown` | passed | passed |
| `cargo clippy --locked --all-targets -- -D warnings` | blocked: no such command `clippy` | blocked: no such command `clippy` |

The board count is 63 minus the obsolete upgrade test plus two passthrough tests.
The token count is 18 plus four new tests; existing authority/config/refund tests
were adapted to the immutable interface. Both crates have zero doc tests.

The installed Rust 1.99.0 toolchain lacks Clippy and rustfmt. Fetching the matching
components into `/private/tmp` failed with `Could not resolve host:
static.rust-lang.org`; no toolchain files were changed. Formatting was reviewed
manually and `git diff --check` passed. Clippy cleanliness is **unverified**.
AGENT.md's web checks were attempted: `npm test` failed because `vitest` was missing;
`npm run build` failed because `tsc` was missing. Dependencies were not installed
because frontend writes are outside the authorized scope.

## Boundaries and next proof

Still no chain execution and no pool test. Mocked receipts do not establish live
settlement, gas sufficiency or AMM compatibility. No deployment, accounts, funds,
push or PR. Taxed AMM/sandbox testing remains a prerequisite before launch.
Mint remains emitter-only with recipient registration required; payout process,
staking and reward issuance remain out of scope. No migration was added because
this token is undeployed and the task explicitly requires fresh initialization.

Shared decisions, work queue, backlog, traps and other documentation were left
untouched under the user's path allowlist. Older upgrade references outside the
two contract READMEs therefore remain historical claims requiring separate work.

The requested commit was attempted on `codex/toilet-d4-immutable` but both staging
and commit failed: Git could not create
`/Users/clawdio/Projects/metapoo/.git/worktrees/metapoo-d4/index.lock`
(`Operation not permitted`). The worktree metadata is outside this session's
writable roots; approval requests are disabled. Changes remain uncommitted.
The prepared commit message listed owner/tax-setter removal, emitter authority,
net resolver return/event, board pause forwarding, upgrade removal, documentation,
and both failing regression names recorded above.
