// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { AppServices } from "./services";
import { mountToiletClaim, type ToiletClaimDeps } from "./toilet-claim";
import type { ToiletSnapshot } from "./toilet";
import type { WalletSession } from "../wallet";

const E18 = 10n ** 18n;
const live = (pending = 195n * E18 / 100n): ToiletSnapshot => ({
  kind: "live",
  emission: { perCellSecond: 1_000_000_000_000_000n, accruedTotal: 0n, cap: 1n, remaining: 1n },
  supply: null,
  paused: false,
  account: { balance: 780n * E18 / 1000n, pending },
  accountFailed: false,
});

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

async function setup(deps: Partial<ToiletClaimDeps>, session: WalletSession = { accountId: "alice.testnet", networkId: "testnet" }) {
  const services: AppServices = {
    wallet: {
      getSession: () => session, connect: async () => {}, disconnect: async () => {},
      subscribe: () => () => {}, whenReady: Promise.resolve(session),
    },
    operations: createOperationsStore(),
  };
  const host = document.createElement("section");
  document.body.append(host);
  const load = vi.fn(async () => live());
  const dispose = mountToiletClaim(host, services, {
    load, sign: vi.fn(), network: "testnet", contractId: "board.testnet", toiletId: "toilet.testnet", pollMs: 1e9, ...deps,
  });
  cleanup.push(() => { dispose(); host.remove(); });
  const text = (key: string) => host.querySelector(`[data-tc="${key}"]`)!.textContent;
  const button = host.querySelector<HTMLButtonElement>("[data-tc-claim]")!;
  return { host, text, button };
}

it("shows balance and unclaimed TOILET, and enables the claim", async () => {
  const t = await setup({});
  await vi.waitFor(() => expect(t.text("pending")).toBe("1.95 TOILET"));
  expect(t.text("balance")).toBe("0.78 TOILET");
  expect(t.button.disabled).toBe(false);
});

it("signs claim_toilet against the configured token, then re-reads", async () => {
  const sign = vi.fn(async () => ({ transaction: { hash: "abc" }, status: { SuccessValue: "" } }));
  const load = vi.fn(async () => live());
  const t = await setup({ sign, load });
  await vi.waitFor(() => expect(t.button.disabled).toBe(false));
  t.button.click();
  await vi.waitFor(() => expect(t.text("result")).toMatch(/Claimed/));
  expect(sign).toHaveBeenCalledWith({ contractId: "board.testnet", toilet: "toilet.testnet", gas: "50000000000000" });
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("reports a refused mint even though the transaction succeeded", async () => {
  const log = 'EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"claim_failed","data":[{}]}';
  const sign = vi.fn(async () => ({ transaction: { hash: "abc" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [log] } }] }));
  const t = await setup({ sign });
  await vi.waitFor(() => expect(t.button.disabled).toBe(false));
  t.button.click();
  await vi.waitFor(() => expect(t.text("result")).toMatch(/refused the mint/));
});

it("asks a signed-out visitor to connect and never shows a zero", async () => {
  const t = await setup({}, { accountId: null, networkId: null });
  expect(t.text("balance")).toBe("Connect a wallet");
  // C1: a dead Claim button is replaced by a working Connect, not disabled.
  expect(t.button.disabled).toBe(false);
  expect(t.button.textContent).toBe("Connect wallet");
  expect(t.text("hint")).toMatch(/Connect/);
});

it("doesn't read another network's account", async () => {
  const load = vi.fn(async () => live());
  const t = await setup({ load }, { accountId: "alice.near", networkId: "mainnet" });
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load).toHaveBeenCalledWith(null);
  expect(t.text("balance")).toBe("Switch to testnet");
  expect(t.text("hint")).toMatch(/Switch your wallet to testnet/);
});

it("disables claim with nothing pending, and shows unknown when the read fails", async () => {
  const empty = await setup({ load: vi.fn(async () => live(0n)) });
  await vi.waitFor(() => expect(empty.text("hint")).toMatch(/Nothing to claim/));
  expect(empty.button.disabled).toBe(true);
  const broken = await setup({ load: vi.fn(async () => { throw new Error("rpc"); }) });
  await vi.waitFor(() => expect(broken.text("pending")).toBe("Unavailable"));
});

it("keeps claim disabled below the board's 1.00 TOILET floor and says how far off it is", async () => {
  const t = await setup({ load: vi.fn(async () => live(4n * E18 / 10n)) });
  await vi.waitFor(() => expect(t.text("pending")).toBe("0.4 TOILET"));
  expect(t.button.disabled).toBe(true);
  expect(t.text("hint")).toMatch(/0\.4 of 1\.00 TOILET/);
});
