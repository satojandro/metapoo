import { describe, expect, it } from "vitest";
import {
  formatDurationNs,
  formatQuoteAge,
  formatQuoteExpiry,
  formatToiletAmount,
  summarizeQuoteTiming,
} from "./format";

describe("quote expiry formatting", () => {
  const observed = "1000000000000"; // 1s in ns from epoch-ish fixture
  const expires = "1030000000000"; // +30s

  it("formats durations in ms, seconds, and minutes", () => {
    expect(formatDurationNs(0n)).toBe("0s");
    expect(formatDurationNs(500_000n)).toBe("<1ms");
    expect(formatDurationNs(25_000_000n)).toBe("25ms");
    expect(formatDurationNs(5_000_000_000n)).toBe("5s");
    expect(formatDurationNs(125_000_000_000n)).toBe("2m 5s");
    expect(formatDurationNs(120_000_000_000n)).toBe("2m");
  });

  it("formats quote age relative to now", () => {
    expect(formatQuoteAge(observed, observed)).toBe("just now");
    expect(formatQuoteAge(observed, "1005000000000")).toBe("5s ago");
  });

  it("formats expiry and marks expired quotes", () => {
    expect(formatQuoteExpiry(expires, "1010000000000")).toBe("expires in 20s");
    expect(formatQuoteExpiry(expires, "1040000000000")).toBe("expired");
  });

  it("summarizes timing for the placement dock", () => {
    const live = summarizeQuoteTiming(
      { observedAtNs: observed, expiresAtNs: expires },
      "1010000000000",
    );
    expect(live.expired).toBe(false);
    expect(live.ageLabel).toBe("10s ago");
    expect(live.expiryLabel).toBe("expires in 20s");

    const dead = summarizeQuoteTiming(
      { observedAtNs: observed, expiresAtNs: expires },
      "1040000000000",
    );
    expect(dead.expired).toBe(true);
    expect(dead.expiryLabel).toBe("expired");
  });

  it("labels TOILET amounts without floating math", () => {
    expect(formatToiletAmount("10")).toBe("10 TOILET");
    expect(formatToiletAmount("50")).toBe("50 TOILET");
  });
});
