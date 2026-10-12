import { describe, expect, it } from "vitest";
import { createOperationsStore, paintOperationId } from "./operations";

describe("operations store", () => {
  it("keeps recoverable broadcast ops after a simulated page leave", () => {
    const ops = createOperationsStore();
    const id = paintOperationId({
      accountId: "alice.testnet",
      x: 1,
      y: 2,
      colorIndex: 3,
      nonce: "n1",
    });

    ops.upsert({
      id,
      kind: "paint",
      phase: "submitted",
      accountId: "alice.testnet",
      networkId: "testnet",
      transactionId: "txhash123",
      title: "Paint",
      detail: "Broadcast; awaiting confirmation",
      meta: { x: 1, y: 2, colorIndex: 3 },
    });

    // Simulate wall dispose: callers must not clear the shared store.
    const afterLeave = ops.listRecoverable();
    expect(afterLeave).toHaveLength(1);
    expect(afterLeave[0].transactionId).toBe("txhash123");
    expect(afterLeave[0].phase).toBe("submitted");
  });

  it("does not treat confirmed ops as recoverable", () => {
    const ops = createOperationsStore();
    ops.upsert({
      id: "paint:done",
      kind: "paint",
      phase: "confirmed",
      accountId: "alice.testnet",
      networkId: "testnet",
      transactionId: "tx",
      title: "Paint",
      detail: "done",
    });
    expect(ops.listRecoverable()).toHaveLength(0);
  });
});
