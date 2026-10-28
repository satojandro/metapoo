import { describe, expect, it } from "vitest";
import { planStrokeCommit, strokeResultCopy, strokeBlockedReason, type StrokeGate } from "./stroke-commit";
import { strokeBegin, strokeExtend } from "./stroke-paint";
const tap = strokeBegin({ x: 0, y: 0 });
it("selects single draw, chunked draw_many and wallet approval", () => {
  expect(planStrokeCommit(tap, true).kind).toBe("draw");
  expect(planStrokeCommit(strokeExtend(tap, { x: 100, y: 0 }), true)).toMatchObject({ kind: "draw_many", chunks: [expect.any(Array), expect.any(Array)] });
  expect(planStrokeCommit(tap, false).kind).toBe("wallet_approval");
});
it("reports the exact partial and truncation copy honestly", () => {
  expect(strokeResultCopy({ ...tap, truncated: true }, {
    status: "partial", confirmedChunks: 1, totalChunks: 4, outcomes: [], executedBlocks: [],
    failingChunk: { index: 1, mayHaveBroadcast: true, message: "Lost response." },
  })).toBe("1 of 4 batches confirmed. Batch 2 may already have been broadcast. Remaining batches were not submitted. No automatic retry. Lost response. Stroke limited to 256 cells. The rest of the drag was not submitted.");
  expect(strokeResultCopy(tap, { status: "partial", confirmedChunks: 0, totalChunks: 1, outcomes: [], executedBlocks: [], failingChunk: { index: 0, mayHaveBroadcast: false, message: "Renew session." } }))
    .toBe("0 of 1 batches confirmed. Batch 1 was not broadcast. Remaining batches were not submitted. No automatic retry. Renew session.");
});


describe("strokeBlockedReason", () => {
  const ready: StrokeGate = {
    directPaint: true,
    accountId: "alice.testnet",
    colorIndex: 3,
    contractOk: true,
    priceOk: true,
    sessionActive: true,
    drawInFlight: false,
    queueBusy: false,
  };

  it("says nothing when drag painting is actually available", () => {
    expect(strokeBlockedReason(ready)).toBeNull();
  });

  it("names the missing precondition instead of one opaque message", () => {
    const cases: Array<[StrokeGate, RegExp]> = [
      [{ ...ready, directPaint: false }, /direct paint is off/i],
      [{ ...ready, accountId: null }, /connect a wallet/i],
      [{ ...ready, colorIndex: null }, /pick a colour/i],
      [{ ...ready, contractOk: false }, /metadata does not match/i],
      [{ ...ready, priceOk: false }, /price unavailable/i],
      [{ ...ready, sessionActive: false }, /one approval first/i],
      [{ ...ready, drawInFlight: true }, /still confirming/i],
    ];
    for (const [gate, pattern] of cases) {
      const reason = strokeBlockedReason(gate);
      expect(reason).not.toBeNull();
      expect(reason!).toMatch(pattern);
    }
    // One distinct sentence per missing precondition, or the sentence is noise.
    const distinct = new Set(cases.map(([gate]) => strokeBlockedReason(gate)));
    expect(distinct.size).toBe(cases.length);
  });

  it("treats an in-flight paint and a busy queue as the same situation", () => {
    expect(strokeBlockedReason({ ...ready, drawInFlight: true })).toBe(
      strokeBlockedReason({ ...ready, queueBusy: true }),
    );
  });
});
