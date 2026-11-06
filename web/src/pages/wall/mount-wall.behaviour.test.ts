/**
 * @vitest-environment happy-dom
 *
 * Characterization tests for the wall controller split (FE-0).
 *
 * These pin what `mountWall` does today, through `WallMountTestApi`, the DOM
 * and fake services only. They were written against the unsplit
 * `mount-wall.ts` and must pass unchanged after every extraction commit. If
 * one of these fails during the split, the split changed behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices, type AppServices } from "../../app/services";
import { createDrawRequest, type DrawRequest } from "../../draw-request";
import { mountWall, type WallMountTestApi } from "./mount-wall";

vi.mock("../../submit-draw", () => ({
  submitDraw: vi.fn(),
}));

vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    canUseLocalDrawingSession: vi.fn(() => false),
    fetchDrawingSessionAllowance: vi.fn(async () => ({
      found: true,
      remainingYocto: null,
      permissionSummary: "",
    })),
    // Signing reads must never really hit the network in unit tests.
    prefetchSigningContext: vi.fn(() => new Promise(() => undefined)),
    signAndSendStrokeLocally: vi.fn(async () => ({
      status: "confirmed",
      confirmedChunks: 1,
      totalChunks: 1,
      outcomes: [],
      failingChunk: null,
      executedBlocks: [],
      chunks: [{ index: 0, state: "confirmed", message: null, transactionHash: "tx", blockHeight: null }],
    })),
  };
});

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    CONTRACT_ID: "board.behaviour.testnet",
    PAGE_NETWORK: "testnet",
  };
});

/** Schema the fake `get_board` reports. 2 = free wall, 4 = paid credits. */
const fakeChain = {
  schema: 2,
  credits: [] as Array<string | null | Error>,
  cellCost: (_x: number, _y: number): number | Error => 1,
  cellCosts: (cells: Array<{ x: number; y: number }>): number[] | Error => cells.map(() => 1),
  tunables: (): unknown => ({
    repaint_mid_ns: String(3_600_000_000_000),
    repaint_base_credits: 1,
  }),
  views: [] as string[],
};

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    getBoard: vi.fn(async () => ({
      schema_version: fakeChain.schema,
      width: 128,
      height: 128,
      origin: "top-left",
      overwrite_rule: "open_wall",
      sponsorship_enabled: false,
      palette: [
        { index: 0, name: "Ink", hex: "#1c1917" },
        { index: 1, name: "Paper", hex: "#f4efe4" },
        { index: 2, name: "Brick", hex: "#b23a2f" },
        { index: 3, name: "Marigold", hex: "#e0a100" },
        { index: 4, name: "Moss", hex: "#3d7a4a" },
        { index: 5, name: "River", hex: "#2f6f8f" },
        { index: 6, name: "Grape", hex: "#6b4c7a" },
        { index: 7, name: "Clay", hex: "#c47b5a" },
      ],
    })),
    fetchAllPaintedPixels: vi.fn(async () => ({ pixels: [], blockHeight: 1 })),
    getPixelWithBlock: vi.fn(async (x: number, y: number) => ({
      pixel: { x, y, colorIndex: null, artistAccountId: null, lastWriteTimestampNs: null },
      blockHeight: 1,
    })),
    viewFunction: vi.fn(async (method: string, args?: Record<string, unknown>) => {
      fakeChain.views.push(method);
      const unwrap = <T>(value: T | Error): T => {
        if (value instanceof Error) throw value;
        return value;
      };
      if (method === "get_credits") {
        const next = fakeChain.credits.shift();
        return unwrap(next === undefined ? "10" : next);
      }
      if (method === "get_cell_cost") {
        return unwrap(fakeChain.cellCost(Number(args?.x), Number(args?.y)));
      }
      if (method === "get_cell_costs") {
        return unwrap(fakeChain.cellCosts(args?.cells as Array<{ x: number; y: number }>));
      }
      if (method === "get_tunables") {
        return unwrap(fakeChain.tunables());
      }
      if (method === "get_payment_config") {
        return {
          mpoo_token: "metapoo-mpoo.testnet",
          near_per_credit: "2500000000000000000000",
          mpoo_per_credit: "1000000000000000000",
        };
      }
      throw new Error(`unexpected view ${method}`);
    }),
  };
});

import { submitDraw } from "../../submit-draw";
import { canUseLocalDrawingSession, signAndSendStrokeLocally } from "../../local-draw";
import { fetchAllPaintedPixels, getBoard } from "../../contract";

type Session = { accountId: string | null; networkId: string | null };
type DrawResult = Awaited<ReturnType<typeof submitDraw>>;

function controllableWallet(services: AppServices, initial: Session) {
  let session = initial;
  const listeners = new Set<(s: Session) => void>();
  const connect = vi.fn(async () => undefined);
  services.wallet = {
    getSession: () => session,
    connect,
    disconnect: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(session);
      return () => listeners.delete(listener);
    },
    whenReady: Promise.resolve(initial),
  };
  return {
    connect,
    emit(next: Session) {
      session = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const CONFIRMED_AT = (x: number, y: number, colorIndex: number): DrawResult => ({
  status: "confirmed",
  title: "Paint confirmed",
  message: "The confirming read matched.",
  transactionId: `tx-${x}-${y}`,
  explorerUrl: `https://explorer.test/tx-${x}-${y}`,
  pixel: {
    x,
    y,
    colorIndex,
    artistAccountId: "alice.testnet",
    lastWriteTimestampNs: "1",
  },
  observedBlockHeight: 5,
});

const ALICE: Session = { accountId: "alice.testnet", networkId: "testnet" };

function req(x: number, y = 0, colorIndex = 2): DrawRequest {
  return createDrawRequest({ x, y, colorIndex, accountId: "alice.testnet", networkId: "testnet" });
}

function touch(viewport: HTMLElement, type: string, pointerId: number, x: number, y: number): void {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId, clientX: x, clientY: y, pointerType: "touch" });
  viewport.dispatchEvent(event);
}

function text(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent ?? "";
}

interface Mounted {
  root: HTMLElement;
  api: WallMountTestApi;
  dispose: () => void;
  viewport: HTMLElement;
}

const resizeCallbacks = new Set<ResizeObserverCallback>();

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    resizeCallbacks.add(this.callback);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
  unobserve(): void {}
}

function mount(
  services: AppServices,
  size = { width: 512, height: 512 },
  mode: "look" | "paint" = "paint",
): Mounted {
  let api: WallMountTestApi | null = null;
  const root = document.querySelector<HTMLElement>("#root")!;
  const dispose = mountWall(root, services, {
    attachTestApi: (testApi) => {
      api = testApi;
    },
  });
  // These behaviours are about painting, so they run in Paint mode. Look, the
  // page's default, is covered in wall-modes.test.ts.
  if (mode === "paint") root.querySelector<HTMLButtonElement>("#wall-mode-paint")!.click();
  const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
  Object.assign(viewport, { setPointerCapture: vi.fn() });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: size.width,
    bottom: size.height,
    width: size.width,
    height: size.height,
    toJSON: () => ({}),
  } as DOMRect);
  // happy-dom lays nothing out, so the mount-time fit used a 1×1 viewport.
  // Deliver the resize a browser would, against the stubbed rect.
  for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  return { root, api: api!, dispose, viewport };
}

async function booted(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(text(root, "#board-load-status")).toContain("painted cell"));
}

beforeEach(() => {
  document.body.innerHTML = `
    <p id="flow-state"></p>
    <p id="compact-status"></p>
    <div id="wallet-error"></div>
    <div id="root"></div>
  `;
  fakeChain.schema = 2;
  fakeChain.credits = [];
  fakeChain.cellCost = () => 1;
  fakeChain.cellCosts = (cells) => cells.map(() => 1);
  fakeChain.tunables = () => ({ repaint_mid_ns: String(3_600_000_000_000), repaint_base_credits: 1 });
  fakeChain.views = [];
  vi.mocked(submitDraw).mockReset();
  vi.mocked(signAndSendStrokeLocally).mockClear();
  vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
  vi.mocked(fetchAllPaintedPixels).mockClear();
  vi.mocked(getBoard).mockClear();
  resizeCallbacks.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wall behaviour: free board", () => {
  it("tap paint on the free board sends one pipelined paint and reports the confirmed outcome", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce({
      status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [], failingChunk: null,
      executedBlocks: [], executedBlocksLater: Promise.resolve([{ chunkIndex: 0, blockHeight: 9_000 }]),
      chunks: [{ index: 0, state: "confirmed", message: null, transactionHash: "tx-64-64", blockHeight: null }],
    });
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose, viewport } = mount(services);
    await booted(root);
    root.querySelectorAll<HTMLButtonElement>(".swatch")[2]!.click();
    api.paintZoom();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked).toBe(true),
    );
    const readsBefore = vi.mocked(fetchAllPaintedPixels).mock.calls.length;

    touch(viewport, "pointerdown", 1, 260, 260);
    touch(viewport, "pointerup", 1, 260, 260);

    await vi.waitFor(() => expect(text(root, "#result")).toContain("Pixel painted"));
    // With a drawing session a lone tap takes the pipelined path, not the single draw.
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(vi.mocked(signAndSendStrokeLocally)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({
      cells: [{ x: 64, y: 64 }],
      color: 2,
      accountId: "alice.testnet",
      networkId: "testnet",
    });
    expect(text(root, "#result")).toContain("Transaction id: tx-64-64");
    expect(root.querySelector<HTMLAnchorElement>("#result a")?.href).toContain("tx-64-64");
    expect(text(document.body, "#flow-state")).toBe(
      "Painted. Your square is on the wall.",
    );
    const op = services.operations.list().find((o) => o.kind === "paint");
    expect(op).toMatchObject({ phase: "confirmed", transactionId: "tx-64-64" });
    // Stamped from the receipt at its executed block; the marker clears with the stamp.
    await vi.waitFor(() => expect(api.pendingPaintCount()).toBe(0));
    expect(api.cachedPixelColor({ x: 64, y: 64 })).toBe(2);
    expect(text(root, "#selection-summary")).toContain("Selected square x=64, y=64");
    // A confirmed paint re-reads the board ("after_draw").
    await vi.waitFor(() =>
      expect(vi.mocked(fetchAllPaintedPixels).mock.calls.length).toBeGreaterThan(readsBefore),
    );
    // Free board: no credit or price reads at all.
    expect(fakeChain.views).not.toContain("get_credits");
    expect(fakeChain.views).not.toContain("get_cell_cost");
    expect(root.querySelector<HTMLElement>("#credits-dock")!.hidden).toBe(true);
    dispose();
  });

  it("drag stroke sends one local stroke and reports it executed", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose, viewport } = mount(services, { width: 390, height: 480 });
    await booted(root);
    api.paintZoom();
    root.querySelectorAll<HTMLButtonElement>(".swatch")[4]!.click();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked).toBe(true),
    );

    touch(viewport, "pointerdown", 1, 195, 240);
    touch(viewport, "pointermove", 1, 230, 240);
    touch(viewport, "pointermove", 1, 255, 240);
    touch(viewport, "pointerup", 1, 255, 240);

    await vi.waitFor(() => expect(text(root, "#result")).toContain("Stroke confirmed"));
    expect(vi.mocked(signAndSendStrokeLocally)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({
      accountId: "alice.testnet",
      networkId: "testnet",
      color: 4,
      cells: [
        { x: 64, y: 64 },
        { x: 65, y: 64 },
        { x: 66, y: 64 },
        { x: 67, y: 64 },
      ],
    });
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(text(root, "#draw-state")).toBe(
        "Stroke transactions executed. Refreshing the latest board state.",
      ),
    );
    expect(text(document.body, "#flow-state")).toBe(
      "Stroke transactions executed. Refreshing the latest board state.",
    );
    expect(api.pendingPaintCount()).toBe(0);
    dispose();
  });

  it("Enter on the board submits the keyboard-selected cell through the Place path", async () => {
    vi.mocked(submitDraw).mockImplementation(async (input) =>
      CONFIRMED_AT(input.x, input.y, input.colorIndex),
    );
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose } = mount(services);
    await booted(root);
    // No drawing session: Place paint is visible and Direct paint is hidden.
    expect(root.querySelector<HTMLButtonElement>("#draw-button")!.hidden).toBe(false);
    root.querySelectorAll<HTMLButtonElement>(".swatch")[1]!.click();
    const focus = root.querySelector<HTMLElement>("#board-focus")!;
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(text(root, "#selection-summary")).toContain("Selected square x=0, y=0");
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(text(root, "#selection-summary")).toContain("Selected square x=1, y=1");
    expect(text(document.body, "#flow-state")).toBe(
      "Choose a colour, then Paint this tile.",
    );
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(text(root, "#result")).toContain("Paint confirmed"));
    expect(vi.mocked(submitDraw).mock.calls[0]![0]).toMatchObject({ x: 1, y: 1, colorIndex: 1 });
    dispose();
  });

  it("a blocked draw explains itself and never reaches the wallet", async () => {
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose } = mount(services);
    await booted(root);
    // Place paint stays off until a square is chosen, and says why beside it.
    const drawButton = root.querySelector<HTMLButtonElement>("#draw-button")!;
    expect(drawButton.disabled).toBe(true);
    expect(text(root, "#place-reason")).toBe("Choose a square on the wall first.");
    drawButton.click();
    await Promise.resolve();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("Place paint turns on once a square is chosen, and the reason goes away", async () => {
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose } = mount(services);
    await booted(root);
    const drawButton = root.querySelector<HTMLButtonElement>("#draw-button")!;
    expect(drawButton.disabled).toBe(true);
    expect(text(root, "#place-reason")).toBe("Choose a square on the wall first.");

    const focus = root.querySelector<HTMLElement>("#board-focus")!;
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(text(root, "#selection-summary")).toContain("Selected square x=0, y=0");
    expect(drawButton.disabled).toBe(false);
    expect(text(root, "#place-reason")).toBe("");
    // Messages caused by the dock land in the dock.
    expect(root.querySelector(".paint-dock #result")).not.toBeNull();
    dispose();
  });
});

describe("wall behaviour: paid board", () => {
  beforeEach(() => {
    fakeChain.schema = 4;
  });

  it("paid tap with a failing price read submits nothing and shows price unavailable", async () => {
    fakeChain.cellCost = () => new Error("429 rate limited");
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose } = mount(services);
    await booted(root);
    await vi.waitFor(() => expect(text(root, "#credits-balance")).toBe("Credits: 10"));
    expect(root.querySelector<HTMLElement>("#credits-dock")!.hidden).toBe(false);
    // Legend comes from get_tunables alone.
    await vi.waitFor(() =>
      expect(text(root, "#repaint-legend")).toBe(
        "Fresh cells cost more to repaint. Wait an hour and it is 1 credit again.",
      ),
    );

    api.enqueueUnsent(req(3, 4, 1));
    await api.kickDrain();

    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(root.querySelector("#result h3")?.textContent).toBe("Price unavailable");
    expect(root.querySelector("#result p")?.textContent).toBe(
      "The network could not return a fresh paint price. Nothing was submitted. Wait a moment, then try again.",
    );
    expect(text(root, "#cell-price")).toBe("price unavailable");
    expect(text(root, "#stroke-total")).toBe("price unavailable");
    expect(root.querySelector<HTMLButtonElement>("#draw-button")!.disabled).toBe(true);
    expect(api.pendingPaintCount()).toBe(0);
    expect(api.queueLength()).toBe(0);
    dispose();
  });

  it("paid tap with a working price read submits and re-reads credits afterwards (#29)", async () => {
    fakeChain.credits = ["10", "10", "9"];
    fakeChain.cellCost = () => 2;
    vi.mocked(submitDraw).mockImplementation(async (input) =>
      CONFIRMED_AT(input.x, input.y, input.colorIndex),
    );
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose } = mount(services);
    await booted(root);
    await vi.waitFor(() => expect(text(root, "#credits-balance")).toBe("Credits: 10"));

    api.enqueueUnsent(req(5, 6, 3));
    await api.kickDrain();

    expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitDraw).mock.calls[0]![0]).toMatchObject({ x: 5, y: 6, colorIndex: 3 });
    await vi.waitFor(() => expect(text(root, "#credits-balance")).toBe("Credits: 9"));
    expect(text(root, "#result")).toContain("Paint confirmed");
    expect(root.querySelector<HTMLButtonElement>("#draw-button")!.disabled).toBe(false);
    // The pre-submit quote put the cell price on screen.
    expect(fakeChain.views).toContain("get_cell_cost");
    expect(fakeChain.views.filter((v) => v === "get_credits").length).toBeGreaterThanOrEqual(3);
    dispose();
  });

  it("paid tap without enough credits opens Buy credits and submits nothing", async () => {
    fakeChain.credits = ["1", "1"];
    fakeChain.cellCost = () => 4;
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose } = mount(services);
    await booted(root);
    await vi.waitFor(() => expect(text(root, "#credits-balance")).toBe("Credits: 1"));

    api.enqueueUnsent(req(7, 7, 0));
    await api.kickDrain();

    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(root.querySelector("#result h3")?.textContent).toBe("Not enough credits");
    expect(root.querySelector("#result p")?.textContent).toBe(
      "This stroke needs 4 credits and this account has 1 credit. Nothing was submitted.",
    );
    expect(root.querySelector("#result button")?.textContent).toBe("Buy credits");
    expect(text(root, "#stroke-total")).toBe(
      "this stroke: 1 cell · 4 credits. This stroke needs 4 credits and this account has 1 credit. Nothing was submitted.",
    );
    expect(root.querySelector<HTMLElement>(".buy-credits-sheet")!.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>("#buy-credits-qty")!.value).toBe("3");
    dispose();
  });

  it("the credits dock asks for a wallet when nobody is connected", async () => {
    const services = createAppServices();
    controllableWallet(services, { accountId: null, networkId: null });
    const { root, dispose } = mount(services);
    await booted(root);
    await vi.waitFor(() => expect(text(root, "#credits-balance")).toBe("Credits: connect wallet"));
    expect(root.querySelector<HTMLButtonElement>("#buy-credits-button")!.disabled).toBe(true);
    expect(text(document.body, "#flow-state")).toBe(
      "Look around freely. Connect a wallet to paint.",
    );
    dispose();
  });
});

describe("wall behaviour: polling", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });

  it("backs off 4s → 8s → 16s after failed reads and reports the failure", async () => {
    const services = createAppServices();
    controllableWallet(services, { accountId: null, networkId: null });
    const { root, dispose } = mount(services);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    vi.mocked(fetchAllPaintedPixels).mockClear();
    vi.mocked(fetchAllPaintedPixels)
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockRejectedValueOnce(new Error("rpc still down"))
      .mockResolvedValue({ pixels: [], blockHeight: 9 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    expect(text(root, "#board-load-status")).toMatch(/^Board load failed: rpc down\./);
    expect(text(root, "#board-freshness")).toMatch(/^Wall updated .*The latest refresh failed; retrying\.$/);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(2);
    expect(text(root, "#board-load-status")).toMatch(/^Board load failed: rpc still down\./);

    await vi.advanceTimersByTimeAsync(15_999);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(3);
    expect(text(root, "#board-load-status")).toMatch(/^Board load: 0 painted cells at block 9\./);
    expect(text(root, "#board-freshness")).toMatch(/^Wall updated /);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(4);
    dispose();
  });
});

describe("wall behaviour: camera", () => {
  it("zoom-to-paint centres the board at paint zoom and Fit returns to the whole wall", async () => {
    const services = createAppServices();
    controllableWallet(services, { accountId: null, networkId: null });
    const { root, api, dispose } = mount(services);
    await booted(root);
    const readout = () => text(root, ".position-readout");
    const fit = root.querySelector<HTMLButtonElement>("#zoom-fit")!;
    const zoomIn = root.querySelector<HTMLButtonElement>("#zoom-in")!;
    const zoomOut = root.querySelector<HTMLButtonElement>("#zoom-out")!;

    // A 512 px viewport fits the 128-cell board at 3.875 px/cell (8 px inset).
    expect(readout()).toBe("Zoom 100% · Cell: none selected");
    expect(fit.disabled).toBe(true);
    api.paintZoom();
    expect(readout()).toBe("Zoom 516% · Cell: none selected");
    expect(text(document.body, "#compact-status")).toContain("~20.0 px/cell");
    expect(fit.disabled).toBe(false);
    const stage = root.querySelector<HTMLElement>("#board-stage")!;
    expect(stage.style.width).toBe("2560px");

    fit.click();
    expect(readout()).toBe("Zoom 100% · Cell: none selected");
    expect(text(document.body, "#compact-status")).toContain("~3.9 px/cell");
    expect(fit.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);

    zoomIn.click();
    expect(readout()).toBe("Zoom 115% · Cell: none selected");
    expect(fit.disabled).toBe(false);

    const focus = root.querySelector<HTMLElement>("#board-focus")!;
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    expect(readout()).toBe("Zoom 100% · Cell: none selected");
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    expect(readout()).toBe("Zoom 125% · Cell: none selected");
    dispose();
  });

  it("selecting a cell by tap moves the selection ring and readout", async () => {
    const services = createAppServices();
    controllableWallet(services, { accountId: null, networkId: null });
    const { root, dispose, viewport } = mount(services);
    await booted(root);
    root.querySelector<HTMLButtonElement>("#zoom-fit")!.click();
    touch(viewport, "pointerdown", 1, 48, 87);
    touch(viewport, "pointerup", 1, 48, 87);
    expect(text(root, "#selection-summary")).toContain("Selected square x=10, y=20");
    expect(text(root, ".position-readout")).toBe("Zoom 100% · Cell (10, 20)");
    const ring = root.querySelector<HTMLElement>("#selection-ring")!;
    expect(ring.hidden).toBe(false);
    expect(ring.style.left).toBe("46.75px");
    expect(ring.style.top).toBe("85.5px");
    expect(ring.style.width).toBe("3.875px");
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });
});

describe("wall behaviour: wallet changes", () => {
  it("wallet disconnect mid-paint cancels the queued paints but lets the in-flight one record", async () => {
    const pending = deferred<DrawResult>();
    vi.mocked(submitDraw).mockImplementation(() => pending.promise);
    const services = createAppServices();
    const wallet = controllableWallet(services, ALICE);
    const { root, api, dispose } = mount(services);
    await booted(root);

    api.enqueueUnsent(req(1));
    api.enqueueUnsent(req(2));
    api.enqueueUnsent(req(3));
    const drain = api.kickDrain();
    await vi.waitFor(() => expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1));
    expect(api.queueLength()).toBe(2);
    expect(api.pendingPaintCount()).toBe(3);

    wallet.emit({ accountId: null, networkId: null });

    expect(api.queueLength()).toBe(0);
    expect(api.pendingPaintCount()).toBe(1);
    expect(root.querySelector("#result h3")?.textContent).toBe("Queued paints cancelled");
    expect(root.querySelector("#result p")?.textContent).toBe("Wallet account or network changed.");
    expect(text(document.body, "#flow-state")).toBe(
      "Look around freely. Connect a wallet to paint.",
    );

    pending.resolve({
      status: "confirmation_delayed",
      title: "Delayed",
      message: "Still confirming",
      transactionId: "tx-mid",
      explorerUrl: null,
      pixel: null,
      observedBlockHeight: null,
    });
    await drain;
    expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1);
    expect(
      services.operations.list().find((op) => op.transactionId === "tx-mid")?.phase,
    ).toBe("confirmation_delayed");
    dispose();
  });

  it("a queued paint for a different account is dropped without a wallet prompt", async () => {
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, api, dispose } = mount(services);
    await booted(root);
    api.enqueueUnsent(
      createDrawRequest({ x: 9, y: 9, colorIndex: 1, accountId: "bob.testnet", networkId: "testnet" }),
    );
    await api.kickDrain();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(api.queueLength()).toBe(0);
    expect(api.pendingPaintCount()).toBe(0);
    dispose();
  });
});

describe("wall behaviour: dispose", () => {
  it("dispose removes every window, document and viewport listener and every timer", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    // Services exist before the mount (the wallet connector adds its own
    // window listeners), so build them before counting.
    const services = createAppServices();
    let subscribed = 0;
    let unsubscribed = 0;
    services.wallet = {
      getSession: () => ALICE,
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: (listener) => {
        subscribed += 1;
        listener(ALICE);
        return () => {
          unsubscribed += 1;
        };
      },
      whenReady: Promise.resolve(ALICE),
    };
    const live = new Map<EventTarget, Map<string, number>>();
    const bump = (target: EventTarget, type: string, delta: number) => {
      const byType = live.get(target) ?? new Map<string, number>();
      byType.set(type, (byType.get(type) ?? 0) + delta);
      live.set(target, byType);
    };
    // happy-dom's EventTarget is not the global one, and window carries its own
    // methods, so wrap the prototype elements use plus the window instance.
    let elementProto: object | null = document.createElement("div");
    while (elementProto && !Object.prototype.hasOwnProperty.call(elementProto, "addEventListener")) {
      elementProto = Object.getPrototypeOf(elementProto);
    }
    type Methods = {
      addEventListener: (...args: unknown[]) => void;
      removeEventListener: (...args: unknown[]) => void;
    };
    const restores: Array<() => void> = [];
    for (const host of [elementProto as unknown as Methods, window as unknown as Methods]) {
      const add = host.addEventListener;
      const remove = host.removeEventListener;
      host.addEventListener = function (this: EventTarget, ...args: unknown[]) {
        bump(this, String(args[0]), 1);
        return add.apply(this, args);
      };
      host.removeEventListener = function (this: EventTarget, ...args: unknown[]) {
        bump(this, String(args[0]), -1);
        return remove.apply(this, args);
      };
      restores.push(() => {
        host.addEventListener = add;
        host.removeEventListener = remove;
      });
    }

    try {
      const root = document.querySelector<HTMLElement>("#root")!;
      const dispose = mountWall(root, services);
      const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
      const name = (target: EventTarget) =>
        target === window ? "window" : target === document ? "document" : "viewport";
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      dispose();

      expect(live.get(viewport)?.size ?? 0).toBeGreaterThan(5);
      for (const target of [window, document, viewport] as EventTarget[]) {
        for (const [type, count] of live.get(target) ?? []) {
          expect({ target: name(target), type, count }).toEqual({ target: name(target), type, count: 0 });
        }
      }
      // The wall and its buy-credits sheet each subscribe once; both let go.
      expect(subscribed).toBe(2);
      expect(unsubscribed).toBe(2);
      // Placement-outcome layer timers and the board poll are all gone.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(root.childElementCount).toBe(0);
    } finally {
      for (const restore of restores) restore();
    }
  });
});

describe("wall modes and the dock's primary action (Phase 1 step 1)", () => {
  const SIGNED_OUT = { accountId: null, networkId: null } as unknown as Session;

  function stageTransform(root: HTMLElement): string {
    return root.querySelector<HTMLElement>("#board-stage")!.style.transform;
  }

  it("opens in Look: a tap shows the tile and never paints, even with painting armed", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose, viewport } = mount(services, undefined, "look");
    await booted(root);
    expect(root.querySelector<HTMLElement>(".wall-page")!.dataset.mode).toBe("look");
    root.querySelectorAll<HTMLButtonElement>(".swatch")[2]!.click();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked).toBe(true),
    );

    touch(viewport, "pointerdown", 1, 260, 260);
    touch(viewport, "pointerup", 1, 260, 260);

    expect(text(root, "#selection-summary")).toContain("Selected square");
    await Promise.resolve();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(vi.mocked(signAndSendStrokeLocally)).not.toHaveBeenCalled();
    dispose();
  });

  it("in Look a one-finger drag moves the wall and paints nothing", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose, viewport } = mount(services, undefined, "look");
    await booted(root);
    root.querySelectorAll<HTMLButtonElement>(".swatch")[4]!.click();
    root.querySelector<HTMLButtonElement>("#zoom-in")!.click();
    root.querySelector<HTMLButtonElement>("#zoom-in")!.click();
    const before = stageTransform(root);

    touch(viewport, "pointerdown", 1, 200, 200);
    touch(viewport, "pointermove", 1, 260, 230);
    touch(viewport, "pointermove", 1, 300, 260);
    touch(viewport, "pointerup", 1, 300, 260);

    expect(stageTransform(root)).not.toBe(before);
    expect(vi.mocked(signAndSendStrokeLocally)).not.toHaveBeenCalled();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("Move turns a Paint drag into a pan, and a tap with Move on never paints", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose, viewport } = mount(services);
    await booted(root);
    const move = root.querySelector<HTMLButtonElement>("#wall-move")!;
    expect(move.hidden).toBe(false);
    root.querySelectorAll<HTMLButtonElement>(".swatch")[4]!.click();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked).toBe(true),
    );
    root.querySelector<HTMLButtonElement>("#zoom-in")!.click();
    root.querySelector<HTMLButtonElement>("#zoom-in")!.click();

    move.click();
    expect(move.getAttribute("aria-pressed")).toBe("true");
    const before = stageTransform(root);
    touch(viewport, "pointerdown", 1, 200, 200);
    touch(viewport, "pointermove", 1, 260, 230);
    touch(viewport, "pointermove", 1, 300, 260);
    touch(viewport, "pointerup", 1, 300, 260);
    expect(stageTransform(root)).not.toBe(before);

    touch(viewport, "pointerdown", 2, 250, 250);
    touch(viewport, "pointerup", 2, 250, 250);
    await Promise.resolve();
    expect(vi.mocked(signAndSendStrokeLocally)).not.toHaveBeenCalled();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();

    // Back to Look: Move switches off and hides.
    root.querySelector<HTMLButtonElement>("#wall-mode-look")!.click();
    expect(move.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".wall-page")!.dataset.moving).toBe("false");
    dispose();
  });

  it("Enter in Look opens Paint instead of sending anything", async () => {
    const services = createAppServices();
    controllableWallet(services, ALICE);
    const { root, dispose } = mount(services, undefined, "look");
    await booted(root);
    root.querySelectorAll<HTMLButtonElement>(".swatch")[1]!.click();
    const focus = root.querySelector<HTMLElement>("#board-focus")!;
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.querySelector<HTMLElement>(".wall-page")!.dataset.mode).toBe("paint");
    await Promise.resolve();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("the dock shows one primary action, labelled by state", async () => {
    const services = createAppServices();
    const wallet = controllableWallet(services, SIGNED_OUT);
    const { root, dispose } = mount(services);
    await booted(root);
    const primary = root.querySelector<HTMLButtonElement>("#dock-primary")!;
    const action = root.querySelector<HTMLElement>(".wall-action")!;
    const drawButton = root.querySelector<HTMLButtonElement>("#draw-button")!;

    await vi.waitFor(() => expect(primary.textContent).toBe("Connect wallet to paint"));
    expect(primary.hidden).toBe(false);
    expect(action.dataset.primary).toBe("connect");

    wallet.emit(ALICE);
    await vi.waitFor(() => expect(primary.textContent).toBe("Pick a colour"));
    expect(primary.disabled).toBe(true);

    root.querySelectorAll<HTMLButtonElement>(".swatch")[3]!.click();
    await vi.waitFor(() => expect(action.dataset.primary).toBe("place"));
    expect(primary.hidden).toBe(true);
    expect(drawButton.textContent).toBe("Paint this tile");
    dispose();
  });
});
