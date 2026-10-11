import { describe, expect, it } from "vitest";
import { describeNetwork } from "./network";

describe("describeNetwork", () => {
  it("treats a missing wallet as read-only, not as a failure", () => {
    const notice = describeNetwork(null);
    expect(notice.matches).toBe(true);
    expect(notice.message).toContain("testnet");
  });

  it("names a mismatch without claiming a transaction happened", () => {
    const notice = describeNetwork("mainnet");
    expect(notice.matches).toBe(false);
    expect(notice.message).toContain("mainnet");
    expect(notice.message).toContain("No draw was sent");
  });
});
