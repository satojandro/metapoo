// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountAdminPage, type AdminPageDeps } from "./admin-page";
import { tunables } from "./admin-test-fixture";
import type { AdminSnapshot } from "./admin-settings";
import { matchRoute } from "./routes";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import type { WalletSession } from "../wallet";

const OWNER: WalletSession = { accountId: "owner.testnet", networkId: "testnet" };
const snapshot = (): AdminSnapshot => ({ owner: "owner.testnet", ownerFromConfig: false, errors: {}, records: {
  get_tunables: tunables(), get_payment_config: { near_per_credit: "2500000000000000000000", mpoo_per_credit: "2000000000000000000", registration_fee: "10000000000000000000000", mpoo_token: "mpoo.testnet" },
  get_mpoo_sales_today: { sold_today: "2", remaining: "8", cap: "10" },
  get_happy_hour: { first_fill_complete: false, open: false, enabled: false },
  get_revenue_state: { team_account: "team.testnet", buyback_account: "buyback.testnet", staking_contract: null, withdrawable_near: "0", mpoo_undistributed: "0", mpoo_staker_reserve: "0", next_near_distribution_ns: "0", next_mpoo_distribution_ns: "0" },
  get_outstanding_credits: { value: "7" }, get_board: { width: 128, height: 128 },
} });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup(session: WalletSession = { accountId: null, networkId: null }, overrides: Partial<AdminPageDeps> = {}) {
  let current = session;
  let listener = (_: WalletSession) => {};
  const sign = vi.fn(async () => ({ status: { SuccessValue: "" }, transaction: { hash: "testhash" } }));
  const load = vi.fn(async () => snapshot());
  const history = vi.fn(async () => []);
  const balance = vi.fn(async () => 2n * 10n ** 24n);
  const view = vi.fn(async (_a: string, m: string) => m === "get_owner" ? "owner.testnet" : m === "get_outstanding_credits" ? "7" : tunables());
  const root = document.createElement("div"); document.body.append(root);
  const ctx: PageContext = { route: matchRoute("/admin"), navigate: () => {}, services: {
    operations: createOperationsStore(), wallet: { getSession: () => current, subscribe: fn => { listener = fn; return () => {}; },
      connect: async () => {}, disconnect: async () => {}, whenReady: Promise.resolve(current) },
  } };
  const deps = { network: "testnet", board: "board.testnet", configured: true, now: () => 1793000000000,
    load, view, sign, history, balance, pollMs: 1e9, ...overrides };
  const dispose = mountAdminPage(root, ctx, deps);
  cleanup.push(() => { dispose(); root.remove(); });
  return { root, sign, load, history, deps, dispose, connect(next: WalletSession) { current = next; listener(next); } };
}
const click = (root: HTMLElement, selector: string) => (root.querySelector(selector) as HTMLButtonElement).click();

it("shows a visitor one paragraph and a link, with no reads, settings or edit controls", async () => {
  expect(matchRoute("/admin/").pageId).toBe("admin");
  const t = setup(); await flush();
  expect(t.load).not.toHaveBeenCalled();
  expect(t.root.querySelector('[data-admin="visitor"]')?.hasAttribute("hidden")).toBe(false);
  expect(t.root.querySelector('[data-admin="console"]')?.hasAttribute("hidden")).toBe(true);
  expect(t.root.querySelector('a[href="/how-it-works"]')).not.toBeNull();
  expect(t.root.querySelectorAll("[data-edit]").length).toBe(0);
  expect(t.root.querySelector(".admin-table")).toBeNull();
  expect(t.root.textContent).not.toContain("0.0025 NEAR");
});

it("asks search engines not to index the page, and removes the tag on leave", async () => {
  const t = setup(); await flush();
  expect(document.head.querySelector('meta[name="robots"][content*="noindex"]')).not.toBeNull();
  t.dispose();
  expect(document.head.querySelector('meta[data-admin="noindex"]')).toBeNull();
});

it("a connected account that isn't the owner still sees the visitor view", async () => {
  const t = setup({ accountId: "someone.testnet", networkId: "testnet" }); await flush();
  expect(t.load).toHaveBeenCalledTimes(1);
  expect(t.root.querySelector('[data-admin="console"]')?.hasAttribute("hidden")).toBe(true);
  expect(t.root.querySelector(".admin-table")).toBeNull();
  expect(t.history).not.toHaveBeenCalled();
});

it("the owner sees status first, then attention, then the settings", async () => {
  const t = setup(OWNER); await flush();
  const console = t.root.querySelector<HTMLElement>('[data-admin="console"]')!;
  expect(console.hidden).toBe(false);
  expect(t.root.querySelector('[data-status="painting"]')?.textContent).toContain("Live");
  expect(t.root.querySelector('[data-status="mpoo-cap"]')?.textContent).toContain("8 of 10 credits left");
  expect(t.root.querySelector('[data-status="buyback"]')?.textContent).toContain("2 NEAR");
  expect(t.root.querySelector('[data-attention="buyback"]')).not.toBeNull();
  const order = [...console.children].map(el => el.getAttribute("data-admin") ?? el.className);
  expect(order.indexOf("status")).toBeLessThan(order.indexOf("admin-attention"));
  expect(order.indexOf("admin-attention")).toBeLessThan(order.indexOf("groups"));
  expect(t.root.querySelector('[data-edit="mpoo_daily_credit_cap"]')).not.toBeNull();
  // Fixed rules and TOILET are collapsed and read only.
  const details = t.root.querySelector<HTMLDetailsElement>(".admin-readonly")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("[data-edit]")).toBeNull();
});

it("only the owner on the page network sees editing, and disconnect clears a draft", async () => {
  const t = setup({ accountId: "owner.testnet", networkId: "mainnet" }); await flush();
  expect(t.root.querySelector("[data-edit]")).toBeNull();
  t.connect(OWNER);
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  expect(t.root.querySelector(".admin-editor")).not.toBeNull();
  t.connect({ accountId: "someone.testnet", networkId: "testnet" });
  expect(t.root.querySelector(".admin-editor")).toBeNull();
});

it("requires a preview, sends one field, then reads the chain again", async () => {
  const t = setup(OWNER); await flush();
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  // Inline: the editor opens in the row right under the setting.
  const editRow = t.root.querySelector(".admin-editor")!.closest("tr")!;
  expect((editRow.previousElementSibling as HTMLElement).dataset.field).toBe("mpoo_daily_credit_cap");
  const input = t.root.querySelector<HTMLInputElement>(".admin-editor input")!;
  input.value = "20000"; input.dispatchEvent(new Event("input"));
  click(t.root, '[data-admin-action="preview"]'); await flush();
  expect(t.sign).not.toHaveBeenCalled();
  expect(t.root.querySelector('[data-admin="preview"]')?.textContent).toContain("20000");
  click(t.root, '[data-admin-action="confirm"]'); await flush();
  expect(t.sign).toHaveBeenCalledWith(expect.objectContaining({ methodName: "set_tunables", args: { tunables: { ...tunables(), mpoo_daily_credit_cap: 20000 } } }));
  expect(t.load).toHaveBeenCalledTimes(2);
  expect(t.root.textContent).toContain("Confirmed");
});

it("keeps what's typed in the editor when the board refreshes", async () => {
  const t = setup(OWNER); await flush();
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  t.root.querySelector<HTMLInputElement>(".admin-editor input")!.value = "1234";
  click(t.root, '[data-admin-action="refresh"]'); await flush();
  expect(t.root.querySelector<HTMLInputElement>(".admin-editor input")!.value).toBe("1234");
  expect((t.root.querySelector(".admin-editor")!.closest("tr")!.previousElementSibling as HTMLElement).dataset.field).toBe("mpoo_daily_credit_cap");
});

it("fetches history once on load and once after a confirmed change, never on refresh, poll or focus", async () => {
  const t = setup(OWNER); await flush();
  expect(t.history).toHaveBeenCalledTimes(1);
  click(t.root, '[data-admin-action="refresh"]'); await flush();
  window.dispatchEvent(new Event("focus")); await flush();
  expect(t.load.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(t.history).toHaveBeenCalledTimes(1);
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  click(t.root, '[data-admin-action="preview"]'); await flush();
  click(t.root, '[data-admin-action="confirm"]'); await flush();
  expect(t.sign).toHaveBeenCalledTimes(1);
  expect(t.history).toHaveBeenCalledTimes(2);
});

it("stops when a different setting changed since opening the editor", async () => {
  const t = setup(OWNER, { view: async (_a, m) => m === "get_owner" ? "owner.testnet" : m === "get_outstanding_credits" ? "7" : { ...tunables(), repaint_mid_credits: 3 } });
  await flush();
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  click(t.root, '[data-admin-action="preview"]'); await flush();
  click(t.root, '[data-admin-action="confirm"]'); await flush();
  expect(t.sign).not.toHaveBeenCalled();
  expect(t.root.textContent).toContain("SettingsChanged");
});

it("stops when the owner changed since the page loaded", async () => {
  const t = setup(OWNER, { view: async (_a, m) => m === "get_owner" ? "new-owner.testnet" : m === "get_outstanding_credits" ? "7" : tunables() });
  await flush();
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  click(t.root, '[data-admin-action="preview"]'); await flush();
  click(t.root, '[data-admin-action="confirm"]'); await flush();
  expect(t.sign).not.toHaveBeenCalled();
  expect(t.root.textContent).toContain("OwnerChanged");
});

it("Pause now signs with no reads at all, even with the RPC unreachable", async () => {
  const load = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("RPC down"));
  const view = vi.fn(async () => { throw new Error("RPC down"); });
  const t = setup(OWNER, { load, view }); await flush();
  click(t.root, '[data-admin-action="refresh"]'); await flush();
  expect(t.root.textContent).toContain("unavailable");
  const pause = t.root.querySelector<HTMLButtonElement>('[data-admin-action="pause"]')!;
  expect(pause.hidden).toBe(false);
  pause.click(); await flush();
  expect(view).not.toHaveBeenCalled();
  expect(t.sign).toHaveBeenCalledWith({ contractId: "board.testnet", owner: "owner.testnet", methodName: "set_paused", args: { paused: true } });
});

it("Pause now is only for the owner on the page network", async () => {
  const t = setup({ accountId: "owner.testnet", networkId: "mainnet" }); await flush();
  const pause = t.root.querySelector<HTMLButtonElement>('[data-admin-action="pause"]')!;
  expect(pause.closest("[hidden]")).not.toBeNull();
  pause.click(); await flush();
  expect(t.sign).not.toHaveBeenCalled();
});

it("a failed refresh removes live readings and editing instead of displaying cached settings", async () => {
  const load = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("503"));
  const t = setup(OWNER, { load }); await flush();
  click(t.root, '[data-admin-action="refresh"]'); await flush();
  expect(t.root.querySelector("[data-edit]")).toBeNull();
  expect(t.root.textContent).not.toContain("0.0025 NEAR");
  expect(t.root.textContent).toContain("unavailable");
});

it("counts a price cooldown down to Can change now", async () => {
  vi.useFakeTimers();
  let now = 1793000000000;
  const snap = snapshot(); snap.records.get_tunables.last_near_price_change_ns = BigInt(now + 2000) * 1000000n - 86400000000000n;
  const t = setup(OWNER, { load: async () => snap, now: () => now }); await flush();
  const pill = () => t.root.querySelector('[data-field="set_near_price"] .admin-pill')!.textContent;
  expect(pill()).toContain("In 2 s");
  now += 2000; vi.advanceTimersByTime(2000);
  expect(pill()).toBe("Can change now");
});

it("cannot sign after the owner disconnects during the pre-sign re-read", async () => {
  let release!: (value: unknown) => void;
  const t = setup(OWNER, { view: async (_a, m) => m === "get_owner"
    ? new Promise(resolve => { release = resolve; }) : m === "get_outstanding_credits" ? "7" : tunables() });
  await flush();
  click(t.root, '[data-edit="mpoo_daily_credit_cap"]');
  click(t.root, '[data-admin-action="preview"]');
  click(t.root, '[data-admin-action="confirm"]');
  await flush(); t.connect({ accountId: null, networkId: null }); release("owner.testnet"); await flush();
  expect(t.sign).not.toHaveBeenCalled();
});
