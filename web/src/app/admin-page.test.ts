// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountAdminPage, type AdminPageDeps } from "./admin-page";
import { tunables } from "./admin-test-fixture";
import type { AdminSnapshot } from "./admin-settings";
import { matchRoute } from "./routes";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import type { WalletSession } from "../wallet";

const snapshot = (): AdminSnapshot => ({ owner: "owner.testnet", ownerFromConfig: false, errors: {}, records: {
  get_tunables: tunables(), get_payment_config: { near_per_credit: "2500000000000000000000", mpoo_per_credit: "2000000000000000000", registration_fee: "10000000000000000000000", mpoo_token: "mpoo.testnet" },
  get_mpoo_sales_today: { sold_today: "2", remaining: "8", cap: "10" },
  get_happy_hour: { first_fill_complete: false, open: false, enabled: false },
  get_revenue_state: { team_account: "team.testnet", buyback_account: "buyback.testnet", staking_contract: null, withdrawable_near: "0", mpoo_undistributed: "0", mpoo_staker_reserve: "0", next_near_distribution_ns: "0", next_mpoo_distribution_ns: "0" },
  get_outstanding_credits: { value: "7" }, get_board: { width: 128, height: 128 },
} });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
function setup(session: WalletSession = { accountId: null, networkId: null }, overrides: Partial<AdminPageDeps> = {}) {
  let current = session;
  let listener = (_: WalletSession) => {};
  const sign = vi.fn(async () => ({ status: { SuccessValue: "" }, transaction: { hash: "testhash" } }));
  const load = vi.fn(async () => snapshot());
  const root = document.createElement("div"); document.body.append(root);
  const ctx: PageContext = { route: matchRoute("/admin"), navigate: () => {}, services: {
    operations: createOperationsStore(), wallet: { getSession: () => current, subscribe: fn => { listener=fn; return () => {}; },
      connect: async () => {}, disconnect: async () => {}, whenReady: Promise.resolve(current) },
  } };
  const dispose = mountAdminPage(root, ctx, { network: "testnet", board: "board.testnet", configured: true, now: () => 1793000000000,
    load, view: async (_a,m) => m === "get_owner" ? "owner.testnet" : m === "get_outstanding_credits" ? "7" : tunables(), sign,
    history: async () => [], pollMs: 1e9, ...overrides });
  cleanup.push(() => { dispose(); root.remove(); });
  return { root, sign, load, connect(next: WalletSession) { current=next; listener(next); } };
}
it("routes /admin and shows the settings to a visitor without edit controls", async () => {
  expect(matchRoute("/admin/").pageId).toBe("admin");
  const t=setup(); await flush();
  expect(t.root.textContent).toContain("0.0025 NEAR");
  expect(t.root.querySelectorAll("[data-edit]").length).toBe(0);
  expect(t.root.querySelectorAll(".admin-group").length).toBe(9);
});
it("only the owner on the page network sees editing, and disconnect clears a draft", async () => {
  const t=setup({ accountId: "owner.testnet", networkId: "mainnet" }); await flush();
  expect(t.root.querySelector("[data-edit]")).toBeNull();
  t.connect({ accountId: "owner.testnet", networkId: "testnet" });
  (t.root.querySelector('[data-edit="mpoo_daily_credit_cap"]') as HTMLButtonElement).click();
  expect(t.root.querySelector(".admin-editor")).not.toBeNull();
  t.connect({ accountId: "someone.testnet", networkId: "testnet" });
  expect(t.root.querySelector(".admin-editor")).toBeNull();
});
it("requires a preview, sends one field, then reads the chain again", async () => {
  const t=setup({ accountId: "owner.testnet", networkId: "testnet" }); await flush();
  (t.root.querySelector('[data-edit="mpoo_daily_credit_cap"]') as HTMLButtonElement).click();
  const input=t.root.querySelector<HTMLInputElement>(".admin-editor input")!;
  input.value="20000"; input.dispatchEvent(new Event("input"));
  (t.root.querySelector('[data-admin-action="preview"]') as HTMLButtonElement).click(); await flush();
  expect(t.sign).not.toHaveBeenCalled();
  expect(t.root.querySelector('[data-admin="preview"]')?.textContent).toContain("20000");
  (t.root.querySelector('[data-admin-action="confirm"]') as HTMLButtonElement).click(); await flush();
  expect(t.sign).toHaveBeenCalledWith(expect.objectContaining({ methodName: "set_tunables", args: { tunables: { ...tunables(), mpoo_daily_credit_cap: 20000 } } }));
  expect(t.load).toHaveBeenCalledTimes(2);
  expect(t.root.textContent).toContain("Confirmed");
});
it("stops when a different setting changed since opening the editor", async () => {
  const t=setup({ accountId: "owner.testnet", networkId: "testnet" }, { view: async (_a,m) => m === "get_owner" ? "owner.testnet" : m === "get_outstanding_credits" ? "7" : { ...tunables(), repaint_mid_credits: 3 } });
  await flush();
  (t.root.querySelector('[data-edit="mpoo_daily_credit_cap"]') as HTMLButtonElement).click();
  (t.root.querySelector('[data-admin-action="preview"]') as HTMLButtonElement).click(); await flush();
  (t.root.querySelector('[data-admin-action="confirm"]') as HTMLButtonElement).click(); await flush();
  expect(t.sign).not.toHaveBeenCalled();
  expect(t.root.textContent).toContain("SettingsChanged");
});
it("a failed refresh removes live readings and editing instead of displaying cached settings", async () => {
  const load=vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("503"));
  const t=setup({ accountId: "owner.testnet", networkId: "testnet" }, { load }); await flush();
  (t.root.querySelector('[data-admin-action="refresh"]') as HTMLButtonElement).click(); await flush();
  expect(t.root.querySelector("[data-edit]")).toBeNull();
  expect(t.root.textContent).not.toContain("0.0025 NEAR");
  expect(t.root.textContent).toContain("unavailable");
});
it("counts a price cooldown down to Ready now", async () => {
  vi.useFakeTimers();
  let now=1793000000000;
  const snap=snapshot(); snap.records.get_tunables.last_near_price_change_ns=BigInt(now+2000)*1000000n-86400000000000n;
  const t=setup(undefined,{load:async()=>snap,now:()=>now}); await flush();
  const pill=()=>t.root.querySelector('[data-field="set_near_price"] .admin-pill')!.textContent;
  expect(pill()).toContain("Ready in 2 s");
  now+=2000; vi.advanceTimersByTime(2000);
  expect(pill()).toBe("Ready now");
});
it("cannot sign after the owner disconnects during the pre-sign re-read", async()=>{
  let release!: (value: unknown)=>void;
  const t=setup({accountId:"owner.testnet",networkId:"testnet"},{view:async(_a,m)=>m==="get_owner"
    ? new Promise(resolve=>{release=resolve;}) : m==="get_outstanding_credits" ? "7" : tunables()});
  await flush();
  (t.root.querySelector('[data-edit="mpoo_daily_credit_cap"]') as HTMLButtonElement).click();
  (t.root.querySelector('[data-admin-action="preview"]') as HTMLButtonElement).click();
  (t.root.querySelector('[data-admin-action="confirm"]') as HTMLButtonElement).click();
  await flush(); t.connect({accountId:null,networkId:null}); release("owner.testnet"); await flush();
  expect(t.sign).not.toHaveBeenCalled();
});
