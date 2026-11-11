// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { LedgerHistory, LedgerSnapshot } from "./buyback-ledger";
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
    sign: vi.fn(), pollMs: 1e9, ledgerPollMs: 1e9,
    loadLedger: async s => ({ buybackAccount: s.state.buybackAccount, history: null, historyError: null, tried: null, waiting: null }), ...deps,
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
  // C1: due and no wallet is a Connect control, not a dead button.
  expect(t.button("near").disabled).toBe(false);
  expect(t.button("near").textContent).toBe("Connect wallet");
  expect(t.text("near-hint")).toMatch(/Connect a wallet/);
  expect(t.button("mpoo").disabled).toBe(true); // not due
  t.connect({ accountId: "alice.testnet", networkId: "testnet" });
  expect(t.button("near").disabled).toBe(false);
  expect(t.button("near").textContent).toBe("Distribute now");
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


type Live = Extract<RevenueSnapshot, { kind: "live" }>;

const indexHistory = (complete = true): LedgerHistory => ({
  origin: "index", label: "test index",
  totals: { nearToBuyback: 11_250_000_000_000_000_000_000_000n, nearDistributions: 2, mpooReturned: 900_000_000_000_000_000_000n, mpooReturns: 1 },
  complete, transactions: 3, indexedThroughMs: NOW - 5_000,
});
const boardHistory = (): LedgerHistory => ({
  origin: "board", label: "board’s own running totals (get_buyback_totals)",
  totals: { nearToBuyback: 123_456_789_000_000_000_000_000_000n, nearDistributions: null, mpooReturned: 4_000_000_000_000_000_000_000n, mpooReturns: null },
  complete: true, transactions: null, indexedThroughMs: null,
});
const reading = (s: Live, extra: Partial<LedgerSnapshot>): LedgerSnapshot => ({
  buybackAccount: s.state.buybackAccount, history: null, historyError: null, tried: null, waiting: null, ...extra,
});

it("shows exact all-time totals from the board, labelled as from the board", async () => {
  const t = setup({
    load: async () => live(),
    loadLedger: async s => reading(s, { history: boardHistory(), tried: "board", waiting: 2_500_000_000_000_000_000_000_000n }),
  });
  await flush();
  expect(t.text("ledger-near")).toBe("123.4567");
  expect(t.text("ledger-mpoo")).toBe("4,000");
  expect(t.text("ledger-waiting")).toBe("2.5");
  expect(t.text("ledger-near")).not.toMatch(/≥/);
  expect(t.text("ledger-near-note")).toMatch(/^All time/);
  expect(t.text("ledger-source")).toMatch(/^From the board/);
  expect(t.q('[data-rev="ledger-source"]').dataset.origin).toBe("board");
  const link = t.q('[data-rev="ledger-account"] a') as HTMLAnchorElement;
  expect(link.href).toBe("https://testnet.nearblocks.io/address/buyback.metapoo.testnet");
});

it("shows index totals as such, with counts and the 'may be incomplete' note", async () => {
  const t = setup({
    load: async () => live(),
    loadLedger: async s => reading(s, { history: indexHistory(), tried: "index", waiting: 2_500_000_000_000_000_000_000_000n }),
  });
  await flush();
  expect(t.text("ledger-near")).toBe("11.25");
  expect(t.text("ledger-mpoo")).toBe("900");
  expect(t.text("ledger-near-note")).toMatch(/^2 NEAR splits/);
  expect(t.text("ledger-source")).toMatch(/^From the public index, may be incomplete/);
  expect(t.text("ledger-source")).toMatch(/3 board transactions were found through the test index/);
  expect(t.q('[data-rev="ledger-source"]').dataset.origin).toBe("index");
});

it("re-reads the board's totals with every poll, but the index only every ledgerPollMs", async () => {
  let clock = NOW;
  const boardLedger = vi.fn(async (s: Live) => reading(s, { history: boardHistory(), tried: "board" }));
  const b = setup({ load: async () => live(), loadLedger: boardLedger, now: () => clock, pollMs: 30_000, ledgerPollMs: 300_000 });
  await flush();
  clock += 30_000;
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(boardLedger).toHaveBeenCalledTimes(2);
  b.root.remove();

  clock = NOW;
  const indexLedger = vi.fn(async (s: Live) => reading(s, { history: indexHistory(), tried: "index" }));
  setup({ load: async () => live(), loadLedger: indexLedger, now: () => clock, pollMs: 30_000, ledgerPollMs: 300_000 });
  await flush();
  clock += 30_000;
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(indexLedger).toHaveBeenCalledTimes(1);
  clock += 300_000;
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(indexLedger).toHaveBeenCalledTimes(2);
});

it("a ledger read that fails shows Unavailable, never zero, and each figure fails on its own", async () => {
  const t = setup({
    load: async () => live(),
    loadLedger: async s => reading(s, { historyError: "Couldn’t read the board’s buyback totals.", tried: "board", waiting: 0n }),
  });
  await flush();
  expect(t.text("ledger-near")).toBe("Unavailable");
  expect(t.text("ledger-mpoo")).toBe("Unavailable");
  expect(t.text("ledger-waiting")).toBe("0");
  expect(t.text("ledger-source")).toMatch(/board’s buyback totals\. .*unknown, not zero/);
  const t2 = setup({
    load: async () => live(),
    loadLedger: async () => { throw new Error("boom"); },
  });
  await flush();
  expect(t2.text("ledger-near")).toBe("Unavailable");
  expect(t2.text("ledger-waiting")).toBe("Unavailable");
});

it("labels the stakers' 70% by whether the board has a staking contract", async () => {
  const without = setup({ load: async () => live() });
  await flush();
  expect(without.q('[data-rev="flow"]').textContent).toMatch(/held on the board/);
  expect(without.q('[data-rev="flow"]').textContent).not.toMatch(/forwarded to the staking/);

  const withStaking = setup({ load: async () => live({ stakingContract: "staking.metapoo.testnet" }) });
  await flush();
  expect(withStaking.q('[data-rev="flow"]').textContent).toMatch(/forwarded to the staking/);
  expect(withStaking.q('[data-rev="flow"]').textContent).not.toMatch(/held on the board/);
});

it("an incomplete index scan is shown as a lower bound", async () => {
  const t = setup({
    load: async () => live(),
    loadLedger: async s => reading(s, { history: indexHistory(false), tried: "index" }),
  });
  await flush();
  expect(t.text("ledger-near")).toBe("≥ 11.25");
  expect(t.text("ledger-near-note")).toMatch(/^at least 2/);
  expect(t.text("ledger-source")).toMatch(/lower bounds/);
  expect(t.text("ledger-waiting")).toBe("Unavailable");
});

it("shortens the contract id and stamps the read relatively (C7)", async () => {
  const t = setup({ load: async () => live() });
  await flush();
  const source = t.text("source");
  expect(source).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  expect(source).toMatch(/Read live from .+ on testnet/);
  // A 64-character id is shortened; a short one is left alone (shortAccount's rule).
  if (source.length > 90) expect(source).toContain("…");
});
