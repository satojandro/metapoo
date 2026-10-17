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
}

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
): void {
  map.set(key(paint.x, paint.y), paint);
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
): void {
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
