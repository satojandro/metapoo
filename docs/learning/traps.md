# Traps — things that have already cost this project time

Read this before changing code. Each entry is a mistake that happened, not a hypothetical.
Add to it when something bites you.

---

## Wallet session

**In-memory wallet identity dies on every full page load.** near-connect persists
`selected-wallet`, but the page only used to update `session` on `wallet:signIn` /
explicit `connect()`. Meteor (and other redirect wallets) reload after sign-in or a
tx, so the UI looked logged out even though the connector still knew the wallet.
Boot must call `restoreWalletSession()` → `getConnectedWallet()` and emit. Do not
"fix" this by changing key scope or allowance — restore-only is enough. See
`web/src/wallet.ts` and issue #25.

**Credits dock does not move unless you refresh it after spend.** Chain debit and
UI balance are different paths. After a confirmed (or delayed) paint/stroke, call
`refreshCreditsDock()`; wallet subscribe alone is not enough. See issue #29.

**Buy-credits "price unavailable" is often a self-inflicted RPC storm, not a bad
contract.** `quoteRepaint` used to call `get_tunables` + per-cell `get_cell_cost`
+ per-cell `get_pixel` (≈129 RPCs for a 64-cell stroke) on the same endpoint as
`get_payment_config`. A Retry button re-enters the storm. Cache tunables for the
session, read `written_at_ns` from the wall pixel cache, and de-duplicate cells.
A `quote_stroke` contract view is a separate ask-first follow-up. See issue #26.

**An indexed API's filter can mean the opposite of what its name suggests.**
`is_event_log` on FastNEAR's `/v0/account` means "this account is *named in* an event's data",
not "this account emitted an event". Measured 2026-11-05: board3 emitted 17 `EVENT_JSON` logs in
38 transactions and 3 rows were flagged; board5 emitted 23 and none were flagged. `near_distributed`
names `team_account` and `buyback_account`, never the board — so filtering the board by that flag
returns **every** split missing and reports `0 NEAR, complete: true`. Before trusting an index
filter, count the rows it returns against the rows you can prove exist: list everything, fetch the
transactions, and compare. Ask the index about the account the money moved to, not the one that
logged the event. And a scan that can be read mid-flight must not be cached: FastNEAR items carry
each receipt's own outcome, so a transaction is only final when every `receipt_id` it references is
present.

## Environment

**`cargo` is not on `PATH`.** It lives at
`~/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo`. Export it before any contract
build, and `DYLD_LIBRARY_PATH` to the same toolchain's `lib`.

**The JS `near-cli` was removed; `near` is now `near-cli-rs` 0.30.1.** Old `near view`
forms no longer work. Read state with:

```bash
near contract call-function as-read-only wall.berrywall1.testnet get_pixels \
  json-args '{"from_index":0,"limit":256}' network-config testnet now
```

Page with the returned `next_from_index` until it is null.

**`cargo-near` build flags make local wasm hashes differ from the deployed wasm.** Local
`E6V6Y5…` vs deployed `34LjyfE…` is expected, not evidence of drift. The ABI probe
matching is the real check. **Never redeploy to "fix" a hash mismatch** — an earlier
redeploy over live state bricked a board.

---

## Verification

## Tooling credentials

**The Codex CLI dies every time Hermes refreshes, and it is not a login problem.** The CLI
(`~/.codex/auth.json`) and Hermes's `openai-codex` provider each hold a copy of the **same**
ChatGPT OAuth chain. Refresh tokens rotate: when Hermes refreshes, the server invalidates every
other copy, and the CLI then fails with:

```
ERROR: Failed to refresh token: your refresh token was already used.
ERROR: workspace routing discovery unauthorized (401)
```

Symptom in the orchestrator: `blocked — budget_exhausted:max_retries` after four implement
attempts with **`changed_files: []`**. It looks like an agent failure and is not one.

Do not re-login. Do not "fix" the model or the workspace — the account is already the plus
workspace (`chatgpt_plan_type: plus`, `alejandro@uxisnear.com`) and always has been. Seed the CLI
from Hermes's copy:

```bash
~/.hermes/profiles/crypto-builder/bin/sync-codex-auth.sh --check   # exit 1 = stale
~/.hermes/profiles/crypto-builder/bin/sync-codex-auth.sh           # seed it
codex exec -m gpt-6.1-sol --skip-git-repo-check "PONG"             # prove it
```

**Always launch batches through `run-ao-batch.sh`**, which syncs the credential, pulls the
orchestrator, resets the batch worktree to `origin/main`, links `web/node_modules` and wraps the
run in `caffeinate -is`. Launching `run_batch.py` directly is how a stale credential becomes a
wasted batch.

Do not create a second `CODEX_HOME` copy of the credential either: two copies of one rotating
refresh token fight each other, which is the bug, not the workaround.

**`vitest` does not typecheck; `npm run build` does.** Both are required. Twice on
2026-10-27 a change was green in vitest and red in `tsc` because a test fixture predated a
new required field. If you only run tests, you ship a broken build.

**A backlog or status document is a claim, not evidence.** On 2026-10-27 six backlog items
were recorded as undelivered when commits in the same document's own ancestry had already
shipped them (`6080412` a11y controls, `db4d50a` mobile ergonomics, `ff08ccf` scenery,
`2615cef` first-visit hint, `b8a0861` zoom readout). Acting on them would have rebuilt
working code. Before believing a status, run
`git log --oneline -- <paths>` and grep for the artefact itself. `docs/backlog.md` is agent-
maintained precisely so it stays true: update it in the same PR, and never carry a status
forward without re-deriving it.

**A passing suite is not evidence that the feature works.** On 2026-10-27 the wall carried
248 green tests over 39 files, a clean build and 13 "delivered" backlog items while
drag-to-paint had **never completed a single transaction**. Unit tests verified the wrong
layer. For anything touching paint, the chain is the oracle (below).

**Chain is the oracle, and the allowance is the lie detector.** To tell "the transaction
was sent" from "nothing ever left the browser", read the function-call key's remaining
`allowance` and `nonce` before and after. An executed transaction spends gas and advances
the nonce; a payload that died in the browser leaves both untouched:

```bash
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":"p","method":"query","params":{
    "request_type":"view_access_key","finality":"final",
    "account_id":"<account>","public_key":"<session key>"}}'
```

**Undisposed mounts poison later tests.** A test that throws before `dispose()` leaves a
mounted wall with live timers; the next tests see extra poll calls and fail in ways that
have nothing to do with them. If polling tests fail only when a different test fails
first, this is why.

---

## Browser

**Browsers have no `Buffer`, `global`, or `process`.** `@near-js/transactions` builds a
function-call action with `Buffer.from(...)`, so **any in-page signing path throws
`ReferenceError: Buffer is not defined`** unless a polyfill is installed. `web/src/polyfills.ts`
does that and is imported first in `web/src/main.ts`. Do not remove it. This exact bug cost
a full debugging session on 2026-10-27 and had been reported once before, on 2026-10-21,
without being traced.

**`display:flex` beats the `[hidden]` attribute.** A rule that sets `display` on an element
you also toggle with `hidden` will keep it visible. Restate the hidden case
(`.paint-unlock[hidden] { display:none; }`) or use a class instead.

**`style.css` styles every `<canvas>` on the site as the live wall.** The bare `canvas { … }` rule
gives any canvas `background: var(--wall-empty)` and `pointer-events: none`. A second canvas (the
`/timelapse` stage) had its transparent pixels filled with the wall's empty colour, and nothing in
its own stylesheet said why. Seen only in a screenshot; no unit test can catch it. Scope a new
canvas's rules above that one (`.tl-stage .tl-canvas`) and reset what you do not want.

**A cache key that can repeat is not a cache key.** `/api/history` pages are served `immutable`
under an epoch in the URL. The first version made the epoch a counter starting at 0, so a wiped and
rebuilt mirror would have reused epoch 0 for different bytes, in every browser cache and in the
server's own page cache (a test that flushed Valkey between cases found it). It is now the
wall-clock ms at which that copy of the log was first read or last rewritten.

**Vite externalises bare `util`/`process` imports instead of failing the build.** They only
break at runtime. Treat that build warning as a real defect, not noise.

---

## Painting model

**Do not put fixture quotes back on the wall.** Schema 3 pressure quotes were a prototype.
Nothing deployed reports that schema, and the quote numbers were fixtures. Rendering them
next to a credit board showed a made-up price on a money screen. The modules are gone
(`paid-mode`, `paid-paint`, `pressure-quote`, `features/pressure`). Schema 4 prices are
read from `get_cell_cost` and `get_tunables` (`web/src/pages/wall/repaint-price.ts`). If either
view fails, show `price unavailable` and disable submit. Never fall back to 1 credit, and do
not re-implement the 1 / 2 / 4 tiers in TypeScript. `contract-meta.ts` still rejects schema 3 by name.

**A stroke needs an armed session; a tap is a different path.** `commitStroke` submits
`draw_many` chunks through `signAndSendStrokeLocally`; a single tap goes through
`maybeEnqueueDirectPaint` and the queue. Two concurrent submissions on one access key risk a
nonce collision, so the queue serialises and the stroke gate refuses while the wire is busy.
Never "fix" a blocked stroke by removing those in-flight guards — enqueue instead.

**A batch boundary is a transaction boundary.** A 256-cell stroke is four transactions.
Never retry a chunk whose broadcast is unresolved; a double-paint is worse than a gap.

**30 Tgas already covers a full 64-cell `draw_many`** — proven by seeding 1,368 cells.

**`paint zoom` is a convenience, not a mode.** It used to be a precondition for
drag-to-paint, which made drag silently pan for anyone who had not found the button.

---

**A held tile is not an earning tile.** Free paint (free first paints, happy hour) holds a tile but
earns no TOILET until someone repaints it with credits. Never show tiles × rate as earnings: use
`get_earning_cells(account_id)` for a holder, and count only the credit-paid entries of a stroke.
(PR #87 shipped tiles × rate in its first commit and corrected it in the second.)

**Punctuation added for screen readers goes in a visually hidden span.** A comma typed into the
visible text to separate parts for assistive tech shows on screen (", just now"). Use
`.visually-hidden` for the separator, or an `aria-label` on an element that takes one (a button).

---

## Board reads

**A poll's cost is per open tab, and it grows with the board.** Before `get_board_version`, every
4 s poll walked the whole painted set: `1 + ceil(painted / 256)` requests, 65 on a full 128 × 128,
in every visible tab. Measure the cost of one poll at the board's *full* size before you call a
polling interval cheap. Now an unchanged board costs one `get_board_version` call, and a tab with no
input for 10 minutes stops polling (`BOARD_IDLE_PAUSE_MS`). Do not add a background read to the wall
without asking what it costs per tab per hour.

**A version and the pixels it describes must come from the same block.** `fetchAllPaintedPixels`
pins the `get_pixels` walk to the `block_height` the version was read at. A version read at one block
and pixels from a later one would record the new pixels under the old version, and the next poll
would then skip one real change.

**A server that reads every block pays per block, not per paint.** The first board-server deploy
(`183efa9`) ported Berry Fast's indexer, which reads every final block from NEAR Data. On mainnet
that is ~6,200 requests an hour (600 ms blocks), forever. The owner's FastNEAR dashboard showed
~6,000 an hour on a board idle for nine hours, where the old browser polling cost zero with no tab
open. Spec §6 described the per-tab saving and never multiplied the server's own rate out.

Before a server is deployed, write down its cost in three cases: nobody watching, someone watching
an idle board, and per paint. The indexer now reads FastNEAR's per-account transaction index, and
only while a WebSocket is open or right after a paint hint (`ops/board-server/README.md`, "What it
costs"). That is 0 with nobody watching, 240/hour while watched, and 20 requests for the board's
whole history.

**"Last applied event" is not a freshness watermark.** The wall trusted the server only while
`last_applied_block` was within 60 blocks of the chain. That field was the block of the last
*paint*, so ~36 s into any quiet spell every browser judged the server stale and went back to
chain polling. Report how far the mirror has been *checked*: with nothing queued, that is the
indexer's watermark.

---

## Contract state

**Check the live state before you claim a raw storage key.** A raw key (`s`, `board_version`) lives
in the same trie as every collection's `prefix + key` entries, and boards deployed from older code can
hold prefixes this code no longer declares: board5 holds keys under `v…` that nothing in
`contracts/paid-board` writes. List them first (`view_state` with `prefix_base64`), then pick a name
that cannot collide. The board version is `board_version`, not `v`, for that reason.

**`upgrade()` cannot deliver a code-only change to a version-2 board.** It deploys and then calls
`migrate` in one batch, and `migrate` rejects a state that is already version 2
(`UnsupportedStateVersion`), so the batch fails. A change that adds methods or raw keys but leaves
`Board` alone (`get_cell_costs`, `get_board_version`) is deployed directly with the board account's
own full-access key, with no `migrate` call. Record the code hash before and after.

**Capture old state with the old code before you change the struct.** Once `Board` changes, the
code that wrote the old layout is gone, and a test that builds "old state" with the new types
only proves the new code agrees with itself. REV-A dumped the mocked trie from the v1 code
(`contracts/paid-board/fixtures/state_v1.json`, generator in commit `7cb1558`) and the migration
test loads those bytes. Do the same for every later layout change.

**The paid board tells layouts apart by the first u32 of `STATE`.** v1 starts with
`schema_version = 4`; v2+ start with `state_version`. Never assign `state_version = 4`, and keep
`state_version` the first field of `Board`. See `contracts/paid-board/src/migrate.rs`.

**`#[payable]` cannot go on a `&self` method** in near-sdk 5 ("View function can't be
payable"). Owner calls that only schedule a promise still take `&mut self`.

**Counting inflow from your own token balance races every other balance movement.** A
`ft_balance_of` read and its callback are separate receipts: a payout confirmed in between looks
like inflow, a newer sync's inflow looks like a loss, and an `ft_transfer_call` that will be refunded
looks like inflow and then leaves. Carry movement counters with the read and only act outside the
range they allow (`contracts/toilet-staking`, `on_mpoo_balance`). Never add a notified amount *and*
count the balance: a sync that saw it first counts it twice.

**The NEAR sandbox wants 65,535 open files.** near-workspaces' neard raises `RLIMIT_NOFILE` to 65,535
and dies with "couldn't set the file descriptor limit" where the hard limit is lower (some
containers). GitHub's hosted runners allow it. Locally, either raise the hard limit or run with an
`LD_PRELOAD` shim that clamps the request; say so when you report the run.

---

## Repository

**`~/Hermes-crypto-builder/mpoo` and `mpoov2` are stale copies** pointing at superseded
contract ids. The real checkout is `~/Projects/metapoo`. Confirm with
`git remote -v` and the contract id in `web/.env` before believing any state.

**`vercel pull` in a fresh worktree wipes the project settings and Vercel then guesses
Next.js.** It reports `No Next.js version detected` even though `vercel build` worked in
another worktree minutes earlier. `web/.vercel/project.json` must carry
`settings.framework: null`; copying that file (and `.vercel/.env.production.local`) from a
worktree that already built is the fast fix. `vercel link` alone is not enough — the
settings arrive with `pull`.

**`web/.env` is gitignored**, so a fresh clone or a new machine silently runs in mock mode
with no chain at all. If the board is empty and draw does nothing, check it first.

**A local `main` ref can lag `origin/main` by several merges** and nothing warns you. Fetch
before branching, and verify with `git ls-remote origin refs/heads/main` rather than
trusting a local ref.

**Read `docs/learning/` and the research it cites before designing anything.** On 7 Nov a board
server was designed from scratch, and costed wrong, when the 5 Nov polling record had already named
Berry Fast as the model and cited its source commit. Port a working reference; don't reinvent it.
Before stating what the repo already does, read the record of it: "we already fetch only changed rows"
was wrong (R2.2 is one board-wide counter).

**Never route coding through an aggregator/router lane.** One auto-routing lane burned
~17.9M tokens in 76 minutes with `cost_status: unknown`. Pin the model explicitly.

---

## Sending a transaction

**`near-api-js` signs against `finality: "optimistic"`.** `Account.signTransaction` takes the
transaction's `block_hash` from `viewBlock({finality: "optimistic"})`, and a broadcast node that
has not stored that block answers `UNKNOWN_BLOCK: DB Not Found Error: BLOCK_HEIGHT: <tip>`. The
failure lands **after** the signature exists, so the UI can only report "possibly broadcast" and
must not retry. Sign against a finalized block instead — `web/src/final-block-provider.ts`. The
same rule applies to any read pinned to a block height: an optimistic height can be a block the
node does not have, and the whole load dies.

**A rate limit on the send path is reported as a contract-adjacent error.** The same tester session
saw `-429 ... get a subscription at https://faslnear.com/` and `UNKNOWN_BLOCK` from two different
causes: the first was a build missing `VITE_NEAR_RPC_API_KEY` (anonymous pool), the second was the
optimistic block. Check the credential before believing a chain explanation.

**A bigger `draw_many` batch is limited by the event log, not by gas.** `paint` emits one event
entry per cell, each repeating the painter's account id. Multiplied out, with a **64-character
implicit account** as the painter: 64 cells = 10,441 B, 100 cells = 16,273 B, 128 cells = 20,837 B,
256 cells = 41,591 B, against NEAR's **16 KB per-receipt log limit**. So `MAX_DRAW_BATCH = 64` is a
log budget, and the real ceiling with the current format is **~100 cells**. Raising it needs the
per-cell `artist` dropped from the event (or one summary event per call) first — not more gas.
Gas is not the constraint: 64 cells already runs inside `DRAW_GAS`.

**A drawing key's refusal has not been reconciled with its gas.** On 2026-11-06 the chain refused a
drawing key with 0.0308 NEAR of allowance left, quoting a cost of 0.0309 NEAR. Every path in this repo
attaches 30 Tgas (`DRAW_GAS`), and live `draw_many` transactions do too, yet at the 1e8 gas price
0.0309 NEAR prices about 309 Tgas. So either the gas price at the refusal was about 10x base, or that
transaction attached about 300 Tgas through a path nobody has found, or something else is going on.
An invalid transaction never lands, so no hash can settle it: the console line `[wall] drawing key
refused:` records the gas attached, the gas price, and the chain's quoted cost as a multiple of what
that gas should cost at that price (`quotedOverExpected`). About 1 means the gas limit is not the
explanation and the next suspect is the allowance arithmetic; about 10 means the chain priced ten
times the attached gas. Until one is captured, do not use this event to size the allowance. Add up a
fee from every receipt: the transaction outcome alone reads about 10x low (0.000032 NEAR for a paint
that burned 0.00068 in total). Either way, act on the chain's refusal: the reserve in
`signAndSendStrokeLocally` did not predict it.
