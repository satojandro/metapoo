import { describe, expect, it } from "vitest";
import type { View } from "./revenue-panel";
import {
  claimRewardsState, exitTax, hasEvent, loadStaking, lockState, parseAmount, sharePpm, shareText, stakeRefused,
  todaysCut, unitsToInput, unlockState, type ActionInput, type StakingAccount,
} from "./staking";

const E18 = 10n ** 18n;
// Live testnet shapes, read 3 Nov 2026.
const CONFIG = {
  toilet: "toilet3.metapoo-player1.testnet", mpoo: "metapoo-mpoo.testnet", board: "board5.metapoo-player1.testnet",
  burn_account: "0".repeat(64), drip_bps: 1000, exit_tax_bps: 1000, day_ns: "86400000000000",
  acc_scale: "100000000000", storage_min: "1610000000000000000000",
};
const POOL = { pool: "10000000000000000000000", released_total: "0", total_staked: "1000000000000000000", last_release_ns: "1", burn_pending: "0", burned_total: "0" };
const REVENUE = {
  withdrawable_near: "0", mpoo_undistributed: "0", mpoo_staker_reserve: "5", next_near_distribution_ns: "0",
  next_mpoo_distribution_ns: "0", team_account: "team.testnet", buyback_account: "buy.testnet",
  staking_contract: "staking.metapoo-player1.testnet", burn_account: "0".repeat(64),
};

function view(over: Record<string, unknown> = {}): View {
  return async (_account, method) => {
    const table: Record<string, unknown> = {
      get_revenue_state: REVENUE, get_payment_config: { mpoo_token: "metapoo-mpoo.testnet" }, get_config: CONFIG, get_pool: POOL,
      get_staker: { registered: true, staked: "1000000000000000000", pending_rewards: "3951437251200000000" },
      ft_balance_of: "780000000000000000", storage_balance_of: { total: "1", available: "0" },
      storage_balance_bounds: { min: "1250000000000000000000", max: null }, ...over,
    };
    const v = table[method];
    if (v instanceof Error) throw v;
    return v;
  };
}

describe("loadStaking", () => {
  it("finds the staking contract through the board and its tokens through get_config", async () => {
    const s = await loadStaking(view(), "board5.metapoo-player1.testnet", "alice.testnet");
    if (s.kind !== "live") throw new Error(s.kind);
    expect(s.staking).toBe("staking.metapoo-player1.testnet");
    expect(s.config.toilet).toBe("toilet3.metapoo-player1.testnet");
    expect(s.config.exitTaxBps).toBe(1000);
    expect(s.pool.pool).toBe(10_000n * E18);
    expect(s.boardReserve).toBe(5n);
    expect(s.account).toMatchObject({ wallet: 780n * E18 / 1000n, registered: true, staked: E18, mpooRegistered: true });
  });
  it("reads the reserve from the board that feeds the pool, not the page's board", async () => {
    const seen: string[] = [];
    const base = view();
    const spy: View = async (account, method, args) => { if (method === "get_revenue_state") seen.push(account); return base(account, method, args); };
    const s = await loadStaking(spy, "board3.metapoo-player1.testnet", null);
    expect(s.kind).toBe("live");
    expect(seen).toEqual(["board3.metapoo-player1.testnet", "board5.metapoo-player1.testnet"]);
  });
  it("is not-set when the board names no staking contract", async () => {
    expect(await loadStaking(view({ get_revenue_state: { ...REVENUE, staking_contract: null } }), "b", null)).toEqual({ kind: "not-set" });
  });
  it("is not-live when the named account has no contract", async () => {
    const s = await loadStaking(view({ get_config: new Error("CodeDoesNotExist") }), "b", null);
    expect(s).toEqual({ kind: "not-live", staking: "staking.metapoo-player1.testnet" });
  });
  it("keeps the pool when only the account reads fail", async () => {
    const s = await loadStaking(view({ get_staker: new Error("rpc") }), "b", "alice.testnet");
    if (s.kind !== "live") throw new Error(s.kind);
    expect(s.account).toBeNull();
    expect(s.accountFailed).toBe(true);
  });
  it("sees an account the mPOO token doesn't know yet", async () => {
    const s = await loadStaking(view({ storage_balance_of: null }), "b", "alice.testnet");
    if (s.kind !== "live") throw new Error(s.kind);
    expect(s.account?.mpooRegistered).toBe(false);
    expect(s.account?.mpooStorageMin).toBe(1_250_000_000_000_000_000_000n);
  });
});

describe("arithmetic mirrors the contract", () => {
  it("exit tax rounds down and adds back up exactly", () => {
    expect(exitTax(4000n * E18, 1000)).toEqual({ tax: 400n * E18, net: 3600n * E18 });
    expect(exitTax(9n, 1000)).toEqual({ tax: 0n, net: 9n });
    const odd = exitTax(12_345n, 1000);
    expect(odd.tax + odd.net).toBe(12_345n);
    expect(odd.tax).toBe(1_234n);
  });
  it("share and today's cut", () => {
    expect(sharePpm(1n, 4n)).toBe(250_000);
    expect(shareText(250_000)).toBe("25%");
    expect(shareText(2_400)).toBe("0.24%");
    expect(shareText(50)).toBe("< 0.01%");
    expect(shareText(0)).toBe("0%");
    expect(todaysCut(10_000n * E18, 1000, 1n, 4n)).toBe(250n * E18);
    expect(todaysCut(10_000n * E18, 1000, 0n, 0n)).toBe(0n);
  });
  it("parses typed amounts without floating point", () => {
    expect(parseAmount("12.5")).toBe(12_500_000_000_000_000_000n);
    expect(parseAmount("1,000")).toBe(1000n * E18);
    expect(parseAmount(".000000000000000001")).toBe(1n);
    expect(parseAmount("0.0000000000000000001")).toBeNull();
    for (const bad of ["", ".", "0", "-1", "1e3", "abc"]) expect(parseAmount(bad)).toBeNull();
    expect(unitsToInput(12_500_000_000_000_000_000n)).toBe("12.5");
    expect(parseAmount(unitsToInput(123_456_789_012_345_678_901n))).toBe(123_456_789_012_345_678_901n);
  });
});

describe("buttons", () => {
  const base: ActionInput = { accountId: "a.testnet", walletNetwork: "testnet", pageNetwork: "testnet", busy: false, live: true };
  const acct = (o: Partial<StakingAccount> = {}): StakingAccount => ({
    wallet: 10n * E18, registered: true, staked: 5n * E18, pendingRewards: 1n, mpooRegistered: true, mpooStorageMin: 1n, ...o,
  });
  it("lock: amount within the wallet, and a two-step note for a first lock", () => {
    expect(lockState({ ...base, amount: 2n * E18, account: acct(), storageMin: 1n }).enabled).toBe(true);
    expect(lockState({ ...base, amount: 11n * E18, account: acct(), storageMin: 1n }).label).toBe("Not enough TOILET");
    expect(lockState({ ...base, amount: E18, account: acct({ registered: false }), storageMin: 1n }).hint).toMatch(/two transactions/);
    expect(lockState({ ...base, amount: E18, account: acct({ wallet: 0n }), storageMin: 1n }).hint).toMatch(/no TOILET yet/);
    expect(lockState({ ...base, accountId: null, amount: E18, account: null, storageMin: 1n }).hint).toMatch(/Connect/);
    expect(lockState({ ...base, live: false, amount: E18, account: acct(), storageMin: 1n }).enabled).toBe(false);
  });
  it("unlock: names the burn on the button before signing", () => {
    const s = unlockState({ ...base, amount: 4n * E18, account: acct(), exitTaxBps: 1000 });
    expect(s.enabled).toBe(true);
    expect(s.label).toBe("Unlock and burn 0.4 TOILET");
    expect(unlockState({ ...base, amount: 6n * E18, account: acct(), exitTaxBps: 1000 }).enabled).toBe(false);
    expect(unlockState({ ...base, amount: E18, account: acct({ staked: 0n }), exitTaxBps: 1000 }).hint).toMatch(/nothing locked/);
  });
  it("claim mPOO: needs something released, and registers with mPOO first if needed", () => {
    expect(claimRewardsState({ ...base, account: acct() }).enabled).toBe(true);
    expect(claimRewardsState({ ...base, account: acct({ pendingRewards: 0n }) }).enabled).toBe(false);
    expect(claimRewardsState({ ...base, account: acct({ mpooRegistered: false }) }).hint).toMatch(/registers you with the mPOO token/);
    expect(claimRewardsState({ ...base, account: acct({ mpooRegistered: false, mpooStorageMin: null }) }).enabled).toBe(false);
  });
});

describe("outcomes", () => {
  it("spots contract events and a refunded stake in receipt logs", () => {
    const ev = (name: string) => `EVENT_JSON:{"standard":"toilet_staking","version":"1.0.0","event":"${name}","data":{}}`;
    expect(hasEvent({ receipts_outcome: [{ outcome: { logs: [ev("claim_failed")] } }] }, ["claim_failed"])).toBe(true);
    expect(hasEvent({ receipts_outcome: [{ outcome: { logs: [ev("rewards_claimed")] } }] }, ["claim_failed"])).toBe(false);
    expect(stakeRefused({ receipts_outcome: [{ outcome: { logs: ["stake_refused: NotRegistered"] } }] })).toBe(true);
    expect(stakeRefused({ receipts_outcome: [{ outcome: { logs: [ev("staked")] } }] })).toBe(false);
  });
});
