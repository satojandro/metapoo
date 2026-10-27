# Traps — things that have already cost this project time

Read this before changing code. Each entry is a mistake that happened, not a hypothetical.
Add to it when something bites you.

---

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

**Vite externalises bare `util`/`process` imports instead of failing the build.** They only
break at runtime. Treat that build warning as a real defect, not noise.

---

## Painting model

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

## Repository

**`~/Hermes-crypto-builder/mpoo` and `mpoov2` are stale copies** pointing at superseded
contract ids. The real checkout is `~/Projects/metapoo`. Confirm with
`git remote -v` and the contract id in `web/.env` before believing any state.

**`web/.env` is gitignored**, so a fresh clone or a new machine silently runs in mock mode
with no chain at all. If the board is empty and draw does nothing, check it first.

**A local `main` ref can lag `origin/main` by several merges** and nothing warns you. Fetch
before branching, and verify with `git ls-remote origin refs/heads/main` rather than
trusting a local ref.

**Never route coding through an aggregator/router lane.** One auto-routing lane burned
~17.9M tokens in 76 minutes with `cost_status: unknown`. Pin the model explicitly.
