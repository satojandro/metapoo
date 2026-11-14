/**
 * Draws a replayed wall. One canvas pixel per tile; CSS scales it up with
 * `image-rendering: pixelated`, so a frame is one `putImageData` however many tiles changed.
 *
 * Colours are the wall's own: the palette (`@shared/palette.ts`) and the empty-tile checker
 * (`render-board.ts`). `renderBoard` itself is not used because it draws the *live* board's
 * size, a page-wide setting (`setBoardSide`) this page must not touch: a replay shows the
 * wall at the size it had then. Tiles beyond that size are left transparent, so the stage
 * behind shows where the wall had not been built yet.
 */
import { PALETTE } from "@shared/palette.ts";
import { emptyHexAt } from "../render-board";
import { GRID } from "./timeline";

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PAINT = PALETTE.map((swatch) => rgb(swatch.hex));
const EMPTY = [rgb(emptyHexAt(0, 0)), rgb(emptyHexAt(1, 0))] as const;

/**
 * Fill `out` (RGBA, `size × size`) from `state` (`GRID × GRID`, 0 = empty, else colour + 1).
 * Tiles at or beyond `side` are transparent.
 */
export function paintWall(out: Uint8ClampedArray, state: Uint8Array, side: number, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      if (x >= side || y >= side) {
        out[o + 3] = 0;
        continue;
      }
      const value = state[y * GRID + x]!;
      const colour = value === 0 ? EMPTY[(x + y) % 2]! : (PAINT[value - 1] ?? EMPTY[0]);
      out[o] = colour[0];
      out[o + 1] = colour[1];
      out[o + 2] = colour[2];
      out[o + 3] = 255;
    }
  }
}

export interface WallCanvas {
  draw(state: Uint8Array, side: number): void;
}

/** A drawer for `canvas` at `size` tiles a side. Draws nothing where there is no 2D context. */
export function createWallCanvas(canvas: HTMLCanvasElement, size: number): WallCanvas {
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const image = context && typeof context.createImageData === "function" ? context.createImageData(size, size) : null;
  return {
    draw(state, side) {
      if (!context || !image) return;
      paintWall(image.data, state, side, size);
      context.putImageData(image, 0, 0);
    },
  };
}
