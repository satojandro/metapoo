import { describe, expect, it } from "vitest";
import { planStrokeCommit, strokeResultCopy, strokeBlockedReason, type StrokeGate } from "./stroke-commit";
import { strokeBegin, strokeExtend } from "./stroke-paint";
import type { LocalChunkResult, LocalStrokeResult } from "../../local-draw";
const tap = strokeBegin({ x: 0, y: 0 });
it("replaces the chain's raw allowance error with one the painter can act on", () => {
  const raw = "Access Key {account_id}:{public_key} does not have enough balance 0.0308734581660761 for transaction costing 0.0309213099526195";
  const copy = strokeResultCopy(tap, partial([chunk(0, "failed", raw)]));
  expect(copy).toContain("Batch 1 was not painted. Your painting key is low");
  expect(copy).not.toMatch(/account_id|public_key/);
});
it("selects single draw, chunked draw_many and wallet approval", () => {
  expect(planStrokeCommit(tap, true).kind).toBe("draw");
  expect(planStrokeCommit(strokeExtend(tap, { x: 100, y: 0 }), true)).toMatchObject({ kind: "draw_many", chunks: [expect.any(Array), expect.any(Array)] });
  expect(planStrokeCommit(tap, false).kind).toBe("wallet_approval");
});
const chunk = (index: number, state: LocalChunkResult["state"], message: string | null = null): LocalChunkResult =>
  ({ index, state, message, transactionHash: null, blockHeight: null });
const partial = (chunks: LocalChunkResult[]): LocalStrokeResult => {
  const bad = chunks.find((c) => c.state !== "confirmed")!;
  return {
    status: "partial", confirmedChunks: chunks.filter((c) => c.state === "confirmed").length,
    totalChunks: chunks.length, outcomes: [], executedBlocks: [], chunks,
    failingChunk: { index: bad.index, mayHaveBroadcast: bad.state === "uncertain", message: bad.message ?? "" },
  };
};
it("reports the exact partial and truncation copy honestly", () => {
  expect(strokeResultCopy({ ...tap, truncated: true }, partial([
    chunk(0, "confirmed"), chunk(1, "uncertain", "Lost response."),
    chunk(2, "not_sent", "Not sent: an earlier batch's send failed."), chunk(3, "not_sent", "Not sent: an earlier batch's send failed."),
  ]))).toBe("1 of 4 batches confirmed. Batch 2 may already have been broadcast. Lost response. Batches 3, 4 were not sent. Not sent: an earlier batch's send failed. No automatic retry. Stroke limited to 256 cells. The rest of the drag was not submitted.");
  expect(strokeResultCopy(tap, partial([chunk(0, "not_sent", "Renew session.")])))
    .toBe("0 of 1 batches confirmed. Batch 1 was not sent. Renew session. No automatic retry.");
});
it("names a failed batch in the middle without claiming the later ones were skipped", () => {
  // Pipelined batches: batch 2 failing does not stop batch 3, which was already sent.
  expect(strokeResultCopy(tap, partial([chunk(0, "confirmed"), chunk(1, "failed", "PriceRoseAboveMax"), chunk(2, "confirmed")])))
    .toBe("2 of 3 batches confirmed. Batch 2 was not painted. PriceRoseAboveMax. No automatic retry.");
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
      [{ ...ready, directPaint: false }, /Drag to paint strokes/],
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
