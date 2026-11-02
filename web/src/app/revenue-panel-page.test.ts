// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { mountRevenuePage, type RevenuePageDeps } from "./revenue-panel-page";
import { BURN_ACCOUNT, type RevenueSnapshot } from "./revenue-panel";
import { matchRoute } from "./routes";
import type { WalletSession } from "../wallet";

const NOW = 1_793_000_000_000;
const live = (overrides: Partial<Extract<RevenueSnapshot, { kind: "live" }>["state"]> = {}): RevenueSnapshot => ({
  kind: "live",
  state: {
    withdrawableNear: 12_500_000_000_000_000_000_000_000n,
    mpooUndistributed: 1_000_000_000_000_000_000n,
    mpooStakerReserve: 70_000_000_000_000_000_000n,
    nextNearDistributionNs: 0n,
    nextMpooDistributionNs: BigInt(NOW + 90_000) * 1_000_000n,
    teamAccount: "team.metapoo.testnet",
    buybackAccount: "buyback.metapoo.testnet",
    stakingContract: null,
    burnAccount: BURN_ACCOUNT,
    ...overrides,
  },
  mpooToken: "metapoo-mpoo.testnet",
  burned: 20_000_000_000_000_000_000n,
});

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = []; vi.useRealTimers(); });

function setup(deps: Partial<RevenuePageDeps>, session: WalletSession = { accountId: null, networkId: null }) {
  let current = session;
  let listener: (s: WalletSession) => void = () => {};
  const ctx: PageContext = {
    services: {
      wallet: {
        getSession: () => current, connect: async () => {}, disconnect: async () => {},
        subscribe: fn => { listener = fn; return () => {}; }, whenReady: Promise.resolve(current),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/money"),
    navigate: () => {},
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountRevenuePage(root, ctx, {
    now: () => NOW, network: "testnet", contractId: "board.metapoo.testnet", example: false,
    sign: vi.fn(), pollMs: 1e9, ...deps,
  });
  cleanup.push(() => { dispose(); root.remove(); });
  const q = (sel: string) => root.querySelector<HTMLElement>(sel)!;
  return {
    root, q,
    text: (key: string) => q(`[data-rev="${key}"]`).textContent,
    button: (kind: string) => root.querySelector<HTMLButtonElement>(`[data-distribute="${kind}"]`)!,
    connect(next: WalletSession) { current = next; listener(next); },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

it("routes /money to the revenue page", () => {
  expect(matchRoute("/money").pageId).toBe("money");
  expect(matchRoute("/money/").pageId).toBe("money");
});

it("shows live numbers formatted exactly, the split preview and a countdown", async () => {
  const t = setup({ load: async () => live() });
  await flush();
  expect(t.text("near-waiting")).toBe("12.5");
  expect(t.text("near-team")).toBe("1.25");
  expect(t.text("near-buyback")).toBe("11.25");
  expect(t.text("mpoo-stakers")).toBe("0.7");
  expect(t.text("burned")).toBe("20");
  expect(t.text("near-next")).toBe("Ready now");
  expect(t.text("mpoo-next")).toBe("in 1 min 30 s");
  const links = [...t.root.querySelectorAll<HTMLAnchorElement>(".rev-accounts a")].map(a => a.href);
  expect(links).toContain("https://testnet.nearblocks.io/address/team.metapoo.testnet");
  expect(links).toContain(`https://testnet.nearblocks.io/address/${BURN_ACCOUNT}`);
});

it("enables Distribute now only when due and a wallet is connected", async () => {
  const t = setup({ load: async () => live() });
  await flush();
  expect(t.button("near").disabled).toBe(true); // due, but no wallet
  expect(t.text("near-hint")).toMatch(/Connect a wallet/);
  expect(t.button("mpoo").disabled).toBe(true); // not due
  t.connect({ accountId: "alice.testnet", networkId: "testnet" });
  expect(t.button("near").disabled).toBe(false);
  expect(t.button("mpoo").disabled).toBe(true);
  expect(t.text("mpoo-hint")).toMatch(/Not yet/);
});

it("signs distribute_near with no deposit and refreshes afterwards", async () => {
  const load = vi.fn(async () => live());
  const sign = vi.fn(async () => ({ status: { SuccessValue: "" }, transaction: { hash: "TxHash1" } }));
  const t = setup({ load, sign }, { accountId: "alice.testnet", networkId: "testnet" });
  await flush();
  t.button("near").click();
  await flush();
  expect(sign).toHaveBeenCalledWith({ contractId: "board.metapoo.testnet", methodName: "distribute_near", gas: "50000000000000" });
  expect(t.text("near-result")).toMatch(/Sent/);
  expect(load).toHaveBeenCalledTimes(2);
});

it("explains DistributionTooSoon as someone else sending first", async () => {
  const sign = vi.fn(async () => ({
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: DistributionTooSoon" } } } } },
    transaction: { hash: "TxHash2" },
  }));
  const t = setup({ load: async () => live(), sign }, { accountId: "alice.testnet", networkId: "testnet" });
  await flush();
  t.button("near").click();
  await flush();
  expect(t.text("near-result")).toMatch(/Someone else sent it first/);
});

it("an old board shows the friendly not-yet state, not an error", async () => {
  const t = setup({ load: async () => ({ kind: "not-yet" }) });
  await flush();
  expect(t.q('[data-rev="notice"]').hidden).toBe(false);
  expect(t.text("notice")).toMatch(/Revenue sharing starts with the next board version/);
  expect(t.text("notice")).not.toMatch(/error|couldn/i);
  expect(t.q('[data-rev="live"]').hidden).toBe(true);
  // The split is still explained.
  expect(t.root.textContent).toMatch(/70% TOILET stakers/);
});

it("a failed read is unknown, never zero, and can be retried", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue(live());
  const t = setup({ load });
  await flush();
  expect(t.text("notice")).toMatch(/unknown, not zero/);
  expect(t.q('[data-rev="live"]').hidden).toBe(true);
  t.q('[data-rev="notice"] button').click();
  await flush();
  expect(t.q('[data-rev="live"]').hidden).toBe(false);
});

it("labels example numbers in mock mode and never offers to send", async () => {
  const t = setup({ example: true, load: async () => live() }, { accountId: "alice.testnet", networkId: "testnet" });
  await flush();
  expect(t.text("source")).toMatch(/Example numbers/);
  expect(t.button("near").disabled).toBe(true);
});
