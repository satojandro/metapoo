# Agent entry point

Read these before changing anything, in order:

1. **`docs/learning/traps.md`** — mistakes that have already cost this project time. Several
   are cases where the code looked correct and the behaviour was broken.
2. **`docs/README.md`** — the documentation map: for any topic, which document is
   authoritative and which are archived. Use it instead of trusting a filename's date.
3. **`docs/roadmap.md`** — open product decisions (R1–R5). Do not implement an R-item as if
   it were settled; each states what is decided and what is not.
4. **`docs/00-shared-decisions.md`** — decisions already recorded.
5. **`docs/learning/`** — session records; the newest one describes the current state of the
   paint path.

`docs/archive/` is history. Nothing in it is instruction — if you need it, say why in your PR.

Do not infer project state from the code alone, and do not infer it from a green test run.

# Keep `docs/backlog.md` current

You own that file. If your change alters a status in it, update it **in the same PR** — moving
the row, adding the commit that proves it, or marking it unverified with what is missing.

The failure it exists to prevent: on 2026-10-27 six rows said "not delivered" for work that had
already shipped in commits from the same document's ancestry. The problem was not that an agent
held the pen — it was that nobody re-derived the status. So:

**A status line is a claim until you check it.** Never copy a row forward. Run
`git log --oneline origin/main -- <paths>` and grep for the artefact itself before you write
"missing" or "done". Delivered rows keep their commit id so the next agent cannot re-dispatch
them.

# Web verification

Run web checks from `web/`: `npm test -- <test-name>`, `npm test`, and `npm run build`.
If dependencies have not been installed, run `npm install` as a separate command; do not append shell operators to it.

# Definition of done

All four, or the change is not done:

1. **`npm test` and `npm run build`.** Both. `vitest` does not typecheck; `tsc` has caught
   fixtures that vitest happily accepted.
2. **Name the test that fails before the change and passes after.** A test that only passes
   after pins nothing.
3. **For anything touching paint, session keys, or chain state, show chain evidence** — a
   `get_pixels` or `get_access_key` read, or a transaction reference. Unit tests cannot prove
   a transaction happened.
4. **A `## Learned` line in the PR description**, and an entry in `docs/learning/` if the
   lesson changes how someone should work.

# Do not touch without an explicit human decision

- Contract changes or redeploys — the deployed wasm is live with real state on it.
- Wallet authorisation flows, key scope, or session allowance.
- The palette, or the camera transform maths.
- Anything that would route agent work through an un-pinned model lane.
