# Drag-to-paint: state, decisions, and how to run it (2026-10-26)

Written after the 2026-10-25/26 session died mid-task on credit exhaustion.
Branch: `feat/drag-to-paint-stroke` (`e1f7b54`) — uncommitted work rescued and pushed.

## What is already built (and verified)

| Piece | State | Evidence |
|---|---|---|
| Contract `draw` / `draw_many` (schema 2, batch cap 64) | live | ABI probe on `wall.berrywall1.testnet`; 1,368 cells read from chain |
| Seeded mural | complete | 1,368 painted cells, incl. the sun at (108,16) = colour 3 |
| `web/src/pages/wall/stroke-paint.ts` | done | 8/8 tests (Bresenham interpolation, de-dup, 256-cell cap, 64-cell chunking) |
| Session key widened to `[draw, draw_many]` | done | `drawing-session.test.ts` 16/16 |
| `signAndSendStrokeLocally` (batch, session-signed) | **missing** | `local-draw.ts` only signs single-cell `draw` |
| Paint-mode drag wiring | **missing** | `mount-wall.ts` still treats drag as pan; paint is Place-button only |
| Live no-popup stroke on testnet | **never run** | needs the human at the wallet |

## Verified facts worth not rediscovering

- **Gas**: `near call`'s default gas is 30 Tgas, identical to the web's `DRAW_GAS` — and the whole mural was seeded with 64-cell `draw_many` calls at that default. So the existing constant already covers a full batch; no new gas constant is needed.
- **Deployed ≠ byte-verified**: local `metapoo_board.wasm` (built 16:40 Oct 25) hashes to `E6V6Y5…`; the deployed account's code hash is `34LjyfE…`. The method set matches (paid `get_quote`/`get_regions` fail exactly like a bogus method name), so this is most likely a `cargo-near` vs plain-cargo build-flag difference — but do **not** redeploy to "fix" it. `cargo` is not on `PATH`; it lives at `~/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo`.
- **Chunk boundaries are transaction boundaries.** The contract is atomic per call, not per gesture: a 256-cell stroke is 4 transactions. A partial failure must be reported as "N of M landed, nothing was retried", never silently retried — a retry after an unresolved broadcast double-paints.

## Decisions only Alejandro can make

1. **Session-key allowance scope** (this is the AO escalation, still open). Today: methods `draw` + `draw_many`, receiver pinned to `wall.berrywall1.testnet`, allowance 0.05 NEAR. A 30 Tgas call costs roughly 0.003 NEAR at the standard 1e8 yocto/gas, so 0.05 NEAR is about 16 chunks ≈ 4 full 256-cell gestures before exhaustion. Options: keep 0.05 and surface "remaining strokes" in the UI, or raise it for a demo session. **Measure the real per-chunk cost from the first live receipt instead of trusting the estimate.**
2. **Drag vs pan at paint zoom.** Drag-to-paint means one-finger drag can no longer pan. Recommend: at paint zoom one-finger drag paints and panning moves to wheel/two-finger (Berry Club's model), with an explicit test that wheel/pinch never paints. The alternative is an arm/disarm toggle before a drag paints.
3. **Two-device live check** needs a configured game account id and a deployed URL (AO escalation, unchanged).

## How to run it

Codex (subscription lane — no router credits):

```bash
cd ~/Projects/metapoo && git checkout feat/drag-to-paint-stroke
codex exec "$(python3 -c 'import json;print(json.load(open("docs/implementation/drag-to-paint-stroke.task.json"))["goal"])')"
```

Then verify independently: `cd web && npm test && npm run build`, and the on-chain cell-count walk described in the manifest's VERIFICATION block.