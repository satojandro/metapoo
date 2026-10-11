import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";

/** Bitmap size of one square before CSS stretches the canvas. */
const CELL = 4;

const EMPTY_A = "#e7e1d6";
const EMPTY_B = "#ddd6c8";

/**
 * Draw the board background, then any painted cells we have confirmed.
 *
 * The checker is only a background so empty squares are visible. It is not
 * paint, and it is not one of the eight palette colors.
 *
 * Painted colors come from `pixels` — a sparse list filled only after
 * authoritative reads. Clicking a square must not invent an entry here.
 * The selection ring is an HTML overlay, separate from this bitmap.
 */
export function renderBoard(
  canvas: HTMLCanvasElement,
  pixels: readonly PixelView[] = [],
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  canvas.width = BOARD_WIDTH * CELL;
  canvas.height = BOARD_HEIGHT * CELL;

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
