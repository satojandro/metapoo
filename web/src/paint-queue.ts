/**
 * Serialized paint queue for session-gated direct-paint mode.
 * One in-flight draw at a time; duplicate cells keep the latest color only.
 * Does not invent confirmed art — callers still run submitDraw / chain reads.
 */

export interface QueuedPaint {
  x: number;
  y: number;
  colorIndex: number;
}

export interface PaintQueue {
  items: QueuedPaint[];
  inFlight: boolean;
}

export function createPaintQueue(): PaintQueue {
  return { items: [], inFlight: false };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Enqueue a cell. A later paint for the same cell replaces an earlier one. */
export function enqueuePaint(queue: PaintQueue, paint: QueuedPaint): void {
  const key = cellKey(paint.x, paint.y);
  queue.items = queue.items.filter((item) => cellKey(item.x, item.y) !== key);
  queue.items.push({ ...paint });
}

export function peekPaint(queue: PaintQueue): QueuedPaint | null {
  return queue.items[0] ?? null;
}

export function shiftPaint(queue: PaintQueue): QueuedPaint | null {
  return queue.items.shift() ?? null;
}

export function paintQueueLength(queue: PaintQueue): number {
  return queue.items.length;
}
