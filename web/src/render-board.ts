import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import type { PendingPaint } from "./pending-paint";

/** Bitmap size of one square before CSS stretches the canvas. */
const CELL = 4;

const EMPTY_A = "#242629";
const EMPTY_B = "#292b2e";

/**
 * Draw the board background, confirmed paints, then pending previews on top.
 *
 * The checker is only a background so empty squares are visible. It is not
 * paint, and it is not one of the eight palette colors.
 *
 * Confirmed colors come from `pixels` — sparse list after authoritative reads.
 * Pending paints are a separate client-state layer, but use the complete chosen
 * color so a just-painted square never looks clipped or partially filled.
 * Clicking a square must not invent a confirmed entry.
 */
export function renderBoard(
  canvas: HTMLCanvasElement,
  pixels: readonly PixelView[] = [],
  pending: readonly PendingPaint[] = [],
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  canvas.width = BOARD_WIDTH * CELL;
  canvas.height = BOARD_HEIGHT * CELL;
  // The viewport scales this bitmap through its camera transform. Keep the
  // source pixels hard-edged so a scaled logical cell cannot blend into its
  // neighbour at a camera boundary.
  context.imageSmoothingEnabled = false;

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? EMPTY_A : EMPTY_B;
      context.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }

  for (const pixel of pixels) {
    if (pixel.colorIndex === null) {
      continue;
    }
    const swatch = paletteColor(pixel.colorIndex);
    if (!swatch) {
      continue;
    }
    context.fillStyle = swatch.hex;
    context.fillRect(pixel.x * CELL, pixel.y * CELL, CELL, CELL);
  }

  for (const paint of pending) {
    const swatch = paletteColor(paint.colorIndex);
    if (!swatch) {
      continue;
    }
    context.fillStyle = swatch.hex;
    context.fillRect(paint.x * CELL, paint.y * CELL, CELL, CELL);
  }
}

/** Read one bitmap pixel. Used to spot unexpected local paints in checks. */
export function bitmapHex(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): string | null {
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  const pixel = context.getImageData(x * CELL + 1, y * CELL + 1, 1, 1).data;
  return rgbToHex(pixel[0], pixel[1], pixel[2]);
}

function rgbToHex(red: number, green: number, blue: number): string {
  return (
    "#" +
    [red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function emptyHexAt(x: number, y: number): string {
  return (x + y) % 2 === 0 ? EMPTY_A : EMPTY_B;
}
