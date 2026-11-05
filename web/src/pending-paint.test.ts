import { describe, expect, it } from "vitest";
import {
  PENDING_PAINT_MAX_AGE_MS,
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

  it("keeps an unresolved preview when current ownership does not prove its outcome", () => {
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
    expect(listPendingPaints(map)).toHaveLength(1);
  });

  it("drops a marker the chain never matched once it is older than the limit", () => {
    // Issue #70: a paint that failed or never left the browser stayed on the
    // board as pending forever, because only an exact chain match cleared it.
    const map = createPendingPaintMap();
    const paint = { x: 4, y: 4, colorIndex: 2, accountId: "alice.near", transactionId: null, phase: "confirmation_delayed" as const };
    setPendingPaint(map, paint, 1_000);
    reconcilePendingWithConfirmed(map, [], 1_000 + PENDING_PAINT_MAX_AGE_MS);
    expect(listPendingPaints(map)).toHaveLength(1);
    reconcilePendingWithConfirmed(map, [], 1_000 + PENDING_PAINT_MAX_AGE_MS + 1);
    expect(listPendingPaints(map)).toHaveLength(0);
  });
});
