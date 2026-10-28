# Core pixel board: preservation and completion handoff

Date: 12 October 2026. This is the first document for any agent touching the board.

## Answer: what is done?

The basic pixel board exists in local code. Its rules are established; do not redesign them. It is not yet evidenced here as a deployed, reliable, end-to-end multiplayer game. Current implementation and future product requirements are different columns below. Reuse existing modules and tests before building extensions.

| Core property | Current local implementation | Remaining verification/work |
|---|---|---|
| One shared wall | 128×128, eight colors, sparse contract storage | Configure/verify actual testnet board and initial funding |
| Public viewing | No wallet needed for reads; mock if no contract configured | Independent browser reading real deployment |
| Open wall | Any caller may overwrite; latest writer credited | Two-user live overwrite and immediate-overwrite confirmation |
| Precise placement | Select cell/color then Place; keyboard controls | Desktop and 390px touch acceptance against live build |
| Zoom/pan | Fit, paint zoom, scroll/pinch, drag | Gesture/device checks; never paint during pan/pinch |
| Contract rules | Bounds/color validation; one cell per transaction | WASM/sandbox and testnet execution, worst-case storage/gas |
| Shared updates | Block-pinned full pagination; visible polling/backoff | Multi-client freshness and full-board load measurement |
| Transaction outcomes | Pending overlay, confirmation read, overwritten/delayed states | Real wallet rejection, delayed response, reload and overwrite rehearsal |
| Fast drawing session | Draw-only key, local signing and serialized queue implemented | Actual authorize→draw→reload→revoke journey; paid budgets are additional work |
| Stall presentation | CSS scene and existing canvas; newer artwork mockups separate | Integrate approved art without covering cells or breaking targeting |
| Core automated checks | Earlier review: 15 Rust + 12 shared + 78 frontend tests passed | Rerun when code changes; passing tests do not close the live gates |

Read current source over older status comments. Some older briefs predate zoom, automatic polling and local signing. They are not instructions to rebuild features that now exist.

## Established gameplay and current schema — preserve behaviour, parameterize size

1. One shared wall. Current schema is 128 columns × 128 rows = 16,384 cells, with valid coordinates 0–127. This is the implemented prototype, NOT a settled production-size requirement. `(0,0)` is top left; x increases right, y down. New clients/contracts use authoritative width/height; see the scale clarification below.
2. Palette indices 0–7 come from `shared/board.json` and must match TypeScript and Rust. Index 0 is real Ink. An unpainted cell is an absent record, not Ink or Paper.
3. No property right or exclusive plot ownership. Latest successful execution wins attribution, regardless of wallet transaction submission order. A bounty cannot reserve territory.
4. Same artist may recolor. Current schema also accepts same-artist/same-color writes and updates timestamp; the paid extension deliberately rejects those no-ops without charging.
5. One deliberate action paints one complete square. No partial-cell rendering or transparency on the paint surface. Templates/selection/pending states are separate overlays.
6. Free schema has no game charge, cooldown, account quota, paint limit or expiry. Network gas still applies. Do not invent Reddit's cooldown as an existing requirement.
7. No automatic seasons/resets, reward accrual, claims of tenure or anti-bot fairness. Latest write time is not continuous tenure start.
8. Board contract enforces rules even when called outside the website. Browser checks help the user but cannot secure the game.
9. Current board state survives page reload because it lives in the contract. The current picture is not a complete historical archive.

Any deliberate change to these rules is documented in the relevant extension spec and requires a compatible schema/client transition. Keep the existing 128×128 deployment readable as a legacy fixture; production board size is a separate scale decision. Palette changes still need explicit versioning. Do not silently ship proposed saturated palette colors over old stored indices.

## Current contract API and data

Source: `contracts/board/src/lib.rs`. Schema 2.

| Method | Input | Result/behavior |
|---|---|---|
| `new` | No arguments | Initialize empty board exactly once; never use as migration |
| `get_board` | No arguments | Schema, size, origin, palette, Open wall, sponsorship false |
| `get_pixel` | x, y | Color/artist/latest-write time, or null fields if unpainted |
| `get_pixels` | from_index, limit | Painted entries only; total and next_from_index; max page size 256 |
| `draw` | x, y, color | Zero-deposit signed call; validates then stores predecessor account and chain timestamp; emits draw event |

Pages describe latest state, not all past writes. Overwrites replace an entry; no duplicate cell in a full snapshot. Use positive page limit (currently frontend 256); a zero-limit contract read can return a non-progressing cursor and must not be used. Detect stalled/incomplete pagination rather than presenting it as complete state.

UI `colorIndex` maps to wire `color`, `artistAccountId` to `artist`, `lastWriteTimestampNs` to `written_at_ns`. Current Rust views serialize plain u64 timestamps as JSON numbers. Ordinary JavaScript JSON parsing can lose nanosecond precision before converting to a string. The new schema must emit decimal strings; baseline acquisition must preserve exact numeric tokens through a lossless reader when importing legacy state. Do not use rounded browser timestamps to certify history or eligibility.

In a failed contract execution, no pixel mutation persists. Successful draw does not imply the artist still controls the cell by the time the browser reads it; another successful write may already have replaced it.

## Rendering and interaction contract

- Reuse `render-board.ts`, `viewport.ts` and `selection.ts`. Canvas remains the editable plane; scene decoration never intercepts its targets.
- Fit wall shows all cells. Paint zoom targets about 20 screen pixels per cell (existing comfortable range 16–24). Hit testing and rendering use the same camera transform.
- Tap selects; Place commits intent. Direct paint is an explicit opt-in mode with a verified session. Pan/pinch never commit paint.
- Selection ring sits outside cell interior; chosen color and coordinates have textual labels. Keyboard arrows move selection, Enter requests painting only when allowed.
- Pending paint is visually distinct from confirmed art. A template may show intended pixels but never masquerades as chain state.
- Preserve keyboard focus, readable status, reduced motion and mobile touch targets. Test corners, centre, non-square viewport, scroll, pinch, resize and high zoom.

## Read/sync and transaction lifecycle

Read existing modules: `contract.ts`, `load-board.ts`, `board-sync.ts`, `board-cache.ts`, `pending-paint.ts`, `submit-draw.ts`, `tx-outcome.ts`.

1. Validate configured network/contract metadata. Missing contract permits mock browsing but blocks signing; clearly label mock state.
2. Load all pages against one block. Apply snapshots only when they do not overwrite newer observed data. Selected-cell updates carry observed block height too.
3. Current polling uses approximately four-second delay after a load, backs off to 30 seconds after failures and pauses hidden tabs. This is not a four-second end-to-end latency guarantee. Full board requires 64 page reads, plus supporting requests.
4. Capture immutable coordinates/color/account/network when the user requests paint. Account/network switches must stop unsent queue work.
5. Separate request, wallet prompt, broadcast/transaction identity, observed execution and fresh state read. A hash alone never establishes success.
6. Recognized successful execution + matching fresh state can show painted. Successful execution + another artist can show overwritten. Uncertain broadcast or delayed read stays unresolved; never automatically resend it.
7. A rejected prompt is distinct from a failed transaction. Unknown outcomes must remain inspectable/recoverable through receipt lookup rather than being presented as guaranteed failures.
8. Serialized queue means one action in flight. Cancel affects only unsent actions. Do not promise immediate brush throughput.

Current live reads use optimistic finality. [History spec](history-and-prints.md) adds finalized evidence for prints and bounties; do not treat an optimistic preview as mintable history.

## Wallet, network and resource boundaries

Configure `VITE_CONTRACT_ID`, `VITE_NEAR_NETWORK`, optional RPC URL using `web/.env.example`; token account is not board account. Wallet connector supports testnet/mainnet; localnet reading is separate from wallet-supported signing. No gas sponsorship exists.

Current experimental key is draw-only with a 0.05 NEAR lifetime gas allowance and browser-local secret storage. This is not a maximum paint balance spend. Verify restricted method scope, local-sign fallback, account isolation, reload and actual DeleteKey revocation. Forgetting the browser session does not revoke the key on-chain.

Before a public free-board rehearsal, measure and fund storage for worst-case occupancy and long account IDs; the free contract has no storage billing or pause. Before paid activation, [pressure spec](pressure-and-paint.md) adds storage policy, atomic ledger debit, on-chain paint budgets and a distinct ordinary-wallet entrypoint. A free draw path cannot remain callable as a paid-board bypass.

## Core acceptance checklist for the assigned agents

| Check | Required evidence |
|---|---|
| Existing tests/build | Shared tests, web tests/build, Rust tests; preserve baseline behavior unless explicitly versioned |
| Deployment identity | Network, board account, code hash, schema, palette, initialized state and storage funding |
| Two-user sharing | Alice paints; independent Bob sees it; Bob overwrites; Alice sees attribution change |
| Precision | Same intended cell at all corners/centre after zoom, pan, resize and 390px touch |
| Failure | Wrong network/contract, invalid input, wallet rejection, failed execution, slow RPC, uncertain broadcast, immediate overwrite |
| Reload/navigation | No duplicate submit, correct refreshed chain picture, outstanding operation recoverable |
| Session | Authorize once, multiple real paints, reload, account switch, exhausted allowance, on-chain revoke |
| Scale | Full 16,384-cell fixture/load; measure pages, time, memory, RPC failures and eventual convergence |
| Honest presentation | Fixture/mock labelled; no claimed sponsorship, payment/reward, history or live completion without evidence |

The additional release gates are verification work, not an invitation to reinvent the core game. Log defects and fix only the relevant module. Code comments or prior “done” labels do not replace this evidence.

## Extension map: build on the core

| New capability | Extends | Must preserve |
|---|---|---|
| Pressure/paint | Contract draw validation, quote UI, balance/session adapter | Open wall, exact targeting, bounded spending, no automatic resubmit |
| Art Bounties | New routes and escrow; wall deep links/templates | Anyone can paint; no territory lock or guaranteed payout per pixel |
| History/prints | Versioned events, baseline, indexer/registry/new pages | Current wall continues evolving; snapshots immutable and evidence-qualified |
| Route shell | Existing main.ts lifecycle | Wallet recovery, timers disposed, same canvas behavior |

Agent handoff: read this file, your assigned domain spec, and [delivery ownership](delivery-plan.md). Board owner B and frontend owner F complete/reuse the core. History/escrow/print agents consume its interfaces; they do not independently reimplement the board. Report implemented vs verified vs missing separately.

## Scale clarification following user review

The user challenged the inherited 128×128 assumption by comparison with Sui Pixel and r/place. Do not freeze prototype size as product scope. Proposed engineering target: support a 1,024×1,024 wall (1,048,576 cells); exact public launch size and staged expansion remain unconfirmed. Retain 128×128 as a fast test fixture. This is a capacity target, not a throughput or deployment claim.

Required architecture work before a larger live release:

- Remove hardcoded 128 from shared bounds, camera/hit testing, contract key encoding, pricing regions, snapshot encoding and crop validation. Read authoritative metadata. Validate dimensions against declared limits.
- Use spatial chunks for initial rendering/viewport loads and incremental confirmed updates. Keep periodic full checkpoints for history; do not reload every painted cell on each browser poll. At 1,000×1,000 with the existing page size, a full occupied board would need 3,907 page reads per refresh.
- Separate canvas capacity, simultaneous viewers and successful placements/second in measurements. A large canvas alone proves none of the latter. Select numeric concurrency/throughput targets from expected launch attendance before performance sign-off.
- Benchmark state storage, bytes per pixel, full occupancy, archival growth, quote costs and burst painting on NEAR. Browser rendering one million cells is not equivalent to storing one million attributed records on-chain.
- Region count derives from dimensions and region size. Configuration/migration must be paginated or lazy-versioned rather than looping over every region in one transaction.
- For any enlargement, old key `y * old_width + x` must be explicitly migrated or preserved behind a stable coordinate key. Changing WIDTH in place corrupts interpretation. Preserve historical dimensions/palette per board epoch.
- Bounties and prints use global coordinates and immutable board-epoch dimensions; resize cannot reinterpret previously funded regions or minted snapshots.

Source comparison: [Sui guide](https://suipiens.com/blog/a-complete-players-guide-to-sui-pixel/) describes 1,000×1,000; [Reddit engineering](https://www.reddit.com/r/RedditEng/comments/vhh962) describes 1,000×1,000 and expanded 2,000×2,000. Neither establishes Meta Poo's on-chain capacity.
