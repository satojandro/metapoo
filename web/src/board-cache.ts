import type { PixelView } from "@shared/types.ts";

/**
 * Sparse in-memory picture of painted cells.
 *
 * The contract does not ship a "get every pixel" method yet, so the page
 * cannot download the whole wall in one shot. We keep cells we have actually
 * read (after a successful draw, or when the user selects a square).
 *
 * Important: clicking never writes here. Only a confirmed chain read does.
 */

export type PixelCache = Map<string, PixelView>;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function createPixelCache(): PixelCache {
  return new Map();
}

/** Store or clear one cell from an authoritative read. */
export function rememberPixel(cache: PixelCache, pixel: PixelView): void {
  const key = cellKey(pixel.x, pixel.y);
  if (pixel.colorIndex === null) {
    cache.delete(key);
    return;
  }
  cache.set(key, pixel);
}

export function getCachedPixel(
  cache: PixelCache,
  x: number,
  y: number,
): PixelView | undefined {
  return cache.get(cellKey(x, y));
}

export function paintedPixels(cache: PixelCache): PixelView[] {
  return [...cache.values()];
}
