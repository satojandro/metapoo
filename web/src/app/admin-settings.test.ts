import { describe, expect, it, vi } from "vitest";
import { decimalUnits, discountedMpooPrice, parseChainJson, stringifyChainJson, prepareTunableChange, validateTunables, priceChange, loadAdmin, type ChainRecord } from "./admin-settings";

import { tunables } from "./admin-test-fixture";
const NOW = 1793000000000;
describe("admin settings safety", () => {
  it("preserves nanosecond history exactly while changing only one field", async () => {
    const record = { ...tunables(), last_near_price_change_ns: 1700000000123456789n };
    const view = vi.fn(async () => ({ ...record }));
    const result = await prepareTunableChange(view, "board.testnet", record, "mpoo_daily_credit_cap", "20000", 0n, NOW);
    expect(result.tunables).toEqual({ ...record, mpoo_daily_credit_cap: 20000 });
    expect(view).toHaveBeenCalledWith("board.testnet", "get_tunables");
    const wire = stringifyChainJson(result);
    expect(wire).toContain('"last_near_price_change_ns":1700000000123456789');
    expect(parseChainJson(wire)).toEqual(result);
  });
  it("stops a stale editor and identifies the changed field", async () => {
    await expect(prepareTunableChange(async () => ({ ...tunables(), repaint_mid_credits: 3 }), "board.testnet", tunables(), "mpoo_daily_credit_cap", "20", 0n, NOW)).rejects.toThrow(/SettingsChanged.*repaint_mid_credits/);
  });
  it("does not allow history or TOILET edits through the general editor", async () => {
    for (const field of ["last_near_price_change_ns", "toilet_per_cell_second", "paused"]) {
      await expect(prepareTunableChange(async () => tunables(), "board.testnet", tunables(), field, "0", 0n, NOW)).rejects.toThrow(/ReadOnly/);
    }
  });
  it.each([
    ["repaint_base_credits", 0, "RepaintCreditsOutOfRange"],
    ["repaint_base_credits", 3, "RepaintCreditsOutOfOrder"],
    ["repaint_young_ns", 4000000000000, "RepaintTiersOutOfOrder"],
    ["repaint_mid_ns", 86400000000001, "RepaintWindowTooLong"],
    ["mpoo_daily_credit_cap", 1000001, "MpooDailyCapTooHigh"],
    ["reserve_floor", "1", "ReserveFloorTooLow"],
    ["near_price_cooldown_ns", 1, "PriceCooldownTooShort"],
    ["free_first_paints_per_account", 101, "FreeFirstPaintsOutOfRange"],
    ["happy_hour_length_s", 899, "HappyHourLengthOutOfRange"],
    ["happy_hour_length_s", 86401, "HappyHourLengthOutOfRange"],
    ["happy_hour_cap_per_account", 0, "HappyHourCapOutOfRange"],
    ["happy_hour_cap_per_account", 1001, "HappyHourCapOutOfRange"],
    ["happy_hour_weekday", 7, "HappyHourWeekdayOutOfRange"],
    ["happy_hour_start_s", 86400, "HappyHourStartOutOfRange"],
  ])("rejects %s with the contract code", (field, value, code) => {
    expect(() => validateTunables({ ...tunables(), [field]: value }, tunables(), 0n, NOW)).toThrow(code);
  });
  it("checks outstanding credits, price cooldowns, and happy-hour cooldowns", () => {
    expect(() => validateTunables({ ...tunables(), max_outstanding_credits: 4 }, tunables(), 5n, NOW)).toThrow("FloatCapBelowOutstanding");
    const recent = { ...tunables(), last_near_price_change_ns: BigInt(NOW) * 1000000n };
    expect(() => validateTunables({ ...recent, repaint_mid_credits: 3 }, recent, 0n, NOW)).toThrow("RepaintPriceCooldown");
    const happy = { ...tunables(), happy_hour_enabled: true, last_happy_hour_change_ns: BigInt(NOW) * 1000000n };
    expect(() => validateTunables({ ...happy, happy_hour_length_s: 7200 }, happy, 0n, NOW)).toThrow("HappyHourCooldown");
    expect(() => validateTunables({ ...happy, happy_hour_enabled: false }, happy, 0n, NOW)).not.toThrow();
  });
  it("uses the existing cooldown when editing prices, with exact half-to-double limits", () => {
    expect(priceChange("mpoo", "51", "26", tunables(), NOW)).toEqual({ mpoo_per_credit: "26" });
    expect(() => priceChange("mpoo", "51", "25", tunables(), NOW)).toThrow("PriceStepTooLarge");
    expect(() => priceChange("near", "100", "201", tunables(), NOW)).toThrow("PriceStepTooLarge");
    expect(() => priceChange("near", "100", "100", { ...tunables(), last_near_price_change_ns: BigInt(NOW) * 1000000n }, NOW)).toThrow("NearPriceCooldown");
  });
  it("computes the holder discount exactly from tokens per NEAR", () => {
    expect(discountedMpooPrice("1234.567890123456789", "2500000000000000000000")).toBe(2469135780246913578n);
    expect(decimalUnits("0.000000000000000001", 18)).toBe(1n);
    expect(() => decimalUnits("1e3", 18)).toThrow();
    expect(() => decimalUnits("0.0000000000000000001", 18)).toThrow();
  });
  it("uses configured owner only when the owner view is absent, never on RPC failure", async () => {
    const view = async (_: string, method: string) => {
      if (method === "get_owner") throw new Error("MethodNotFound");
      return method === "get_tunables" ? tunables() : {};
    };
    expect((await loadAdmin(view, "board.testnet", "owner.testnet")).owner).toBe("owner.testnet");
    const failed = await loadAdmin(async (a, m) => { if (m === "get_owner") throw new Error("503"); return view(a,m); }, "board.testnet", "owner.testnet");
    expect(failed.owner).toBeNull();
    expect(failed.errors.get_owner).toMatch(/503/);
  });
});
