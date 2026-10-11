import { describe, expect, it } from "vitest";
import { isUserRejection, parseTxOutcome } from "./tx-outcome";

describe("parseTxOutcome", () => {
  it("reads a successful FinalExecutionOutcome-shaped object", () => {
    const parsed = parseTxOutcome({
      transaction: { hash: "abc123" },
      status: { SuccessValue: "" },
    });
    expect(parsed.status).toBe("success");
    expect(parsed.transactionHash).toBe("abc123");
  });

  it("reads a failed status", () => {
    const parsed = parseTxOutcome({
      transaction: { hash: "deadbeef" },
      status: { Failure: { error_message: "ColorOutOfRange" } },
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.transactionHash).toBe("deadbeef");
    expect(parsed.failureMessage).toMatch(/ColorOutOfRange/);
  });

  it("keeps unknown when only a hash is present", () => {
    const parsed = parseTxOutcome({
      transaction: { hash: "onlyhash" },
    });
    expect(parsed.status).toBe("unknown");
    expect(parsed.transactionHash).toBe("onlyhash");
  });
});

describe("isUserRejection", () => {
  it("treats common rejection wording as recoverable", () => {
    expect(isUserRejection(new Error("User rejected the request"))).toBe(true);
    expect(isUserRejection(new Error("Popup closed"))).toBe(true);
    expect(isUserRejection(new Error("RPC timed out"))).toBe(false);
  });
});
