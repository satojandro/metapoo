// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountStakePage, type StakePageDeps } from "./stake-page";
import type { StakingAccount, StakingSnapshot } from "./staking";
import type { WalletSession } from "../wallet";

const E18 = 10n ** 18n;
const acct = (o: Partial<StakingAccount> = {}): StakingAccount => ({
  wallet: 12_480n * E18, registered: true, staked: 10_000n * E18, pendingRewards: 1_482n * E18,
  mpooRegistered: true, mpooStorageMin: 1_250_000_000_000_000_000_000n, ...o,
});
const live = (account: StakingAccount | null = acct()): StakingSnapshot => ({
  kind: "live",
  staking: "staking.metapoo-player1.testnet",
  config: { toilet: "toilet3.testnet", mpoo: "mpoo.testnet", board: "board5.testnet", dripBps: 1000, exitTaxBps: 1000, storageMin: 1_610_000_000_000_000_000_000n },
  pool: { pool: 10_000n * E18, releasedTotal: 500n * E18, totalStaked: 40_000n * E18, burnedTotal: 200n * E18 },
  boardReserve: 70n * E18,
  account,
  accountFailed: false,
});
const OK = { transaction: { hash: "abc" }, status: { SuccessValue: "" } };

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

async function setup(deps: Partial<StakePageDeps> = {}, session: WalletSession = { accountId: "alice.testnet", networkId: "testnet" }) {
  const ctx: PageContext = {
    services: {
      wallet: {
        getSession: () => session, connect: async () => {}, disconnect: async () => {},
        subscribe: () => () => {}, whenReady: Promise.resolve(session),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/stake"),
    navigate: () => {},
  };
  const root = document.createElement("div");
  document.body.append(root);
  const all = {
    load: vi.fn(async () => live()), stake: vi.fn(async () => OK), unstake: vi.fn(async () => OK), claim: vi.fn(async () => OK),
    network: "testnet", board: "board5.testnet", configured: true, pollMs: 1e9, ...deps,
  };
  const dispose = mountStakePage(root, ctx, all);
  cleanup.push(() => { dispose(); root.remove(); });
  const s = (key: string) => root.querySelector(`[data-s="${key}"]`)!.textContent;
  const btn = (act: string) => root.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
  const type = (id: string, value: string) => {
    const el = root.querySelector<HTMLInputElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event("input"));
  };
  await vi.waitFor(() => expect(root.querySelector<HTMLElement>('[data-s="live"]')!.hidden).toBe(false));
  return { root, s, btn, type, deps: all };
}

it("shows the pool and the position from live reads", async () => {
  const t = await setup();
  expect(t.s("totalStaked")).toBe("40,000");
  expect(t.s("pool")).toBe("10,000");
  expect(t.s("today")).toBe("1,000");
  expect(t.s("burned")).toBe("200");
  expect(t.s("share")).toBe("25%");
  expect(t.s("cut")).toBe("≈ 250");
  expect(t.s("wallet")).toBe("12,480 TOILET");
  expect(t.s("staked")).toBe("10,000 TOILET");
  expect(t.s("pending")).toBe("1,482 mPOO");
  expect(t.s("source")).toMatch(/staking\.metapoo-player1\.testnet and board5\.testnet/);
});

it("locks: previews the share, then sends ft_transfer_call to the staking contract", async () => {
  const t = await setup();
  t.type("stk-lock-amt", "10000");
  expect(t.s("lockAfter")).toBe("20,000 TOILET");
  expect(t.s("lockShare")).toBe("40%");
  expect(t.btn("lock").textContent).toBe("Lock 10,000 TOILET");
  t.btn("lock").click();
  await vi.waitFor(() => expect(t.s("lockResult")).toMatch(/Locked 10,000 TOILET/));
  expect(t.deps.stake).toHaveBeenCalledWith(expect.objectContaining({
    toilet: "toilet3.testnet", staking: "staking.metapoo-player1.testnet", amount: (10_000n * E18).toString(), registerDeposit: null,
  }));
});

it("registers with the staking contract on a first lock, and says what it costs", async () => {
  const t = await setup({ load: vi.fn(async () => live(acct({ registered: false, staked: 0n }))) });
  expect(t.s("registerNote")).toMatch(/0\.00161 NEAR/);
  t.type("stk-lock-amt", "1");
  t.btn("lock").click();
  await vi.waitFor(() => expect(t.deps.stake).toHaveBeenCalled());
  expect(t.deps.stake).toHaveBeenCalledWith(expect.objectContaining({ registerDeposit: "1610000000000000000000" }));
});

it("reports a refunded stake instead of a lock", async () => {
  const stake = vi.fn(async () => ({ ...OK, receipts_outcome: [{ outcome: { logs: ["stake_refused: NotRegistered"] } }] }));
  const t = await setup({ stake });
  t.type("stk-lock-amt", "1");
  t.btn("lock").click();
  await vi.waitFor(() => expect(t.s("lockResult")).toMatch(/sent your TOILET back/));
});

it("unlocks: shows the 10% burn before signing", async () => {
  const t = await setup();
  (t.root.querySelector("#stk-t-unlock") as HTMLButtonElement).click();
  t.type("stk-unlock-amt", "4000");
  expect(t.s("unlockNet")).toBe("3,600 TOILET");
  expect(t.s("unlockTax")).toBe("400 TOILET");
  expect(t.btn("unlock").textContent).toBe("Unlock and burn 400 TOILET");
  t.btn("unlock").click();
  await vi.waitFor(() => expect(t.s("unlockResult")).toMatch(/3,600 TOILET is back in your wallet and 400 TOILET was burned/));
  expect(t.deps.unstake).toHaveBeenCalledWith({ staking: "staking.metapoo-player1.testnet", amount: (4_000n * E18).toString(), gas: "100000000000000" });
});

it("claims mPOO, registering with the mPOO token first when needed", async () => {
  const t = await setup({ load: vi.fn(async () => live(acct({ mpooRegistered: false }))) });
  expect(t.s("claimHint")).toMatch(/0\.00125 NEAR, once/);
  t.btn("claim").click();
  await vi.waitFor(() => expect(t.s("claimResult")).toMatch(/Claimed/));
  expect(t.deps.claim).toHaveBeenCalledWith(expect.objectContaining({ mpoo: "mpoo.testnet", mpooRegisterDeposit: "1250000000000000000000" }));
});

it("reports a refused mPOO payout as restored", async () => {
  const log = 'EVENT_JSON:{"standard":"toilet_staking","version":"1.0.0","event":"claim_failed","data":{}}';
  const t = await setup({ claim: vi.fn(async () => ({ ...OK, receipts_outcome: [{ outcome: { logs: [log] } }] })) });
  t.btn("claim").click();
  await vi.waitFor(() => expect(t.s("claimResult")).toMatch(/rewards were put back/));
});

it("signed out: pool shows, position asks to connect, nothing can be sent", async () => {
  const t = await setup({ load: vi.fn(async () => live(null)) }, { accountId: null, networkId: null });
  expect(t.s("pool")).toBe("10,000");
  expect(t.s("wallet")).toBe("Connect a wallet");
  expect(t.btn("lock").disabled).toBe(true);
  expect(t.btn("claim").disabled).toBe(true);
});

it("renders step 3 of the money flow as one row, so no line starts with a comma", async () => {
  const t = await setup();
  const step = t.root.querySelectorAll<HTMLElement>(".stk-flow li")[2];
  // `.stk-flow li` is a grid (stake-page.css): every element or run of text inside it is
  // its own row, so a clause left outside the bold starts a row with ", ".
  const rows = [...step.childNodes].map(node => node.textContent!.trim()).filter(Boolean);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^[A-Za-z0-9]/);
});

it("explains a board without a staking contract", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const ctx = { services: { wallet: { getSession: () => ({ accountId: null, networkId: null }), connect: async () => {}, disconnect: async () => {}, subscribe: () => () => {}, whenReady: Promise.resolve({ accountId: null, networkId: null }) }, operations: createOperationsStore() }, route: matchRoute("/stake"), navigate: () => {} } as PageContext;
  const dispose = mountStakePage(root, ctx, { load: async () => ({ kind: "not-set" }), network: "testnet", board: "b", configured: true, pollMs: 1e9 });
  cleanup.push(() => { dispose(); root.remove(); });
  await vi.waitFor(() => expect(root.querySelector('[data-s="notice"]')!.textContent).toMatch(/Staking opens soon/));
  expect(root.querySelector<HTMLElement>('[data-s="live"]')!.hidden).toBe(true);
});

it("never promises a return", async () => {
  const t = await setup();
  const text = t.root.textContent!;
  expect(text).toMatch(/Nothing here is a promised return/);
  expect(text).not.toMatch(/\bAPR\b|\bAPY\b|guaranteed|30 days/i);
});
