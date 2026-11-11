import { describe, expect, it } from "vitest";
import {
  claimButtonState, earnOutcome, EMPTY_PAGE, loadToilet, loadToiletPage, mintRefused, parseEmission, perCellDay,
  stakeOutcome, wallTiles, whaleOutcome, yearsAtRate, type ClaimInput,
} from "./toilet";
import type { View } from "./revenue-panel";

const EMISSION = { per_cell_second: "1000000000000000", accrued_total: "2811920392020247000000", cap: "1000000000000000000000000000", remaining: "999997188079607979753000000" };
const SUPPLY = { cap: "1", total_supply: "1204196097794000000", issued_total: "1204196097794000000", burned_total: "0", tax_burned_total: "0", tax_treasury_total: "0", remaining_issuable: "1" };

function view(overrides: Record<string, unknown> = {}): View & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (account: string, method: string, args?: Record<string, unknown>) => {
    calls.push(`${account}.${method}`);
    // Mirror the contract: `get_pending_toilet(account)` deserializes a field named `account` and
    // panics on anything else. A mock that ignores args hid exactly that mismatch once already.
    if (method === "get_pending_toilet" && !(args && Object.hasOwn(args, "account")))
      throw new Error("Failed to deserialize input from JSON. Error: missing field `account`");
    const table: Record<string, unknown> = {
      get_toilet_emission: EMISSION, get_supply_info: SUPPLY, is_paused: false,
      get_pending_toilet: "195000000000000000", ft_balance_of: "780000000000000000", ...overrides,
    };
    const value = table[method];
    if (value instanceof Error) throw value;
    return value;
  }) as View & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("parseEmission", () => {
  it("reads the live testnet shape exactly", () => {
    const e = parseEmission(EMISSION);
    expect(e.perCellSecond).toBe(1_000_000_000_000_000n);
    expect(perCellDay(e)).toBe(86_400_000_000_000_000_000n);
  });
  it("refuses floats and missing fields rather than guessing", () => {
    expect(() => parseEmission({ ...EMISSION, cap: 1e27 })).toThrow(/cap/);
    expect(() => parseEmission(null)).toThrow();
  });
});

describe("loadToilet", () => {
  it("asks the board for pending with the contract's `account` field, not `account_id`", async () => {
    const base = view();
    const seen: Array<Record<string, unknown>> = [];
    const spy: View = async (account, method, args) => {
      if (args) seen.push({ [method]: args });
      return base(account, method, args);
    };
    await loadToilet(spy, "board.testnet", "toilet.testnet", "alice.testnet");
    expect(seen.find((entry) => "get_pending_toilet" in entry)?.get_pending_toilet).toEqual({ account: "alice.testnet" });
    // ft_balance_of is NEP-141: its argument really is `account_id`.
    expect(seen.find((entry) => "ft_balance_of" in entry)?.ft_balance_of).toEqual({ account_id: "alice.testnet" });
  });
  it("reads board, token and account", async () => {
    const s = await loadToilet(view(), "board.testnet", "toilet.testnet", "alice.testnet");
    expect(s.kind).toBe("live");
    if (s.kind !== "live") return;
    expect(s.account).toEqual({ balance: 780_000_000_000_000_000n, pending: 195_000_000_000_000_000n });
    expect(s.supply?.burnedTotal).toBe(0n);
    expect(s.paused).toBe(false);
  });
  it("treats an old board without emission as not-yet", async () => {
    const s = await loadToilet(view({ get_toilet_emission: new Error("MethodNotFound") }), "b", "t", null);
    expect(s).toEqual({ kind: "not-yet" });
  });
  it("throws when the board read itself fails", async () => {
    await expect(loadToilet(view({ get_toilet_emission: new Error("timeout") }), "b", "t", null)).rejects.toThrow("timeout");
  });
  it("keeps board figures when the token or account reads fail", async () => {
    const s = await loadToilet(view({ get_supply_info: new Error("x"), ft_balance_of: new Error("x") }), "b", "t", "a.testnet");
    if (s.kind !== "live") throw new Error("expected live");
    expect(s.supply).toBeNull();
    expect(s.account).toBeNull();
    expect(s.accountFailed).toBe(true);
  });
  it("skips account reads when signed out and token reads without a token", async () => {
    const v = view();
    const s = await loadToilet(v, "b", "", null);
    if (s.kind !== "live") throw new Error("expected live");
    expect(s.account).toBeNull();
    expect(s.accountFailed).toBe(false);
    expect(v.calls).toEqual(["b.get_toilet_emission"]);
  });
});

describe("claimButtonState", () => {
  const ready: ClaimInput = {
    pending: 2n * 10n ** 18n, accountId: "a.testnet", walletNetwork: "testnet", pageNetwork: "testnet",
    toilet: "t.testnet", paused: false, busy: false, example: false,
  };
  it("enables only when everything lines up", () => {
    const s = claimButtonState(ready);
    expect(s.enabled).toBe(true);
    // Chain jargon (yoctoNEAR, gas, signing) belongs in Technical details, not here.
    expect(s.hint).toBe("One approval in your wallet, plus a small network fee.");
  });
  it("explains the board's 1.00 TOILET floor instead of inviting a ClaimBelowMinimum failure", () => {
    const s = claimButtonState({ ...ready, pending: 195_000_000_000_000_000n });
    expect(s.enabled).toBe(false);
    expect(s.hint).toMatch(/0\.19 of 1\.00 TOILET/);
    expect(claimButtonState({ ...ready, pending: 999_999_999_999_999_999n }).enabled).toBe(false);
    expect(claimButtonState({ ...ready, pending: 1_000_000_000_000_000_000n }).enabled).toBe(true);
  });
  it.each<[Partial<ClaimInput>, RegExp]>([
    [{ example: true }, /Example/],
    [{ toilet: "" }, /token address/],
    [{ busy: true }, /wallet/],
    [{ walletNetwork: "mainnet" }, /Switch your wallet to testnet/],
    [{ paused: true }, /paused/],
    [{ pending: null }, /Couldn’t read/],
    [{ pending: 0n }, /Nothing to claim/],
  ])("stays disabled for %o", (change, hint) => {
    const s = claimButtonState({ ...ready, ...change });
    expect(s.enabled).toBe(false);
    expect(s.hint).toMatch(hint);
  });
  it("offers Connect instead of a dead Claim button when signed out (UI review C1)", () => {
    const s = claimButtonState({ ...ready, accountId: null });
    expect(s.enabled).toBe(true);
    expect(s.connect).toBe(true);
    expect(s.label).toBe("Connect wallet");
    expect(s.hint).toMatch(/Connect a wallet/);
  });
});

describe("mintRefused", () => {
  it("finds the board's claim_failed event in any receipt log", () => {
    const log = 'EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"claim_failed","data":[{}]}';
    expect(mintRefused({ receipts_outcome: [{ outcome: { logs: ["x", log] } }] })).toBe(true);
    expect(mintRefused({ receipts_outcome: [{ outcome: { logs: [log.replace("claim_failed", "toilet_claimed")] } }] })).toBe(false);
    expect(mintRefused(null)).toBe(false);
  });
});

describe("loadToiletPage", () => {
  it("reads emission, supply, reserve, price and tiers", async () => {
    const tiers = { repaint_young_ns: 600, repaint_mid_ns: 3600, repaint_young_credits: 4, repaint_mid_credits: 2, repaint_base_credits: 1 };
    const revenue = {
      withdrawable_near: "0", mpoo_undistributed: "0", mpoo_staker_reserve: "70", next_near_distribution_ns: "0",
      next_mpoo_distribution_ns: "0", team_account: "team.testnet", buyback_account: "buy.testnet", staking_contract: null,
    };
    const s = await loadToiletPage(view({
      get_revenue_state: revenue, get_payment_config: { near_per_credit: "2500000000000000000000", mpoo_token: "m.testnet" },
      get_tunables: tiers,
    }), "b", "t");
    expect(s.emission?.perCellSecond).toBe(1_000_000_000_000_000n);
    expect(s.reserve).toBe(70n);
    expect(s.stakingContract).toBeNull();
    expect(s.nearPerCredit).toBe(2_500_000_000_000_000_000_000n);
    expect(s.tiers?.repaint_young_credits).toBe(4);
  });
  it("never throws: every failed read is simply unknown", async () => {
    const fail = new Error("down");
    const s = await loadToiletPage(view({ get_toilet_emission: fail, get_revenue_state: fail, get_payment_config: fail, get_tunables: fail }), "b", "t");
    expect(s).toEqual(EMPTY_PAGE);
  });
});

describe("explorers", () => {
  it("earnings: a 4-year pace on a full wall mints 25% a year", () => {
    const r = earnOutcome({ years: 4, held: 24, hours: 12, painted: wallTiles() });
    expect(r.mintedPct).toBeCloseTo(25);
    expect(r.runYears).toBeCloseTo(4);
    expect(r.tone).toBe("warn");
    expect(r.you).toBeCloseTo(24 * r.perTileDay / 2);
    expect(earnOutcome({ years: 1, held: 1, hours: 24, painted: wallTiles() }).tone).toBe("bad");
    expect(earnOutcome({ years: 10, held: 1, hours: 24, painted: wallTiles() }).tone).toBe("good");
  });
  it("turns the board's rate into a pace, and a zero rate into none", () => {
    // 0.001 TOILET per tile per second on a full wall: 1e9 / (86.4 × 365 × 16384) ≈ 1.94 years.
    expect(yearsAtRate(1_000_000_000_000_000n)).toBeCloseTo(1.935, 2);
    expect(yearsAtRate(0n)).toBeNull();
  });
  it("whale: matches the draft at launch prices", () => {
    const r = whaleOutcome({ whaleTiles: 4096, players: 100, nearPerCredit: 0.0025, wetCredits: 4, dryCredits: 1 });
    expect(r.share).toBe(0.25);
    expect(r.answerNear).toBeCloseTo(32);
    expect(r.pokeNear).toBeCloseTo(8);
    expect(r.stakersNear).toBeCloseTo(25.2);
  });
  it("staking: the pool settles at ten days of inflow", () => {
    const r = stakeOutcome(100, 0.01);
    expect(r.pool).toBeCloseTo(90);
    expect(r.you).toBeCloseTo(0.63);
    expect(r.flushed).toBeCloseTo(18);
  });
});
