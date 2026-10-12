import { describe, expect, it } from "vitest";
import {
  createPaintQueue,
  enqueuePaint,
  paintQueueLength,
  peekPaint,
  shiftPaint,
} from "./paint-queue";

describe("paint queue", () => {
  it("keeps only the latest color for a duplicate cell", () => {
    const queue = createPaintQueue();
    enqueuePaint(queue, { x: 1, y: 2, colorIndex: 3 });
    enqueuePaint(queue, { x: 1, y: 2, colorIndex: 5 });
    expect(paintQueueLength(queue)).toBe(1);
    expect(peekPaint(queue)?.colorIndex).toBe(5);
  });

  it("shifts in FIFO order for distinct cells", () => {
    const queue = createPaintQueue();
    enqueuePaint(queue, { x: 0, y: 0, colorIndex: 1 });
    enqueuePaint(queue, { x: 1, y: 0, colorIndex: 2 });
    expect(shiftPaint(queue)).toEqual({ x: 0, y: 0, colorIndex: 1 });
    expect(shiftPaint(queue)).toEqual({ x: 1, y: 0, colorIndex: 2 });
    expect(shiftPaint(queue)).toBeNull();
  });
});
