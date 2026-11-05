/**
 * Client-only pending paint layer.
 *
 * Shown while a draw is submitted or confirmation is delayed.
 * Never written into the confirmed pixel cache — that stays chain-read only.
 */

export type PendingPaintPhase = "submitted" | "confirmation_delayed";

export interface PendingPaint {
  x: number;
  y: number;
  colorIndex: number;
  accountId: string;
  transactionId: string | null;
  phase: PendingPaintPhase;
  /** When this browser last set the marker (ms). Set by `setPendingPaint`. */
  markedAtMs?: number;
}

/**
 * How long a pending marker may outlive its paint before the board shows chain
 * state instead. A NEAR transaction executes within a few blocks; a marker that is
 * still unmatched after this long belongs to a paint that failed, never left the
 * browser, or was painted over — and leaving it up forever (issue #70) shows the
 * painter pixels the chain does not have. Dropping it only removes an overlay:
 * nothing is resubmitted, and a late execution still appears through the board read.
 */
export const PENDING_PAINT_MAX_AGE_MS = 90_000;

export type PendingPaintMap = Map<string, PendingPaint>;

function key(x: number, y: number): string {
  return `${x},${y}`;
}

export function createPendingPaintMap(): PendingPaintMap {
  return new Map();
}

export function setPendingPaint(
  map: PendingPaintMap,
  paint: PendingPaint,
  nowMs: number = Date.now(),
): void {
  map.set(key(paint.x, paint.y), { ...paint, markedAtMs: nowMs });
}

export function clearPendingPaint(
  map: PendingPaintMap,
  x: number,
  y: number,
): void {
  map.delete(key(x, y));
}

export function getPendingPaint(
  map: PendingPaintMap,
  x: number,
  y: number,
): PendingPaint | undefined {
  return map.get(key(x, y));
}

export function listPendingPaints(map: PendingPaintMap): PendingPaint[] {
  return [...map.values()];
}

/**
 * Drop pending cells only when chain state confirms the requested artist and
 * color. A different current owner cannot resolve an uncertain transaction:
 * that paint may not have executed yet, or may have executed and been replaced.
 */
export function reconcilePendingWithConfirmed(
  map: PendingPaintMap,
  confirmed: ReadonlyArray<{
    x: number;
    y: number;
    colorIndex: number | null;
    artistAccountId: string | null;
  }>,
  nowMs: number = Date.now(),
): void {
  expirePendingPaints(map, nowMs);
  for (const pixel of confirmed) {
    const pending = map.get(key(pixel.x, pixel.y));
    if (!pending) {
      continue;
    }
    if (
      pixel.colorIndex === pending.colorIndex &&
      pixel.artistAccountId === pending.accountId
    ) {
      map.delete(key(pixel.x, pixel.y));
      continue;
    }
  }
}

/** Drop markers older than `PENDING_PAINT_MAX_AGE_MS`; see that constant. */
export function expirePendingPaints(map: PendingPaintMap, nowMs: number = Date.now()): void {
  for (const [cell, paint] of map) {
    if (paint.markedAtMs !== undefined && nowMs - paint.markedAtMs > PENDING_PAINT_MAX_AGE_MS) {
      map.delete(cell);
    }
  }
}
