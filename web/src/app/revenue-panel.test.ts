import { describe, expect, it, vi } from "vitest";
import {
  accountExplorerUrl,
  BURN_ACCOUNT,
  countdown,
  distributeButtonState,
  formatAmount,
  formatExact,
  isMethodNotFound,
  loadRevenue,
  maxGasCostYocto,
  parseRevenueState,
  REVENUE_FIELDS,
  splitMpoo,
  splitNear,
  type ButtonInput,
  type View,
} from "./revenue-panel";

const RAW = {
  withdrawable_near: "12500000000000000000000000",
  mpoo_undistributed: "48250000000000000000000",
  mpoo_staker_reserve: "0",
  next_near_distribution_ns: "0",
  next_mpoo_distribution_ns: "1793000000000000000",
  team_account: "team.metapoo.testnet",
  buyback_account: "buyback.metapoo.testnet",
  staking_contract: null,
  burn_account: BURN_ACCOUNT,
};

describe("formatAmount (exact integer maths)", () => {
  it("formats yocto NEAR without floating point", () => {
    expect(formatAmount(12_500_000_000_000_000_000_000_000n, 24)).toBe("12.5");
    expect(formatAmount("1000000000000000000000000", 24)).toBe("1");
    expect(formatAmount(0n, 24)).toBe("0");
  });
  it("keeps precision beyond Number.MAX_SAFE_INTEGER and groups thousands", () => {
    // 1,234,567.891234 mPOO — the raw value is ~1.2e24, far past 2^53.
    expect(formatAmount(1_234_567_891_234_567_890_123_456n, 18)).toBe("1,234,567.8912");
    expect(formatExact(1_234_567_891_234_567_890_123_456n, 18)).toBe("1,234,567.891234567890123456");
  });
  it("truncates instead of rounding up, and never shows a non-zero amount as 0", () => {
    expect(formatAmount(999_999_999_999_999_999_999_999n, 24)).toBe("0.9999");
    expect(formatAmount(1n, 24)).toBe("< 0.0001");
    expect(formatExact(1n, 24)).toBe("0.000000000000000000000001");
  });
  it("rejects garbage", () => {
    expect(() => formatAmount("1.5", 24)).toThrow();
    expect(() => formatAmount(-1n, 24)).toThrow();
  });
});

describe("splits", () => {
  it("NEAR 10/90 with dust to the buyback", () => {
    expect(splitNear(1_000n)).toEqual({ team: 100n, buyback: 900n });
    expect(splitNear(19n)).toEqual({ team: 1n, buyback: 18n });
  });
  it("mPOO 10/70/20 with dust to the stakers, summing exactly", () => {
    expect(splitMpoo(1_000n)).toEqual({ team: 100n, stakers: 700n, burn: 200n });
    const odd = splitMpoo(19n);
    expect(odd).toEqual({ team: 1n, burn: 3n, stakers: 15n });
    expect(odd.team + odd.burn + odd.stakers).toBe(19n);
  });
  it("gas cap at the minimum gas price", () => {
    expect(formatAmount(maxGasCostYocto("150000000000000"), 24)).toBe("0.015");
  });
});

describe("countdown", () => {
  const now = 1_793_000_000_000; // ms
  const ns = (ms: number): bigint => BigInt(ms) * 1_000_000n;
  it('"0" and past times are due', () => {
    expect(countdown(0n, now)).toEqual({ due: true, label: "now" });
    expect(countdown(ns(now - 1), now).due).toBe(true);
    expect(countdown(ns(now), now).due).toBe(true);
  });
  it("counts down in readable units, rounding seconds up", () => {
    expect(countdown(ns(now) + 1n, now)).toEqual({ due: false, label: "1 s" });
    expect(countdown(ns(now + 12_000), now).label).toBe("12 s");
    expect(countdown(ns(now + (41 * 60 + 7) * 1000), now).label).toBe("41 min 07 s");
    expect(countdown(ns(now + (65 * 60) * 1000), now).label).toBe("1 h 05 min");
    expect(countdown(ns(now + (2 * 86_400 + 3 * 3600) * 1000), now).label).toBe("2 d 3 h");
  });
});

describe("distributeButtonState", () => {
  const base: ButtonInput = {
    due: true, waiting: 5n, accountId: "alice.testnet", walletNetwork: "testnet",
    pageNetwork: "testnet", busy: false, example: false,
  };
  it("is enabled when the interval has passed and a wallet on the right network is connected", () => {
    expect(distributeButtonState(base).enabled).toBe(true);
  });
  it("is disabled before the interval has passed", () => {
    const s = distributeButtonState({ ...base, due: false });
    expect(s.enabled).toBe(false);
    expect(s.hint).toMatch(/Not yet/);
  });
  it("offers Connect instead of a dead button when the only blocker is a wallet", () => {
    const s = distributeButtonState({ ...base, accountId: null, walletNetwork: null });
    // A disabled control that says what you cannot do is the thing C1 removes.
    expect(s.enabled).toBe(true);
    expect(s.connect).toBe(true);
    expect(s.label).toBe("Connect wallet");
    expect(s.hint).toMatch(/Connect a wallet.*Any account/);
    // Nothing waiting is still a real "no": no Connect on an empty split.
    expect(distributeButtonState({ ...base, accountId: null, walletNetwork: null, waiting: 0n }).enabled).toBe(false);
  });
  it("is disabled on a wrong network, with nothing waiting, while busy, and for example data", () => {
    expect(distributeButtonState({ ...base, walletNetwork: "mainnet" }).enabled).toBe(false);
    expect(distributeButtonState({ ...base, waiting: 0n }).enabled).toBe(false);
    expect(distributeButtonState({ ...base, busy: true }).enabled).toBe(false);
    expect(distributeButtonState({ ...base, example: true }).enabled).toBe(false);
  });
});

describe("parseRevenueState (the one place field names live)", () => {
  it("parses the REV-D view", () => {
    const s = parseRevenueState(RAW);
    expect(s.withdrawableNear).toBe(12_500_000_000_000_000_000_000_000n);
    expect(s.nextNearDistributionNs).toBe(0n);
    expect(s.stakingContract).toBeNull();
    expect(s.burnAccount).toBe(BURN_ACCOUNT);
  });
  it("every field name comes from REVENUE_FIELDS", () => {
    for (const key of Object.values(REVENUE_FIELDS)) expect(RAW).toHaveProperty(key);
    // Renaming a contract field breaks parsing with the field named, not silently.
    const { withdrawable_near, ...rest } = RAW;
    expect(() => parseRevenueState({ ...rest, available_near: withdrawable_near })).toThrow(/withdrawable_near/);
  });
  it("rejects floats and bad accounts", () => {
    expect(() => parseRevenueState({ ...RAW, withdrawable_near: 1.5 })).toThrow();
    expect(() => parseRevenueState({ ...RAW, team_account: "Not An Account" })).toThrow(/team_account/);
  });
});

describe("loadRevenue", () => {
  it("treats a board without get_revenue_state as not-yet, not an error", async () => {
    // Exact error text returned by board3.metapoo-player1.testnet at block 275848064.
    const view: View = vi.fn(async () => {
      throw new Error("wasm execution failed with error: MethodResolveError(MethodNotFound)");
    });
    await expect(loadRevenue(view, "board3.metapoo-player1.testnet")).resolves.toEqual({ kind: "not-yet" });
  });
  it("rethrows other failures so they are never shown as zero", async () => {
    const view: View = async () => { throw new Error("RPC HTTP 503"); };
    await expect(loadRevenue(view, "b.testnet")).rejects.toThrow("503");
    expect(isMethodNotFound(new Error("RPC HTTP 503"))).toBe(false);
  });
  it("reads burned mPOO from ft_balance_of(burn) on the configured token", async () => {
    const calls: string[] = [];
    const view: View = async (account, method, args) => {
      calls.push(`${account}.${method}(${JSON.stringify(args ?? {})})`);
      if (method === "get_revenue_state") return RAW;
      if (method === "get_payment_config") return { mpoo_token: "metapoo-mpoo.testnet" };
      if (method === "ft_balance_of") return "7000000000000000000";
      throw new Error("unexpected");
    };
    const snap = await loadRevenue(view, "board.testnet");
    expect(snap).toMatchObject({ kind: "live", burned: 7_000_000_000_000_000_000n, mpooToken: "metapoo-mpoo.testnet" });
    expect(calls).toContain(`metapoo-mpoo.testnet.ft_balance_of({"account_id":"${BURN_ACCOUNT}"})`);
  });
  it("a failed burn read blanks only that figure", async () => {
    const view: View = async (_a, method) => {
      if (method === "get_revenue_state") return RAW;
      throw new Error("down");
    };
    await expect(loadRevenue(view, "board.testnet")).resolves.toMatchObject({ kind: "live", burned: null });
  });
});

describe("accountExplorerUrl", () => {
  it("links nearblocks per network and nothing for mock", () => {
    expect(accountExplorerUrl("testnet", "a.testnet")).toBe("https://testnet.nearblocks.io/address/a.testnet");
    expect(accountExplorerUrl("mainnet", "a.near")).toBe("https://nearblocks.io/address/a.near");
    expect(accountExplorerUrl("mock", "a.testnet")).toBeNull();
  });
});
