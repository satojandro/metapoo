import { describe, expect, it } from "vitest";
import {
  happyHourClock, loadHowItWorks, minutesText, nearText, nextHappyHourStart, parseSnapshot,
  practicePrices, practiceReceipt, spendOutcome, type PracticeCell,
} from "./how-it-works";

const TUNABLES = {
  repaint_young_ns: 600_000_000_000, repaint_mid_ns: 3_600_000_000_000,
  repaint_young_credits: 4, repaint_mid_credits: 2, repaint_base_credits: 1,
  free_first_paints_per_account: 25,
  happy_hour_enabled: false, happy_hour_weekday: 6, happy_hour_start_s: 72_000,
  happy_hour_length_s: 3600, happy_hour_cap_per_account: 100, happy_hour_requires_purchase: true,
};

describe("parseSnapshot", () => {
  it("reads each view on its own", () => {
    const s = parseSnapshot({
      paymentConfig: { near_per_credit: "2500000000000000000000", registration_fee: "10000000000000000000000" },
      tunables: TUNABLES,
      happyHour: { first_fill_complete: false },
      pixelsPage: { total: 8 },
    });
    expect(s.nearPerCredit).toBe(2_500_000_000_000_000_000_000n);
    expect(s.registrationFee).toBe(10_000_000_000_000_000_000_000n);
    expect(s.tiers?.repaint_young_credits).toBe(4);
    expect(s.freeFirstPerAccount).toBe(25);
    expect(s.happyHour).toEqual({ enabled: false, weekday: 6, startS: 72_000, lengthS: 3600, cap: 100, requiresPurchase: true });
    expect(s.firstFillComplete).toBe(false);
    expect(s.painted).toBe(8);
  });

  it("leaves a missing or malformed read unknown, never zero", () => {
    const s = parseSnapshot({ paymentConfig: { near_per_credit: "lots" }, tunables: { happy_hour_weekday: 9 }, pixelsPage: {} });
    expect(s).toEqual({
      nearPerCredit: null, registrationFee: null, tiers: null, freeFirstPerAccount: null,
      happyHour: null, firstFillComplete: null, painted: null,
    });
  });

  it("loadHowItWorks survives failing views", async () => {
    const view = async (_a: string, method: string) => {
      if (method === "get_tunables") return TUNABLES;
      throw new Error("RPC down");
    };
    const s = await loadHowItWorks(view, "board.testnet");
    expect(s.tiers).not.toBeNull();
    expect(s.nearPerCredit).toBeNull();
    expect(s.painted).toBeNull();
  });
});

describe("formatting", () => {
  it("cuts NEAR, never rounds up", () => {
    expect(nearText(2_500_000_000_000_000_000_000n)).toBe("0.0025");
    expect(nearText(10_000_000_000_000_000_000_000n)).toBe("0.01");
    expect(nearText(1_999_999_900_000_000_000_000_000n, 2)).toBe("1.99");
  });
  it("names windows in plain words", () => {
    expect(minutesText(600_000_000_000)).toBe("10 minutes");
    expect(minutesText(3_600_000_000_000)).toBe("an hour");
    expect(minutesText(7_200_000_000_000)).toBe("2 hours");
  });
});

describe("happy hour", () => {
  // Sunday (weekday 6), 20:00 UTC, one hour.
  const sunday20 = { weekday: 6, startS: 72_000, lengthS: 3600 };
  it("finds this week's window from a Wednesday", () => {
    const wed = Date.UTC(2026, 10, 4, 12, 0, 0); // Wed 4 Nov 2026
    expect(nextHappyHourStart(wed, 6, 72_000, 3600)).toBe(Date.UTC(2026, 10, 8, 20, 0, 0));
  });
  it("wraps to next week once this week's window has ended", () => {
    const after = Date.UTC(2026, 10, 8, 21, 30, 0); // Sunday 21:30
    expect(nextHappyHourStart(after, 6, 72_000, 3600)).toBe(Date.UTC(2026, 10, 15, 20, 0, 0));
  });
  it("wraps from Monday back into a Sunday window that runs past midnight", () => {
    // Sunday 23:30 for two hours: still open at 00:30 on Monday.
    const monday = Date.UTC(2026, 10, 9, 0, 30, 0);
    expect(nextHappyHourStart(monday, 6, 84_600, 7200)).toBe(Date.UTC(2026, 10, 8, 23, 30, 0));
  });
  it("says open now during the window", () => {
    const during = Date.UTC(2026, 10, 8, 20, 15, 0);
    const c = happyHourClock(during, sunday20);
    expect(c.open).toBe(true);
    expect(c.label).toBe("Open now · 45:00 left");
  });
  it("counts down before it", () => {
    const before = Date.UTC(2026, 10, 7, 18, 0, 0); // Saturday 18:00
    expect(happyHourClock(before, sunday20).label).toBe("1d 02h 00m 00s");
  });
});

describe("the autonomous stall", () => {
  it("splits a week's NEAR 63 / 18 / 19 before swap costs", () => {
    const o = spendOutcome(100);
    expect(o.stakers).toBeCloseTo(63);
    expect(o.flushed).toBeCloseTo(18);
    expect(o.team).toBeCloseTo(19);
    expect(o.stakers + o.flushed + o.team).toBeCloseTo(100);
  });
});

describe("practice wall", () => {
  const p = practicePrices(null);
  const blank: PracticeCell = { color: null, at: null };
  const wet: PracticeCell = { color: 11, at: -3 };
  const drying: PracticeCell = { color: 5, at: -25 };
  const dry: PracticeCell = { color: 9, at: -90 };

  it("prices by wetness on a normal day", () => {
    const r = practiceReceipt([blank, wet, drying, dry], 0, "normal", p, { first: 25, happy: 100 });
    expect(r.credits).toBe(1 + 4 + 2 + 1);
    expect(r.free).toBe(0);
  });
  it("makes blank tiles free while the wall fills, and spends the allowance", () => {
    const r = practiceReceipt([blank, blank, wet], 0, "filling", p, { first: 1, happy: 100 });
    expect(r.credits).toBe(0 + 1 + 4);
    expect(r.free).toBe(1);
    expect(r.budget.first).toBe(0);
  });
  it("makes dry and blank tiles free in happy hour, never wet ones", () => {
    const r = practiceReceipt([dry, blank, wet, drying], 0, "happy", p, { first: 25, happy: 100 });
    expect(r.credits).toBe(0 + 0 + 4 + 2);
    expect(r.budget.happy).toBe(98);
  });
  it("uses the board's real tiers when it has them", () => {
    const real = practicePrices({ repaint_young_ns: 300_000_000_000, repaint_mid_ns: 1_800_000_000_000, repaint_young_credits: 8, repaint_mid_credits: 3, repaint_base_credits: 1 });
    expect(real).toEqual({ young: 8, mid: 3, base: 1, youngMin: 5, midMin: 30 });
    expect(practiceReceipt([{ color: 1, at: -10 }], 0, "normal", real, { first: 0, happy: 0 }).credits).toBe(3);
  });
});
