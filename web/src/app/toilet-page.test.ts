// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { EMPTY_PAGE, type ToiletPageSnapshot } from "./toilet";
import { mountToiletPage, type ToiletPageDeps } from "./toilet-page";

const E18 = 10n ** 18n;
const LIVE: ToiletPageSnapshot = {
  emission: { perCellSecond: 1_000_000_000_000_000n, accruedTotal: 2_811_920_000_000_000_000_000n, cap: 1_000_000_000n * E18, remaining: 999_997_188n * E18 },
  supply: { totalSupply: E18, issuedTotal: E18, burnedTotal: 0n },
  reserve: 310n * E18,
  stakingContract: null,
  nearPerCredit: 5_000_000_000_000_000_000_000n,
  tiers: { repaint_young_ns: 600, repaint_mid_ns: 3600, repaint_young_credits: 8, repaint_mid_credits: 2, repaint_base_credits: 1 },
};

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

function ctx(): PageContext {
  return {
    services: {
      wallet: {
        getSession: () => ({ accountId: null, networkId: null }), connect: async () => {}, disconnect: async () => {},
        subscribe: () => () => {}, whenReady: Promise.resolve({ accountId: null, networkId: null }),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/toilet"),
    navigate: () => {},
  };
}

function setup(deps: Partial<ToiletPageDeps>) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountToiletPage(root, ctx(), {
    load: async () => LIVE, configured: true, network: "testnet", board: "board.testnet", toilet: "toilet.testnet",
    reducedMotion: true, pollMs: 1e9, claim: { load: async () => ({ kind: "not-yet" }), pollMs: 1e9 }, ...deps,
  });
  cleanup.push(() => { dispose(); root.remove(); });
  const tl = (key: string) => root.querySelector(`[data-tl="${key}"]`)!.textContent;
  const o = (key: string) => root.querySelector(`[data-o="${key}"]`)!.textContent;
  return { root, tl, o };
}

it("shows the board's live TOILET figures", async () => {
  const t = setup({});
  await vi.waitFor(() => expect(t.tl("rate")).toBe("86.4"));
  expect(t.tl("accrued")).toBe("2,811.92");
  expect(t.tl("reserve")).toBe("310 mPOO");
  expect(t.tl("burned")).toBe("0");
  expect(t.root.querySelector("[data-tlt-source]")!.textContent).toMatch(/board\.testnet and toilet\.testnet/);
});

it("uses the board's prices in the whale explorer and offers its pace", async () => {
  const t = setup({});
  await vi.waitFor(() => expect(t.tl("wet")).toBe("8"));
  // 4,096 tiles at 0.005 NEAR; 3,200 pokes answered at 8 credits.
  expect(t.o("whale")).toBe("4,096 tiles · 20.48 NEAR");
  expect(t.o("answer")).toBe("128");
  const chip = t.root.querySelector<HTMLButtonElement>("[data-years-live]")!;
  expect(chip.hidden).toBe(false);
  chip.click();
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  expect(t.o("runout")).toBe("23 months");
});

it("hides what the board couldn't confirm instead of showing zero", async () => {
  const t = setup({ load: async () => EMPTY_PAGE });
  await vi.waitFor(() => expect(t.root.querySelector<HTMLElement>('[data-needs="rate"]')!.hidden).toBe(true));
  expect(t.root.querySelector<HTMLElement>('[data-needs="reserve"]')!.hidden).toBe(true);
  expect(t.root.querySelector<HTMLButtonElement>("[data-years-live]")!.hidden).toBe(true);
  // Explorers fall back to labelled launch prices.
  expect(t.tl("wet")).toBe("4");
  expect(t.tl("priceNote")).toBe("At launch prices.");
});

it("states the decided staking rules and never promises a return", () => {
  const t = setup({});
  const text = t.root.textContent!;
  expect(text).toMatch(/at most 10% of itself a day/);
  expect(text).toMatch(/burns 10% of the TOILET you take out, every time/);
  expect(text).toMatch(/nothing here promises a return/);
  expect(text).not.toMatch(/30 days|APR|APY|guaranteed/i);
});

it("works as a labelled preview with no board", () => {
  const load = vi.fn(async () => LIVE);
  const t = setup({ configured: false, board: "", toilet: "", load });
  expect(load).not.toHaveBeenCalled();
  expect(t.root.querySelector("[data-tlt-source]")!.textContent).toMatch(/isn’t connected to a board/);
  expect(t.root.querySelector("[data-tlt-claim]")!.textContent).toMatch(/nothing to claim here/);
});
