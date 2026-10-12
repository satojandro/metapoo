import { describe, expect, it } from "vitest";
import { createDrawRequest } from "./draw-request";
import {
  createPaintQueue,
  enqueuePaint,
  paintQueueLength,
  peekPaint,
  shiftPaint,
} from "./paint-queue";

describe("paint queue", () => {
  it("keeps only the latest immutable request for a duplicate cell", () => {
    const queue = createPaintQueue();
    enqueuePaint(
      queue,
      createDrawRequest({
        x: 1,
        y: 2,
        colorIndex: 3,
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    );
    enqueuePaint(
      queue,
      createDrawRequest({
        x: 1,
        y: 2,
        colorIndex: 5,
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    );
    expect(paintQueueLength(queue)).toBe(1);
    expect(peekPaint(queue)?.colorIndex).toBe(5);
  });

  it("shifts in FIFO order for distinct cells and preserves request fields", () => {
    const queue = createPaintQueue();
    enqueuePaint(
      queue,
      createDrawRequest({
        x: 0,
        y: 0,
        colorIndex: 1,
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    );
    enqueuePaint(
      queue,
      createDrawRequest({
        x: 1,
        y: 0,
        colorIndex: 2,
        accountId: "bob.testnet",
        networkId: "testnet",
      }),
    );
    const first = shiftPaint(queue);
    expect(first).toMatchObject({
      x: 0,
      y: 0,
      colorIndex: 1,
      accountId: "alice.testnet",
    });
    const second = shiftPaint(queue);
    expect(second).toMatchObject({
      x: 1,
      y: 0,
      colorIndex: 2,
      accountId: "bob.testnet",
    });
    expect(shiftPaint(queue)).toBeNull();
  });
});
