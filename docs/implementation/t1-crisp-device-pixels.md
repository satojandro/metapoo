# T1 — crisp device-pixel paint moment

**Status:** open, dispatchable. Verified missing 2026-10-27 (`grep -rn devicePixelRatio web/src` → 0 hits).
**Owner lane:** engineer (web only). **Human gate:** merge to main.

## Why

At paint zoom a cell should read as a full, crisp square of 16–24 CSS px. Instead the board is a
fixed 512×512 bitmap (`BOARD_WIDTH × CELL`, `CELL = 4` in `web/src/render-board.ts`) stretched by
CSS to the viewport with `image-rendering: pixelated`. On any display where the stretched size is
not an integer multiple of 512 device pixels, bitmap pixels land on fractional device pixels, so
cells blur and pick up hairline seams. On a HiDPI laptop every cell is affected; this is the
flagship "worse than 2021 Berry Club" complaint.

## Required behaviour

1. **Backing store at device resolution.** The canvas bitmap is
   `BOARD_WIDTH * CELL * scale` by `BOARD_HEIGHT * CELL * scale`, where `scale` is
   `devicePixelRatio` clamped to an integer in `[1, 3]`. CSS display size is unchanged.
2. **Cells drawn in device pixels.** Whatever CELL becomes, a cell's `fillRect` covers exactly
   its device-pixel block — no fractional offsets, no gaps between neighbours.
3. **DPR changes are honoured.** Monitor change, browser zoom, or a resize that changes
   `devicePixelRatio` re-sizes the bitmap and re-renders. Listen once per mount; clean up on
   dispose.
4. **No seams.** After the change, sampling any row of adjacent confirmed cells must show a
   contiguous run of palette pixels with no background pixel between them.
5. **Keep the existing read seam working.** `bitmapHex(canvas, x, y)` is used by tests to read one
   cell; it must return that cell's colour at the new resolution.

## Acceptance criteria

- **A test that fails on `origin/main` today** and passes after: with `window.devicePixelRatio = 2`,
  after mount, `canvas.width === BOARD_WIDTH * CELL * 2`, and the device pixel at the centre of a
  painted cell equals that cell's palette hex. It must fail before the change — prove it by
  stashing your source change and re-running.
- A second test for `scale` clamping (DPR 4 → 3) and for a DPR change event re-sizing the bitmap.
- Full `npx vitest run` and `npm run build` pass in `web/`.
- **Manual visual check, required before merge:** at paint zoom, a single painted cell is a solid
  square with no halo or seam, verified against the previous build side by side.

## File set — stop and report outside this

- `web/src/render-board.ts` and `web/src/render-board.test.ts`
- `web/src/pages/wall/mount-wall.ts` (canvas sizing, DPR listener, dispose)
- `web/src/viewport.ts` **only** if the camera transform needs integer snapping; state why

## Do not touch

Palette values or indices; the contract or any wasm; wallet/session/authorisation code; the
stroke or gesture state machine; `docs/backlog.md` (update it in your PR **only** to move the T1
row with your commit id).

## Prior art to read first

`fix_plan.md` holds three unresolved P5 findings against an earlier attempt at this: `crisp-edges`
cascade order, no whole-device-pixel alignment, and no CSS that snaps the canvas. `style.css:669-670`
now has `pixelated` last (correct); the canvas has `width: round(nearest, 100%, 1px)`; the missing
piece is the backing-store resolution, not the CSS. Do not re-add `crisp-edges` after `pixelated`.
