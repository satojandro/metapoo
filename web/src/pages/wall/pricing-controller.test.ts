/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createPricingController } from "./pricing-controller";
import { createWallScope } from "./wall-scope";

const chain = {
  credits: [] as Array<string | null | Error>,
  cellCost: 1 as number | Error,
  tunables: { repaint_mid_ns: String(3_600_000_000_000), repaint_base_credits: 1 } as unknown,
  calls: [] as string[],
};

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    viewFunction: vi.fn(async (method: string) => {
      chain.calls.push(method);
      const unwrap = (v: unknown) => {
        if (v instanceof Error) throw v;
        return v;
      };
      if (method === "get_credits") {
        const next = chain.credits.shift();
        return unwrap(next === undefined ? "10" : next);
      }
      if (method === "get_cell_cost") return unwrap(chain.cellCost);
      if (method === "get_cell_costs") return [1, 1];
      if (method === "get_tunables") return unwrap(chain.tunables);
      if (method === "get_payment_config") {
        return { mpoo_token: "t.testnet", near_per_credit: "1", mpoo_per_credit: "1" };
      }
      throw new Error(`unexpected view ${method}`);
    }),
  };
});

function setup(options: { schema?: number | null; wallet?: string | null } = {}) {
  document.body.innerHTML = `
    <div id="dock" hidden><span id="balance"></span><button id="buy"></button></div>
    <div id="host"></div>
    <p id="legend"></p><span id="badge"></span><span id="total"></span><button id="submit"></button>
    <div id="result"></div>
  `;
  const el = (id: string) => document.getElementById(id)!;
  const scope = createWallScope();
  scope.setWallet(options.wallet === undefined ? "alice.testnet" : options.wallet, "testnet");
  let schema: number | null = options.schema === undefined ? 4 : options.schema;
  let drawInFlight = false;
  const services = createAppServices();
  services.wallet = {
    getSession: () => ({ accountId: "alice.testnet", networkId: "testnet" }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    subscribe: () => () => undefined,
    whenReady: Promise.resolve({ accountId: "alice.testnet", networkId: "testnet" }),
  };
  const deps = {
    scope,
    services,
    creditsDock: el("dock"),
    creditsBalance: el("balance"),
    buyCreditsButton: el("buy") as HTMLButtonElement,
    buyCreditsHost: el("host"),
    repaintChrome: {
      legend: el("legend"),
      badge: el("badge"),
      strokeTotal: el("total"),
      submit: el("submit") as HTMLButtonElement,
    },
    result: el("result"),
    boardSchema: () => schema,
    cachedPixel: vi.fn(() => undefined),
    drawInFlight: () => drawInFlight,
    syncSubmitEnabled: vi.fn(),
  };
  const pricing = createPricingController(deps);
  return {
    pricing, deps,
    setSchema: (next: number | null) => { schema = next; },
    setDrawInFlight: (v: boolean) => { drawInFlight = v; },
    dispose: () => { pricing.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

const sheet = () => document.querySelector<HTMLElement>(".buy-credits-sheet")!;

beforeEach(() => {
  chain.credits = [];
  chain.cellCost = 1;
  chain.tunables = { repaint_mid_ns: String(3_600_000_000_000), repaint_base_credits: 1 };
  chain.calls = [];
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pricing controller", () => {
  it("a free board never prices and every quote passes", async () => {
    const { pricing, deps, dispose } = setup({ schema: 2 });
    expect(pricing.paidBoard()).toBe(false);
    pricing.onSchemaChanged();
    expect(deps.creditsDock.hidden).toBe(true);
    expect(await pricing.ensurePaidQuote([{ x: 1, y: 1 }], "alice.testnet")).toEqual({
      maxCredits: null, chunkMaxCredits: null, reservation: null,
    });
    expect(pricing.admitTap({ x: 1, y: 1 })).toBeTruthy();
    pricing.requestCellPrice({ x: 1, y: 1 });
    expect(chain.calls).toEqual([]);
    dispose();
  });

  it("a paid schema shows the dock, the legend and the balance", async () => {
    const { pricing, deps, dispose } = setup();
    pricing.onSchemaChanged();
    expect(deps.creditsDock.hidden).toBe(false);
    await vi.waitFor(() => expect(deps.creditsBalance.textContent).toBe("Credits: 10"));
    await vi.waitFor(() =>
      expect(deps.repaintChrome.legend.textContent).toBe(
        "Fresh cells cost more to repaint. Wait an hour and it is 1 credit again.",
      ),
    );
    expect(pricing.priceUnavailable()).toBe(false);
    dispose();
  });

  it("no wallet: the dock asks to connect and Buy is disabled", async () => {
    const { pricing, deps, dispose } = setup({ wallet: null });
    await pricing.refreshCreditsDock();
    expect(deps.creditsBalance.textContent).toBe("Credits: connect wallet");
    expect(deps.buyCreditsButton.disabled).toBe(true);
    dispose();
  });

  it("a failed price read latches price unavailable until a gesture retries", async () => {
    chain.cellCost = new Error("429");
    const { pricing, deps, dispose } = setup();
    expect(await pricing.ensurePaidQuote([{ x: 2, y: 3 }], "alice.testnet")).toBeNull();
    expect(pricing.priceUnavailable()).toBe(true);
    expect(deps.result.querySelector("h3")?.textContent).toBe("Price unavailable");
    expect(deps.repaintChrome.badge.textContent).toBe("price unavailable");
    expect(deps.syncSubmitEnabled).toHaveBeenCalled();
    pricing.allowGestureRetry();
    expect(pricing.priceUnavailable()).toBe(false);
    dispose();
  });

  it("a quote that the balance covers passes and caches the cell cost", async () => {
    chain.cellCost = 2;
    chain.credits = ["5"];
    const { pricing, deps, dispose } = setup();
    expect(await pricing.ensurePaidQuote([{ x: 2, y: 3 }], "alice.testnet")).toMatchObject({ maxCredits: 2 });
    expect(deps.repaintChrome.strokeTotal.textContent).toBe("this stroke: 1 cell · 2 credits");
    // The balance (5) and cost (2) are now known; a tap is admitted.
    expect(pricing.admitTap({ x: 2, y: 3 })).toBeTruthy();
    dispose();
  });

  it("a shortfall opens Buy credits with the missing quantity and refuses", async () => {
    chain.cellCost = 4;
    chain.credits = ["1", "1"];
    const { pricing, deps, dispose } = setup();
    // The sheet only opens on a board it is visible for.
    await pricing.refreshCreditsDock();
    expect(await pricing.ensurePaidQuote([{ x: 2, y: 3 }], "alice.testnet")).toBeNull();
    expect(deps.result.querySelector("h3")?.textContent).toBe("Not enough credits");
    expect(deps.result.querySelector("button")?.textContent).toBe("Buy credits");
    expect(sheet().hidden).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#buy-credits-qty")!.value).toBe("3");
    dispose();
  });

  it("admitTap blocks against the cached balance and the last quoted cost", async () => {
    chain.cellCost = 3;
    chain.credits = ["2", "2"];
    const { pricing, deps, dispose } = setup();
    pricing.requestCellPrice({ x: 7, y: 7 });
    await vi.waitFor(() => expect(deps.repaintChrome.badge.textContent).toContain("3 credits"));
    await pricing.refreshCreditsDock();
    expect(pricing.admitTap({ x: 7, y: 7 })).toBeNull();
    expect(deps.result.querySelector("p")?.textContent).toBe(
      "This stroke needs 3 credits and this account has 2 credits. Nothing was submitted.",
    );
    expect(sheet().hidden).toBe(false);
    dispose();
  });

  it("requestCellPrice skips the same cell and anything while a paint is in flight", async () => {
    const { pricing, setDrawInFlight, dispose } = setup();
    pricing.requestCellPrice({ x: 1, y: 1 });
    pricing.requestCellPrice({ x: 1, y: 1 });
    await vi.waitFor(() => expect(chain.calls.filter((c) => c === "get_cell_cost")).toHaveLength(1));
    pricing.repriceCell({ x: 1, y: 1 });
    await vi.waitFor(() => expect(chain.calls.filter((c) => c === "get_cell_cost")).toHaveLength(2));
    setDrawInFlight(true);
    pricing.requestCellPrice({ x: 5, y: 5 });
    await Promise.resolve();
    expect(chain.calls.filter((c) => c === "get_cell_cost")).toHaveLength(2);
    dispose();
  });

  it("onBoardUpdated forgets the last priced cell", async () => {
    const { pricing, dispose } = setup();
    pricing.requestCellPrice({ x: 1, y: 1 });
    pricing.onBoardUpdated();
    pricing.requestCellPrice({ x: 1, y: 1 });
    await vi.waitFor(() => expect(chain.calls.filter((c) => c === "get_cell_cost")).toHaveLength(2));
    dispose();
  });

  it("manual refresh re-reads tunables on a paid board only", async () => {
    const { pricing, setSchema, dispose } = setup();
    await pricing.refreshPaidLegend();
    pricing.manualRefresh();
    await vi.waitFor(() => expect(chain.calls.filter((c) => c === "get_tunables")).toHaveLength(2));
    setSchema(2);
    pricing.manualRefresh();
    await Promise.resolve();
    expect(chain.calls.filter((c) => c === "get_tunables")).toHaveLength(2);
    dispose();
  });

  it("switching back to a free board clears the chrome and the latch", async () => {
    chain.tunables = new Error("down");
    const { pricing, deps, setSchema, dispose } = setup();
    await pricing.refreshPaidLegend();
    expect(pricing.priceUnavailable()).toBe(true);
    setSchema(null);
    pricing.onSchemaChanged();
    expect(pricing.priceUnavailable()).toBe(false);
    expect(deps.repaintChrome.badge.textContent).toBe("");
    expect(deps.creditsDock.hidden).toBe(true);
    dispose();
  });
});
