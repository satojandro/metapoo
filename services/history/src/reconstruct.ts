/**
 * Reconstruct board pixels at revision R from nearest checkpoint + events.
 */

import {
  applyDraw,
  clonePixelMap,
  sparseListToPixels,
} from "./board-state.ts";
import type { HistoryStore } from "./store.ts";
import type { PixelMap } from "./types.ts";

export interface ReconstructedBoard {
  revision: string;
  pixels: PixelMap;
  checkpointRevision: string;
  eventsApplied: number;
}

/**
 * Rebuild state at exactly revision R (0 = baseline).
 * Throws if R is beyond indexed coverage or not a known revision (except 0).
 */
export function reconstructRevision(
  store: HistoryStore,
  revision: string,
): ReconstructedBoard {
  if (!/^\d+$/.test(revision)) {
    throw new RangeError(`invalid revision: ${revision}`);
  }
  const target = BigInt(revision);
  const indexed = BigInt(store.getIndexedRevision());
  if (target > indexed) {
    throw new RangeError(
      `revision ${revision} beyond indexed coverage ${store.getIndexedRevision()}`,
    );
  }
  if (target > 0n && !store.getEventByRevision(revision)) {
    // Intermediate gaps should not be reconstructable as certified moments.
    throw new RangeError(`revision ${revision} not in covered event stream`);
  }

  const checkpoint = store.nearestCheckpointAtOrBefore(revision);
  const pixels = sparseListToPixels(checkpoint.pixels, store.width);
  const from = BigInt(checkpoint.revision) + 1n;
  let applied = 0;

  for (let r = from; r <= target; r += 1n) {
    const event = store.getEventByRevision(String(r));
    if (!event) {
      throw new Error(`missing event for revision ${r} during reconstruction`);
    }
    applyDraw(
      pixels,
      store.width,
      store.height,
      event.x,
      event.y,
      event.color,
      event.artist,
      event.writtenAtNs,
    );
    applied += 1;
  }

  return {
    revision,
    pixels,
    checkpointRevision: checkpoint.revision,
    eventsApplied: applied,
  };
}

/** Compare two pixel maps for equality (used in tests). */
export function pixelMapsEqual(a: PixelMap, b: PixelMap): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) return false;
    if (
      va.color !== vb.color ||
      va.artist !== vb.artist ||
      va.writtenAtNs !== vb.writtenAtNs
    ) {
      return false;
    }
  }
  return true;
}

export function currentPixelsMatchReconstruction(store: HistoryStore): boolean {
  const live = store.getCurrentPixels();
  const rebuilt = reconstructRevision(store, store.getIndexedRevision());
  return pixelMapsEqual(live, rebuilt.pixels);
}

export { clonePixelMap };
