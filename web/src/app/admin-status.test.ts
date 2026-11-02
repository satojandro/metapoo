import { describe, expect, it } from "vitest";
import { attentionItems, BUYBACK_ATTENTION_YOCTO, statusItems, type ConsoleInput } from "./admin-status";
import { tunables } from "./admin-test-fixture";
import type { AdminSnapshot } from "./admin-settings";

const NOW = 1793000000000;
const NOW_NS = BigInt(NOW) * 1_000_000n;
const HOUR_NS = 3_600_000_000_000n;

function snap(patch: Partial<AdminSnapshot["records"]> = {}, errors: Record<string, string> = {}): AdminSnapshot {
  return { owner: "owner.testnet", ownerFromConfig: false, errors, records: {
    get_tunables: tunables(),
    get_mpoo_sales_today: { sold_today: "0", remaining: "100", cap: "100" },
    get_happy_hour: { first_fill_complete: false, open: false, enabled: false },
    get_revenue_state: { buyback_account: "buyback.testnet", staking_contract: null, withdrawable_near: "0", mpoo_undistributed: "0", mpoo_staker_reserve: "0", next_near_distribution_ns: "0", next_mpoo_distribution_ns: "0" },
    ...patch,
  } };
}
const input = (snapshot: AdminSnapshot, buybackYocto: bigint | null | undefined = 0n): ConsoleInput => ({ snapshot, nowMs: NOW, buybackYocto });
const ids = (i: ConsoleInput) => attentionItems(i).map(a => a.id);

describe("status strip", () => {
  it("reports each reading, and a missing read as unavailable rather than zero", () => {
    const s = snap(); delete s.records.get_mpoo_sales_today;
    const items = Object.fromEntries(statusItems(input(s, null)).map(i => [i.id, i]));
    expect(items.painting.value).toBe("Live");
    expect(items["near-price"].value).toBe("Can change now");
    expect(items["mpoo-cap"].value).toBe("Unavailable");
    expect(items.buyback.value).toBe("Unavailable");
    expect(items["happy-hour"].value).toBe("Off · wall still filling");
  });
  it("shows a paused board as bad and a running cooldown as a countdown", () => {
    const t = { ...tunables(), paused: true, last_near_price_change_ns: NOW_NS - HOUR_NS };
    const items = Object.fromEntries(statusItems(input(snap({ get_tunables: t }))).map(i => [i.id, i]));
    expect(items.painting).toMatchObject({ value: "Paused", tone: "bad" });
    expect(items["near-price"].value).toBe("In 23 h 00 min");
  });
  it("says reading while the buyback balance hasn't arrived", () => {
    expect(statusItems({ snapshot: snap(), nowMs: NOW, buybackYocto: undefined }).find(i => i.id === "buyback")?.value).toBe("Reading…");
  });
});

describe("needs attention", () => {
  it("is empty when all is well", () => {
    expect(attentionItems(input(snap()))).toEqual([]);
  });
  it("puts a paused board first", () => {
    const i = input(snap({ get_tunables: { ...tunables(), paused: true }, get_mpoo_sales_today: { remaining: "5", cap: "100" } }));
    expect(ids(i)).toEqual(["paused", "mpoo-cap"]);
  });
  it("flags the mPOO cap at 10% left, not before", () => {
    expect(ids(input(snap({ get_mpoo_sales_today: { remaining: "11", cap: "100" } })))).toEqual([]);
    expect(ids(input(snap({ get_mpoo_sales_today: { remaining: "10", cap: "100" } })))).toEqual(["mpoo-cap"]);
    expect(ids(input(snap({ get_mpoo_sales_today: { remaining: "0", cap: "0" } })))).toEqual([]);
  });
  it("flags NEAR waiting on the buyback account from 1 NEAR", () => {
    expect(ids(input(snap(), BUYBACK_ATTENTION_YOCTO - 1n))).toEqual([]);
    expect(ids(input(snap(), BUYBACK_ATTENTION_YOCTO))).toEqual(["buyback"]);
    expect(ids(input(snap(), null))).toEqual([]);
  });
  it("flags a split more than two hours late with money waiting", () => {
    const rev = (next: bigint, waiting: string) => snap({ get_revenue_state: { ...snap().records.get_revenue_state, next_near_distribution_ns: next.toString(), withdrawable_near: waiting } });
    expect(ids(input(rev(NOW_NS - 3n * HOUR_NS, "5")))).toEqual(["near-overdue"]);
    expect(ids(input(rev(NOW_NS - 1n * HOUR_NS, "5")))).toEqual([]);
    expect(ids(input(rev(NOW_NS - 3n * HOUR_NS, "0")))).toEqual([]);
  });
  it("mentions failed reads, a configured owner, and a locked staker reserve", () => {
    const s = snap({ get_revenue_state: { ...snap().records.get_revenue_state, mpoo_staker_reserve: "7" } }, { get_board: "503", get_owner: "MethodNotFound" });
    s.ownerFromConfig = true;
    expect(ids(input(s))).toEqual(["reads", "owner", "staking"]);
    expect(attentionItems(input(s))[0].text).toContain("get_board");
  });
  it("says a price can change again only after it has changed once", () => {
    const changed = { ...tunables(), last_near_price_change_ns: NOW_NS - 25n * HOUR_NS };
    expect(ids(input(snap({ get_tunables: changed })))).toEqual(["near-ready"]);
  });
});
