import type { DrawRequest } from "./draw-request";

/**
 * Serialized paint queue for session-gated direct-paint mode.
 * One in-flight draw at a time; duplicate cells keep the latest request only.
 * Each entry is an immutable DrawRequest (coords, color, account, network).
 */

export interface PaintQueue {
  items: DrawRequest[];
  inFlight: boolean;
}

export function createPaintQueue(): PaintQueue {
  return { items: [], inFlight: false };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Enqueue a request. A later paint for the same cell replaces an earlier one. */
export function enqueuePaint(queue: PaintQueue, request: DrawRequest): void {
  const key = cellKey(request.x, request.y);
  queue.items = queue.items.filter(
    (item) => cellKey(item.x, item.y) !== key,
  );
  queue.items.push(request);
}

export function peekPaint(queue: PaintQueue): DrawRequest | null {
  return queue.items[0] ?? null;
}

export function shiftPaint(queue: PaintQueue): DrawRequest | null {
  return queue.items.shift() ?? null;
}

export function paintQueueLength(queue: PaintQueue): number {
  return queue.items.length;
}

/**
 * Drop every unsent request. Does not touch `inFlight` — a draw already
 * handed to attemptDraw may still finish; only the waiting list is cancelled.
 */
export function clearPaintQueue(queue: PaintQueue): void {
  queue.items = [];
}
