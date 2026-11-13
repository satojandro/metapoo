// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sinceLabel } from "./relative-time";

const now = 1_700_000_000_000;

describe("sinceLabel", () => {
  it("never prints a wall-clock time", () => {
    for (const ms of [0, 5, 60, 3_600, 86_400]) {
      expect(sinceLabel(now - ms * 1000, now)).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it("says how stale the reading is, in the units a person thinks in", () => {
    expect(sinceLabel(now, now)).toBe("just now");
    expect(sinceLabel(now - 20_000, now)).toBe("just now");
    expect(sinceLabel(now - 44_000, now)).toBe("just now");
    expect(sinceLabel(now - 45_000, now)).toBe("1 min ago");
    expect(sinceLabel(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(sinceLabel(now - 59 * 60_000, now)).toBe("59 min ago");
    expect(sinceLabel(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(sinceLabel(now - 50 * 3_600_000, now)).toBe("2 days ago");
  });

  it("has nothing to say before the first read, and never a negative age", () => {
    expect(sinceLabel(null, now)).toBe("");
    expect(sinceLabel(now + 60_000, now)).toBe("just now");
  });
});
