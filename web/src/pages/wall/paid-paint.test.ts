/**
 * @vitest-environment happy-dom
 *
 * FE-2: a real pricing controller behind a real paint controller, on a fake
 * paid board. Pins max_credits, the PriceRoseAboveMax re-quote, the single
 * reserved balance, and cell-cost invalidation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import type { CachedPixel } from "../../board-cache";
import type { Cell } from "../../selection";
import { createPaintController } from "./paint-controller";
import { createPricingController } from "./pricing-controller";
import type { UiPhase } from "./wall-view";
import { createWallScope } from "./wall-scope";

const sheet = vi.hoisted(() => ({
  onCreditsChanged: undefined as ((balance: bigint | null | undefined) => void) | undefined,
  open: vi.fn(),
}));
vi.mock("../../app/buy-credits-sheet", () => ({
  mountBuyCreditsSheet: vi.fn(
    (_host: HTMLElement, _services: unknown, options: { onCreditsChanged?: (b: bigint | null | undefined) => void }) => {
      sheet.onCreditsChanged = options.onCreditsChanged;
      return { open: sheet.open, setVisible: vi.fn(), setCredits: vi.fn(), dispose: vi.fn() };
    },
  ),
}));
vi.mock("../../submit-draw", () => ({ submitDraw: vi.fn() }));
vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    canUseLocalDrawingSession: vi.fn(() => true),
    fetchDrawingSessionAllowance: vi.fn(async () => ({ found: true, remainingYocto: null, permissionSummary: "" })),
    signAndSendStrokeLocally: vi.fn(async () => ({
      status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [], failingChunk: null, executedBlocks: [],
    })),
  };
});
vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, CONTRACT_ID: "board.paid.testnet", PAGE_NETWORK: "testnet" };
});

/** Fake paid board. `strokeCost: null` = the deployed (old) contract without get_stroke_cost. */
const chain = {
  credits: "2" as string | null,
  cellCost: (_cell: Cell): number => 1,
  strokeCost: null as null | ((cells: Cell[]) => { costs: number[]; free: boolean[]; total: number }),
  views: [] as Array<{ method: string; args: Record<string, unknown> | undefined }>,
};
vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    viewFunction: vi.fn(async (method: string, args?: Record<string, unknown>) => {
      chain.views.push({ method, args });
      if (method === "get_credits") return chain.credits;
      if (method === "get_tunables") return { repaint_mid_ns: "3600000000000", repaint_base_credits: 1 };
      if (method === "get_cell_cost") return chain.cellCost({ x: Number(args?.x), y: Number(args?.y) });
      if (method === "get_cell_costs") return (args?.cells as Cell[]).map((c) => chain.cellCost(c));
      if (method === "get_stroke_cost") {
        if (!chain.strokeCost) throw new Error("wasm execution failed with error: MethodResolveError(MethodNotFound)");
        return chain.strokeCost(args?.cells as Cell[]);
      }
      throw new Error(`unexpected view ${method}`);
    }),
  };
});
import { submitDraw } from "../../submit-draw";
import { signAndSendStrokeLocally } from "../../local-draw";

type DrawResult = Awaited<ReturnType<typeof submitDraw>>;
const confirmed = (x: number, y: number, colorIndex: number): DrawResult => ({
  status: "confirmed", title: "Paint confirmed", message: "ok", transactionId: `tx-${x}-${y}`,
  explorerUrl: null, pixel: { x, y, colorIndex, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1" },
  observedBlockHeight: 3,
});
const priceRose: DrawResult = {
  status: "failed", title: "Transaction failed",
  message: "Smart contract panicked: PriceRoseAboveMax: draw was rejected and no pixel was stored",
  transactionId: "tx-rose", explorerUrl: null, pixel: null,
};

function setup() {
  document.body.innerHTML = `
    <div id="dock"><span id="balance"></span><button id="buy"></button></div><div id="host"></div>
    <p id="legend"></p><span id="badge"></span><span id="total"></span>
    <div id="viewport"></div><button id="draw"></button><div id="result"></div><p id="draw-state"></p><p id="flow"></p>
    <label><input type="checkbox" id="toggle"></label><p id="tap-status"></p>
    <div id="unlock"></div><p id="unlocked"></p><button id="unlock-btn"></button>
    <button id="auth"></button><button id="forget"></button><button id="revoke"></button>
    <p id="session-status"></p><p id="session-note"></p>
  `;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const scope = createWallScope();
  scope.setWallet("alice.testnet", "testnet");
  const services = createAppServices();
  const pixels = new Map<string, CachedPixel>();
  let selected: Cell | null = null;
  let paint: ReturnType<typeof createPaintController> | null = null;
  const pricing = createPricingController({
    scope, services,
    creditsDock: el("dock"), creditsBalance: el("balance"),
    buyCreditsButton: el<HTMLButtonElement>("buy"), buyCreditsHost: el("host"),
    repaintChrome: { legend: el("legend"), badge: el("badge"), strokeTotal: el("total"), submit: el<HTMLButtonElement>("draw") },
    result: el("result"),
    boardSchema: () => 4,
    // These scenarios are about balance accounting: the free-first-paint program
    // is treated as over so a shortfall must block again.
    freePaints: () => ({ kind: "no" }) as const,
    cachedPixel: (cell) => pixels.get(`${cell.x},${cell.y}`),
    drawInFlight: () => paint?.drawInFlight() ?? false,
    syncSubmitEnabled: () => paint?.syncSubmitEnabled(),
  });
  const toggle = el<HTMLInputElement>("toggle");
  paint = createPaintController({
    scope, services,
    sponsorship: { flagEnabled: false, message: "No sponsor." } as never,
    boardViewport: el("viewport"), drawState: el("draw-state"), flowState: el("flow"),
    drawButton: el<HTMLButtonElement>("draw"), result: el("result"),
    directPaintToggle: toggle, tapToPaintAffordance: toggle.closest("label")!,
    tapToPaintAnnouncement: el("tap-status"), paintUnlock: el("unlock"), paintUnlocked: el("unlocked"),
    unlockPaintButton: el<HTMLButtonElement>("unlock-btn"), authorizeSessionButton: el<HTMLButtonElement>("auth"),
    forgetSessionButton: el<HTMLButtonElement>("forget"), revokeSessionButton: el<HTMLButtonElement>("revoke"),
    drawingSessionStatus: el("session-status"), drawingSessionNote: el("session-note"),
    board: {
      contractMetaOk: () => true,
      contractMetaIssue: () => ({ kind: "read" as const, detail: "" }),
      rememberPixel: vi.fn(),
      refreshBoardFromContract: vi.fn(async () => undefined),
    },
    pricing,
    view: {
      selected: () => selected,
      setSelected: (cell: Cell | null) => { selected = cell; },
      selectedColor: () => 2,
      setFlow: vi.fn((_: UiPhase) => undefined),
      showSelection: vi.fn(),
    },
    render: vi.fn(),
  });
  return {
    pricing, paint, scope,
    result: el("result"),
    select: (cell: Cell) => { selected = cell; },
    /** Someone else repainted a cell: the board cache shows a new write stamp. */
    repaintedBySomeoneElse: (cell: Cell, stamp: string) => {
      pixels.set(`${cell.x},${cell.y}`, {
        x: cell.x, y: cell.y, colorIndex: 1, artistAccountId: "bob.testnet", lastWriteTimestampNs: stamp,
      } as CachedPixel);
    },
    views: (method: string) => chain.views.filter((v) => v.method === method),
    dispose: () => { paint!.dispose(); pricing.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

beforeEach(() => {
  chain.credits = "2";
  chain.cellCost = () => 1;
  chain.strokeCost = null;
  chain.views = [];
  sheet.open.mockClear();
  vi.mocked(submitDraw).mockReset();
  vi.mocked(signAndSendStrokeLocally).mockClear();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("paid paint: one balance, max_credits, re-quote", () => {
  it("five queued taps with 2 credits: only two are queued and sent", async () => {
    // The chain balance lags the spends (the reported bug): it reads 2 throughout.
    vi.mocked(submitDraw).mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    await t.pricing.refreshCreditsDock();
    t.paint.showDrawingSession();
    for (let x = 0; x < 5; x++) t.paint.maybeEnqueueDirectPaint({ x, y: 0 });
    expect(t.paint.pendingCount()).toBe(2);
    expect(t.result.querySelector("h3")?.textContent).toBe("Not enough credits");
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(t.paint.queueLength()).toBe(0));
    expect(vi.mocked(submitDraw).mock.calls.map((c) => c[0].x)).toEqual([0, 1]);
    t.dispose();
  });

  it("a failed queued paint releases its credits for the next tap", async () => {
    chain.credits = "1";
    vi.mocked(submitDraw).mockResolvedValueOnce({
      status: "failed", title: "Wallet prompt closed", message: "closed", transactionId: null, explorerUrl: null, pixel: null,
    });
    const t = setup();
    await t.pricing.refreshCreditsDock();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 0, y: 0 });
    expect(t.pricing.availableCredits()).toBe(0n);
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(t.pricing.availableCredits()).toBe(1n));
    t.dispose();
  });

  it("a stroke quoted at 3 sends max_credits 3 (get_stroke_cost, new contract)", async () => {
    chain.strokeCost = (cells) => ({ costs: cells.map((_, i) => (i === 0 ? 2 : 1)), free: cells.map(() => false), total: cells.length + 1 });
    chain.credits = "10";
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    t.paint.strokes.finish({ x: 2, y: 1 }, "drag", vi.fn());
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({ maxCredits: [3] });
    expect(t.views("get_stroke_cost")[0]!.args).toEqual({
      account_id: "alice.testnet", cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
    });
    t.dispose();
  });

  it("a single paid draw sends its quote as max_credits", async () => {
    chain.cellCost = () => 3;
    chain.credits = "10";
    vi.mocked(submitDraw).mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.select({ x: 4, y: 4 });
    await t.paint.attemptDraw();
    expect(vi.mocked(submitDraw).mock.calls[0]![0]).toMatchObject({ x: 4, y: 4, maxCredits: 3 });
    t.dispose();
  });

  it("old contract: no get_stroke_cost, so get_cell_costs prices the stroke and max_credits is still sent", async () => {
    chain.credits = "10";
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    t.paint.strokes.finish({ x: 3, y: 1 }, "drag", vi.fn());
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    expect(t.views("get_cell_costs")).toHaveLength(1);
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({ maxCredits: [3] });
    t.dispose();
  });

  it("free cells from get_stroke_cost cost 0 against the balance", async () => {
    chain.credits = "0";
    chain.strokeCost = (cells) => ({ costs: cells.map(() => 0), free: cells.map(() => true), total: 0 });
    vi.mocked(submitDraw).mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    await t.pricing.refreshCreditsDock();
    t.select({ x: 9, y: 9 });
    await t.paint.attemptDraw();
    expect(vi.mocked(submitDraw).mock.calls[0]![0]).toMatchObject({ maxCredits: 0 });
    t.dispose();
  });

  it("PriceRoseAboveMax shows the re-quote prompt and sends the accepted total once", async () => {
    chain.credits = "10";
    let cost = 1;
    chain.cellCost = () => cost;
    vi.mocked(submitDraw)
      .mockImplementationOnce(async () => { cost = 4; return priceRose; })
      .mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.select({ x: 5, y: 5 });
    const done = t.paint.attemptDraw();
    await vi.waitFor(() => expect(t.result.querySelector("[data-requote=accept]")).not.toBeNull());
    expect(t.result.querySelector("p")?.textContent).toContain("Someone painted here first — this now costs 4 credits.");
    expect(submitDraw).toHaveBeenCalledTimes(1);
    t.result.querySelector<HTMLButtonElement>("[data-requote=accept]")!.click();
    await done;
    expect(submitDraw).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitDraw).mock.calls[0]![0]).toMatchObject({ maxCredits: 1 });
    expect(vi.mocked(submitDraw).mock.calls[1]![0]).toMatchObject({ maxCredits: 4 });
    t.dispose();
  });

  it("PriceRoseAboveMax twice: asked once, then a plain failure", async () => {
    chain.credits = "10";
    let cost = 1;
    chain.cellCost = () => cost;
    vi.mocked(submitDraw).mockImplementation(async () => { cost += 1; return priceRose; });
    const t = setup();
    t.select({ x: 5, y: 5 });
    const done = t.paint.attemptDraw();
    await vi.waitFor(() => expect(t.result.querySelector("[data-requote=accept]")).not.toBeNull());
    t.result.querySelector<HTMLButtonElement>("[data-requote=accept]")!.click();
    await done;
    expect(submitDraw).toHaveBeenCalledTimes(2);
    expect(t.result.querySelector("[data-requote]")).toBeNull();
    expect(t.result.querySelector("h3")?.textContent).toBe("Transaction failed");
    t.dispose();
  });

  it("cancelling the re-quote sends nothing more", async () => {
    chain.credits = "10";
    vi.mocked(submitDraw).mockResolvedValueOnce(priceRose);
    const t = setup();
    t.select({ x: 5, y: 5 });
    const done = t.paint.attemptDraw();
    await vi.waitFor(() => expect(t.result.querySelector("[data-requote=cancel]")).not.toBeNull());
    t.result.querySelector<HTMLButtonElement>("[data-requote=cancel]")!.click();
    await done;
    expect(submitDraw).toHaveBeenCalledTimes(1);
    expect(t.pricing.availableCredits()).toBe(10n);
    t.dispose();
  });

  it("a cell repainted by someone else is re-priced, not served from cache", async () => {
    chain.credits = "2";
    chain.cellCost = () => 1;
    const t = setup();
    await t.pricing.refreshCreditsDock();
    t.pricing.requestCellPrice({ x: 7, y: 7 });
    await vi.waitFor(() => expect(t.pricing.knownCost({ x: 7, y: 7 })).toBe(1));
    // Bob repaints it; it is fresh now and costs 4.
    chain.cellCost = () => 4;
    t.repaintedBySomeoneElse({ x: 7, y: 7 }, "99");
    t.pricing.onBoardUpdated();
    expect(t.pricing.knownCost({ x: 7, y: 7 })).toBeUndefined();
    t.pricing.requestCellPrice({ x: 7, y: 7 });
    await vi.waitFor(() => expect(t.pricing.knownCost({ x: 7, y: 7 })).toBe(4));
    expect(t.views("get_cell_cost")).toHaveLength(2);
    // And the tap is now checked against 4, not the stale 1.
    expect(t.pricing.admitTap({ x: 7, y: 7 })).toBeNull();
    t.dispose();
  });

  it("the balance after a purchase is used by the next tap", async () => {
    chain.credits = "0";
    const t = setup();
    await t.pricing.refreshCreditsDock();
    expect(t.pricing.admitTap({ x: 1, y: 1 })).toBeNull();
    // The buy-credits sheet reports the purchase.
    sheet.onCreditsChanged!(5n);
    expect(t.pricing.availableCredits()).toBe(5n);
    t.result.innerHTML = "";
    expect(t.pricing.admitTap({ x: 1, y: 1 })).not.toBeNull();
    expect(t.result.textContent).toBe("");
    t.dispose();
  });

  it("an executed paint keeps its credits held until a fresh balance read", async () => {
    chain.credits = "3";
    const t = setup();
    await t.pricing.refreshCreditsDock();
    const held = t.pricing.admitTap({ x: 1, y: 1 })!;
    expect(t.pricing.availableCredits()).toBe(2n);
    t.pricing.settle(held);
    expect(t.pricing.availableCredits()).toBe(2n);
    chain.credits = "2";
    await t.pricing.refreshCreditsDock();
    expect(t.pricing.availableCredits()).toBe(2n);
    t.dispose();
  });
});
