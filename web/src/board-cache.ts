import type { PixelView } from "@shared/types.ts";
import { isWriteAtLeastAsNew } from "./board-sync";

/**
 * Sparse in-memory picture of painted cells.
 *
 * Each entry records the block height at which we observed it, so a slow full
 * refresh cannot replace a newer single-cell read or draw confirmation.
 */

export interface CachedPixel extends PixelView {
  /** NEAR block height when this cell evidence was applied. */
  observedBlockHeight: number;
}

export type PixelCache = Map<string, CachedPixel>;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function createPixelCache(): PixelCache {
  return new Map();
}

function toCached(pixel: PixelView, observedBlockHeight: number): CachedPixel {
  return { ...pixel, observedBlockHeight };
}

/**
 * Apply a cell observed at `blockHeight` when it is at least as fresh as the
 * cache entry (by block, then by write timestamp).
 */
export function rememberPixelAtBlock(
  cache: PixelCache,
  pixel: PixelView,
  blockHeight: number,
): boolean {
  const key = cellKey(pixel.x, pixel.y);
  const existing = cache.get(key);

  if (existing) {
    if (blockHeight < existing.observedBlockHeight) {
      return false;
    }
    if (
      blockHeight === existing.observedBlockHeight &&
      !isWriteAtLeastAsNew(
        pixel.lastWriteTimestampNs,
        existing.lastWriteTimestampNs,
      )
    ) {
      return false;
    }
  }

  if (pixel.colorIndex === null) {
    // Empty at this block: only clear if we are not wiping newer evidence.
    if (existing && existing.observedBlockHeight > blockHeight) {
      return false;
    }
    cache.delete(key);
    return true;
  }

  cache.set(key, toCached(pixel, blockHeight));
  return true;
}

/** @deprecated Prefer rememberPixelAtBlock with an explicit block height. */
export function rememberPixel(cache: PixelCache, pixel: PixelView): void {
  rememberPixelAtBlock(cache, pixel, Number.MAX_SAFE_INTEGER);
}

/** @deprecated Prefer rememberPixelAtBlock. */
export function rememberPixelIfNewer(
  cache: PixelCache,
  pixel: PixelView,
): boolean {
  return rememberPixelAtBlock(cache, pixel, Number.MAX_SAFE_INTEGER);
}

/**
 * Apply a full board snapshot from one pinned block.
 * Keeps any cache cells observed at a strictly newer block than this snapshot.
 */
export function replaceCacheAtBlock(
  cache: PixelCache,
  pixels: readonly PixelView[],
  blockHeight: number,
): void {
  const newer = new Map<string, CachedPixel>();
  for (const [key, value] of cache) {
    if (value.observedBlockHeight > blockHeight) {
      newer.set(key, value);
    }
  }

  cache.clear();
  for (const [key, value] of newer) {
    cache.set(key, value);
  }
  for (const pixel of pixels) {
    rememberPixelAtBlock(cache, pixel, blockHeight);
  }
}

/** @deprecated Prefer replaceCacheAtBlock. */
export function replaceCache(
  cache: PixelCache,
  pixels: readonly PixelView[],
): void {
  replaceCacheAtBlock(cache, pixels, 0);
}

export function getCachedPixel(
  cache: PixelCache,
  x: number,
  y: number,
): CachedPixel | undefined {
  return cache.get(cellKey(x, y));
}

export function paintedPixels(cache: PixelCache): PixelView[] {
  return [...cache.values()].map(
    ({ observedBlockHeight: _b, ...pixel }) => pixel,
  );
}
