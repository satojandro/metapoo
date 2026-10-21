import { describe, expect, it } from "vitest";
import type { SubmitDrawResult } from "../../submit-draw";
import { createPlacementOutcomeController } from "./placement-outcome";

const placement = { x: 8, y: 12, colorIndex: 3 };
function result(
  status: "confirmed" | "overwritten" | "confirmation_delayed" | "failed",
): SubmitDrawResult {
  if (status === "confirmed" || status === "overwritten") return { status, title: status, message: `${status} result`, transactionId: "tx-1", explorerUrl: null, pixel: { x: 8, y: 12, colorIndex: 3, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1" }, observedBlockHeight: 7 };
  if (status === "confirmation_delayed") return { status, title: status, message: "read error; do not retry", transactionId: "tx-1", explorerUrl: null, pixel: null, observedBlockHeight: null };
  return { status, title: status, message: "observed failure", transactionId: null, explorerUrl: null, pixel: null };
}
describe("placement outcome controller", () => {
  it("records a matching cell as confirmed", () => { const c = createPlacementOutcomeController({ now: () => 100 }); const id = c.submit(placement); c.settle(id, result("confirmed")); expect(c.list()[0]).toMatchObject({ state: "confirmed", submittedAtMs: 100, settledAtMs: 100 }); });
  it("records wallet success with a non-matching current cell as overwritten, not failed", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("overwritten")); expect(c.list()[0]?.state).toBe("overwritten"); });
  it("records an observed transaction failure as failed", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("failed")); expect(c.list()[0]?.state).toBe("failed"); });
  it("keeps a read error uncertain and never invokes another submit", () => { const c = createPlacementOutcomeController(); const id = c.submit(placement); c.settle(id, result("confirmation_delayed")); expect(c.list()[0]).toMatchObject({ state: "confirmation-delayed", detail: "read error; do not retry" }); expect(c.list()).toHaveLength(1); });
});
