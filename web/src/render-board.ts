import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import type { PendingPaint } from "./pending-paint";

/** Bitmap size of one square before CSS stretches the canvas. */
const CELL = 4;

const EMPTY_A = "#e7e1d6";
const EMPTY_B = "#ddd6c8";

/**
 * Draw the board background, confirmed paints, then pending previews on top.
 *
 * The checker is only a background so empty squares are visible. It is not
 * paint, and it is not one of the eight palette colors.
 *
 * Confirmed colors come from `pixels` — sparse list after authoritative reads.
 * Pending paints are a separate client layer (striped) and must not be confused
 * with confirmed art. Clicking a square must not invent a confirmed entry.
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
    drawPendingCell(context, paint.x, paint.y, swatch.hex);
  }
}

/** Striped overlay so pending paint is visibly different from confirmed art. */
function drawPendingCell(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  hex: string,
): void {
  const left = x * CELL;
  const top = y * CELL;
  context.save();
  context.globalAlpha = 0.55;
  context.fillStyle = hex;
  context.fillRect(left, top, CELL, CELL);
  context.globalAlpha = 0.9;
  context.strokeStyle = "#111111";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left, top + CELL);
  context.lineTo(left + CELL, top);
  context.stroke();
  context.beginPath();
  context.moveTo(left, top + CELL / 2);
  context.lineTo(left + CELL / 2, top);
  context.stroke();
  context.restore();
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
