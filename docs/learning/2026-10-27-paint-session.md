# 2026-10-27 — the session where drag-to-paint had never worked

## Session

- Date: 2026-10-27
- Learner: Alejandro (PO, hands-on testing) with Hermes crypto-builder on the Mac Mini
- Goal: a live human test of drag-to-paint against `wall.berrywall1.testnet`
- Environment: live testnet writes from a real wallet; reads through `near-cli-rs`
- Explored: `web/src/pages/wall/mount-wall.ts`, `local-draw.ts`, `render-board.ts`,
  `board-cache.ts`, `pending-paint.ts`, `contracts/board`

## Before starting

Belief: drag-to-paint was implemented and merged (PR #14), with 248 passing tests, so the
test would be about polish. **That belief was wrong**, and the way it was wrong is the lesson.

## What I observed

- Expected: a drag produces one transaction per 64 cells and pixels appear.
- Actual: the drag painted locally, every cell stayed "pending", and **the chain never moved**.
- Evidence: `get_pixels` returned the same 1,373 cells before and after; the session key's
  allowance was 0.25 NEAR **fully unspent** and its nonce unchanged; a browser probe threw
  `ReferenceError: Buffer is not defined` while building the `draw_many` action.
- What this proves: the failure was **before serialisation**, not slow RPC, not allowance, not
  the contract.
- What it does not prove: that a broadcast executes. That still needed a live signature.

## What I learned

- **A green suite verified the wrong layer.** 248 unit tests and a clean build coexisted with
  a headline feature that had never once reached the chain.
- GraphQL-style "pending" is not a state you can trust: `mayHaveBroadcast` recorded "a send
  was attempted", not "a transaction exists", so a purely local failure pinned every cell
  forever.
- The **allowance delta** distinguishes "sent" from "never left the machine" without any
  instrumentation.
- Discoverability is a correctness property: three separate findings (dead toggle, cryptic
  string, drag that pans) all came from a precondition enforced in code and invisible in the UI.

## Problems and decisions

| error or confusing behaviour | likely cause | how it was narrowed down | decision |
|---|---|---|---|
| second click does not paint | `maybeEnqueueDirectPaint` dropped taps while `drawInFlight` | held the first submit unresolved in a test | queue instead of drop (`993842d`) |
| drag pans instead of painting | `isPaintZoom` was part of the arm gate | read the gate; fitted cells are 4–7 px vs a 16 px threshold | drop it; pan becomes an explicit gesture (`9d13412`) |
| "weird yellow" pixels | unconfirmed-cell marker was a 1 px inset stroke covering 75 % of a 4 px cell | sampled the bitmap; the cell interior was the marker colour | one corner pixel in a non-palette colour (`a351516`) |
| cryptic dock sentence | a runtime-created `<p>` with no stylesheet rule | searched the string; it was created in JS, not the template | moved into the template, sentence deleted (`499c42f`) |
| paints sat pending minutes after the chain moved | client waited for a full 64-request re-read to rediscover its own write | compared receipt block against the read cycle | stamp cells from the receipt (`c547bcd`) |

Open question for the coordinator: should the poll detect change cheaply (needs a contract
view) or keep paging the wall — see `docs/roadmap.md` R2.

## Next small practice

- Exercise: run the full flow on a fresh browser profile and count the wallet prompts. Expect
  exactly one, before the first pixel.
- Expected result: zero prompts afterwards, including across a reload.
- How I will know it worked: the dock says "Painting unlocked", and two consecutive taps each
  produce a transaction with no popup.
