import { describe, expect, it } from "vitest";
import {
  clearPendingPaint,
  createPendingPaintMap,
  listPendingPaints,
  reconcilePendingWithConfirmed,
  setPendingPaint,
} from "./pending-paint";

describe("pending paint layer", () => {
  it("stores and lists pending cells separately from confirmed art", () => {
    const map = createPendingPaintMap();
    setPendingPaint(map, {
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      transactionId: "tx1",
      phase: "submitted",
    });
    expect(listPendingPaints(map)).toHaveLength(1);
    clearPendingPaint(map, 1, 2);
    expect(listPendingPaints(map)).toHaveLength(0);
  });

  it("clears pending when the confirmed cell matches", () => {
    const map = createPendingPaintMap();
    setPendingPaint(map, {
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      transactionId: "tx1",
      phase: "confirmation_delayed",
    });
    reconcilePendingWithConfirmed(map, [
      {
        x: 1,
        y: 2,
        colorIndex: 3,
        artistAccountId: "alice.testnet",
      },
    ]);
    expect(listPendingPaints(map)).toHaveLength(0);
  });

  it("clears pending when another artist overwrites the cell", () => {
    const map = createPendingPaintMap();
    setPendingPaint(map, {
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      transactionId: "tx1",
      phase: "submitted",
    });
    reconcilePendingWithConfirmed(map, [
      {
        x: 1,
        y: 2,
        colorIndex: 7,
        artistAccountId: "bob.testnet",
      },
    ]);
    expect(listPendingPaints(map)).toHaveLength(0);
  });
});
