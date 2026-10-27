import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import type { PendingPaint } from "./pending-paint";

/** Bitmap size of one square before CSS stretches the canvas. */
export const CELL = 4;

const EMPTY_A = "#242629";
const EMPTY_B = "#292b2e";

/** Device pixels per logical bitmap pixel. Clamped so 3x is the ceiling. */
export const MAX_RENDER_SCALE = 3;

/**
 * Integer scale from CSS pixels to device pixels.
 *
 * Reading `devicePixelRatio` inside the renderer means every render picks up the
 * current display, so moving the window between a HiDPI and a standard monitor
 * fixes itself on the next frame instead of needing a listener that can be
 * missed. Rounded, not fractional: a fractional scale reintroduces exactly the
 * sub-pixel seams this exists to remove.
 */
export function renderScale(dpr?: number): number {
  const raw =
    typeof dpr === "number"
      ? dpr
      : typeof window !== "undefined" && typeof window.devicePixelRatio === "number"
        ? window.devicePixelRatio
        : 1;
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return Math.min(MAX_RENDER_SCALE, Math.max(1, Math.round(raw)));
}

/**
 * Marker for a cell whose paint is not confirmed on chain yet.
 *
 * Deliberately outside the eight palette colours: the marker must never be
 * mistakable for art. `#ff2fd0` is far from every palette entry (the nearest,
 * Grape `#6b4c7a`, is dark and desaturated).
 */
export const PENDING_MARK = "#ff2fd0";

/**
 * Draw the board background, confirmed paints, then pending previews on top.
 *
 * The checker is only a background so empty squares are visible. It is not
 * paint, and it is not one of the eight palette colors.
 *
 * Confirmed colors come from `pixels` — sparse list after authoritative reads.
 * Pending paints are a separate client-state layer. They use the chosen color
 * and add a single-device-pixel corner mark, so they remain visibly distinct
 * from chain-read confirmed art without being written into the confirmed cache.
 * Clicking a square must not invent a confirmed entry.
 */
export function renderBoard(
  canvas: HTMLCanvasElement,
  pixels: readonly PixelView[] = [],
  pending: readonly PendingPaint[] = [],
  dpr?: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  // Backing store in device pixels, CSS size unchanged: the bitmap is never
  // stretched by a fractional factor, so a cell lands on whole device pixels
  // and cannot blur or leave a seam against its neighbour.
  const scale = renderScale(dpr);
  const cell = CELL * scale;
  canvas.width = BOARD_WIDTH * cell;
  canvas.height = BOARD_HEIGHT * cell;
  // The viewport scales this bitmap through its camera transform. Keep the
  // source pixels hard-edged so a scaled logical cell cannot blend into its
  // neighbour at a camera boundary.
  context.imageSmoothingEnabled = false;

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? EMPTY_A : EMPTY_B;
      context.fillRect(x * cell, y * cell, cell, cell);
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
    context.fillRect(pixel.x * cell, pixel.y * cell, cell, cell);
  }

  for (const paint of pending) {
    const swatch = paletteColor(paint.colorIndex);
    if (!swatch) {
      continue;
    }
    context.fillStyle = swatch.hex;
    context.fillRect(paint.x * cell, paint.y * cell, cell, cell);
    // One device pixel in the cell's own top-left corner, never an outline.
    // At CELL = 4 an inset 1px stroke leaves a 2x2 interior, so an unconfirmed
    // cell reads as the marker's colour instead of the paint's — which is the
    // "why is my pixel yellow" bug reported from live testing. The marker may
    // mark a cell; it may never repaint one.
    context.fillStyle = PENDING_MARK;
    context.fillRect(paint.x * cell, paint.y * cell, scale, scale);
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
  // Derive the scale from the canvas itself so the read seam keeps working at
  // whatever resolution the caller rendered at.
  const scale = Math.max(1, Math.round(canvas.width / (BOARD_WIDTH * CELL)));
  const cell = CELL * scale;
  const middle = x * cell + Math.floor(cell / 2);
  const vertical = y * cell + Math.floor(cell / 2);
  const pixel = context.getImageData(middle, vertical, 1, 1).data;
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
