import type { PixelView } from "@shared/types.ts";
import { isWriteAtLeastAsNew } from "./board-sync";

/**
 * Sparse in-memory picture of painted cells.
 *
 * On open (and on refresh), the page fills this from paginated `get_pixels`
 * reads. Clicks never write here — only authoritative chain reads do.
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

/**
 * Apply a single-cell read only when it is at least as new as the cached write.
 * Prevents a slow selected-cell response from overwriting a newer full refresh.
 * Returns true when the cache changed.
 */
export function rememberPixelIfNewer(
  cache: PixelCache,
  pixel: PixelView,
): boolean {
  const existing = cache.get(cellKey(pixel.x, pixel.y));
  if (
    existing &&
    !isWriteAtLeastAsNew(
      pixel.lastWriteTimestampNs,
      existing.lastWriteTimestampNs,
    )
  ) {
    return false;
  }
  rememberPixel(cache, pixel);
  return true;
}

/**
 * Replace the whole cache from a full `get_pixels` walk.
 * Cleared first so cells that were wiped on chain (if that ever happens)
 * do not linger locally. Today the contract only overwrites, never deletes.
 */
export function replaceCache(cache: PixelCache, pixels: readonly PixelView[]): void {
  cache.clear();
  for (const pixel of pixels) {
    rememberPixel(cache, pixel);
  }
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
