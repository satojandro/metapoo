/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createDrawRequest } from "../../draw-request";
import { createRouter } from "../../app/router";
import { clearPageMounts, registerPageMount } from "../../app/page-registry";
import { matchRoute } from "../../app/routes";
import { buildHelpPaintDeepLink } from "../bounties/deep-link";
import {
  mountWall,
  mountWallPage,
  type WallMountTestApi,
} from "./mount-wall";

vi.mock("../../submit-draw", () => ({
  submitDraw: vi.fn(),
}));

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    // Allow prepareDraw past ContractNotConfigured without a live deployment.
    CONTRACT_ID: "board.test.near",
  };
});

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    getBoard: vi.fn(async () => ({
      schema_version: 2,
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
    fetchAllPaintedPixels: vi.fn(async () => ({
      pixels: [],
      blockHeight: 1,
    })),
    getPixelWithBlock: vi.fn(async (x: number, y: number) => ({
      pixel: {
        x,
        y,
        colorIndex: null,
        artistAccountId: null,
        lastWriteTimestampNs: null,
      },
      blockHeight: 1,
    })),
  };
});

import { submitDraw } from "../../submit-draw";
import { fetchAllPaintedPixels } from "../../contract";

describe("mountWall dispose", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    vi.mocked(submitDraw).mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("clears the wall DOM and does not clear shared operations", () => {
    const services = createAppServices();
    services.operations.upsert({
      id: "paint:keep",
      kind: "paint",
      phase: "submitted",
      accountId: "alice.testnet",
      networkId: "testnet",
      transactionId: "tx-keep",
      title: "Paint",
      detail: "must survive dispose",
    });

    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    expect(root.querySelector("#board")).not.toBeNull();
    expect(root.querySelector("#palette")).not.toBeNull();

    dispose();
    expect(root.querySelector("#board")).toBeNull();
    expect(root.childElementCount).toBe(0);
    expect(services.operations.listRecoverable()).toHaveLength(1);
    expect(services.operations.get("paint:keep")?.transactionId).toBe("tx-keep");
  });

  it("is safe to call dispose twice", () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it("does not submit paint after a board drag", () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;

    // happy-dom does not implement pointer capture, but the browser surface
    // does. The gesture must still distinguish a drag from a tap.
    Object.assign(viewport, {
      setPointerCapture: vi.fn(),
    });
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, {
        pointerId: 1,
        clientX: x,
        clientY: y,
      });
      viewport.dispatchEvent(event);
    };

    pointer("pointerdown", 30, 30);
    pointer("pointermove", 60, 30);
    pointer("pointerup", 60, 30);

    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    expect(root.querySelector("#selection-summary")?.textContent).toContain(
      "No square selected",
    );
    dispose();
  });

  it("paint-zoom tap does not bypass the Direct paint consent toggle", async () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    const toggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;

    // regression: isPaintZoom(camera) used to short-circuit the toggle check,
    // letting a tap at >=16px cells submit without explicit consent.
    // Simulate paint zoom (cellSize >= PAINT_MIN_CELL_PX = 16).
    toggle.checked = false;
    toggle.disabled = false;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    const tap = (x: number, y: number) => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new Event(type, { bubbles: true });
        Object.assign(event, { pointerId: 1, clientX: x, clientY: y });
        viewport.dispatchEvent(event);
      }
    };
    // zoom the camera to paint zoom via the zoom-in control enough times to
    // exceed the 16px floor, then tap an empty cell.
    const zoomIn = root.querySelector<HTMLButtonElement>("#zoom-in")!;
    for (let i = 0; i < 6; i++) {
      zoomIn.click();
    }
    // allow the async post-selection refresh to flush
    await vi.waitFor(() => {
      tap(40, 40);
      expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    });
    // and with the toggle ON, paint zoom taps still work through the session
    // path (not asserted here: session gating is covered by session tests).
    dispose();
  });

  it("keeps corner and centre hit testing aligned through phone/desktop fit, paint zoom, pan, and resize", () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(): void {
          resizeCallbacks.add(this.callback);
        }
        disconnect(): void {
          resizeCallbacks.delete(this.callback);
        }
        unobserve(): void {}
      },
    );

    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });

    let width = 390;
    let height = 480;
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          width,
          height,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }

    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId: 1, clientX: x, clientY: y });
      viewport.dispatchEvent(event);
    };
    const tap = (x: number, y: number) => {
      pointer("pointerdown", x, y);
      pointer("pointerup", x, y);
    };
    const expectSelection = (x: number, y: number) => {
      expect(root.querySelector("#selection-summary")?.textContent).toContain(
        `Selected square x=${x}, y=${y}`,
      );
    };

    // The fitted 390px-wide view has an 8px horizontal margin; both the first
    // and centre logical cells must still resolve through the mount's transform.
    tap(8 + 374 / 256, 53 + 374 / 256);
    expectSelection(0, 0);
    tap(195, 240);
    expectSelection(64, 64);

    root.querySelector<HTMLButtonElement>("#zoom-paint")!.click();
    const ring = root.querySelector<HTMLElement>("#selection-ring")!;
    expect(ring.style.width).toBe("20px");
    expect(ring.style.height).toBe("20px");
    // The ring's box remains the cell itself: its visual affordance is CSS
    // outward shadow, so it cannot cover the canvas pixels inside this box.
    expect(ring.style.background).toBe("");
    expect(ring.style.border).toBe("");

    // Panning is classified as a gesture, never a selection, then a centre tap
    // hits the projected cell at the new camera origin.
    pointer("pointerdown", 195, 240);
    pointer("pointermove", 100, 120);
    pointer("pointerup", 100, 120);
    tap(100, 120);
    expectSelection(64, 64);

    // Resize while zoomed: retain the camera, clamp it to desktop bounds, and
    // prove both opposite corners remain selectable after deliberate pans.
    width = 1200;
    height = 800;
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    pointer("pointerdown", 600, 400);
    pointer("pointermove", 3000, 3000);
    pointer("pointerup", 3000, 3000);
    tap(10, 10);
    expectSelection(0, 0);

    pointer("pointerdown", 600, 400);
    pointer("pointermove", -2000, -2000);
    pointer("pointerup", -2000, -2000);
    tap(1190, 790);
    expectSelection(127, 127);
    expect(ring.style.width).toBe("20px");
    expect(ring.style.height).toBe("20px");

    dispose();
    vi.unstubAllGlobals();
  });

  it("clears unsent queue paints when navigating away during a pending draw", async () => {
    type DrawResult = Awaited<ReturnType<typeof submitDraw>>;
    const deferred: {
      promise: Promise<DrawResult>;
      resolve: (value: DrawResult) => void;
    } = {
      promise: null as unknown as Promise<DrawResult>,
      resolve: () => undefined,
    };
    deferred.promise = new Promise<DrawResult>((resolve) => {
      deferred.resolve = resolve;
    });
    vi.mocked(submitDraw).mockImplementation(() => deferred.promise);

    let api: WallMountTestApi | null = null;
    const root = document.querySelector<HTMLElement>("#root")!;

    // Wallet stub with a stable account so drawRequestMatchesSession passes.
    const stubServices = createAppServices();
    let accountId: string | null = "alice.testnet";
    let networkId: string | null = "testnet";
    const listeners = new Set<(s: { accountId: string | null; networkId: string | null }) => void>();
    stubServices.wallet = {
      getSession: () => ({ accountId, networkId }),
      connect: async () => {
        accountId = "alice.testnet";
        networkId = "testnet";
        for (const listener of listeners) {
          listener({ accountId, networkId });
        }
      },
      disconnect: async () => {
        accountId = null;
        networkId = null;
        for (const listener of listeners) {
          listener({ accountId, networkId });
        }
      },
      subscribe: (listener) => {
        listeners.add(listener);
        listener({ accountId, networkId });
        return () => listeners.delete(listener);
      },
    };

    const dispose = mountWall(root, stubServices, {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });
    expect(api).not.toBeNull();
    // Let bootstrapBoard finish so contractMetaOk is true.
    await vi.waitFor(() => {
      expect(root.querySelector("#board-load-status")?.textContent ?? "").not.toMatch(
        /fetching painted pages/i,
      );
    });

    const req = (x: number) =>
      createDrawRequest({
        x,
        y: 0,
        colorIndex: 2,
        accountId: "alice.testnet",
        networkId: "testnet",
      });

    api!.enqueueUnsent(req(1));
    api!.enqueueUnsent(req(2));
    api!.enqueueUnsent(req(3));
    expect(api!.queueLength()).toBe(3);

    const drainPromise = api!.kickDrain();
    // First item shifted and in flight; two remain queued.
    await vi.waitFor(() => {
      expect(vi.mocked(submitDraw).mock.calls.length).toBe(1);
    });
    expect(api!.queueLength()).toBe(2);

    // Navigate away / dispose while the first paint is still pending.
    dispose();
    expect(api!.queueLength()).toBe(0);

    deferred.resolve({
      status: "confirmation_delayed",
      title: "Delayed",
      message: "Still confirming",
      transactionId: "tx-pending-1",
      explorerUrl: null,
      pixel: null,
      observedBlockHeight: null,
    });
    await drainPromise;
    await Promise.resolve();

    // Remaining paints must not have been submitted after dispose.
    expect(vi.mocked(submitDraw).mock.calls.length).toBe(1);
    expect(
      stubServices.operations.list().some((op) => op.transactionId === "tx-pending-1"),
    ).toBe(true);
  });
});

describe("mountWall board polling", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    vi.mocked(fetchAllPaintedPixels).mockResolvedValue({
      pixels: [],
      blockHeight: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function mountAfterInitialRead(): Promise<{
    dispose: () => void;
    root: HTMLElement;
  }> {
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, createAppServices());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    vi.mocked(fetchAllPaintedPixels).mockClear();
    return { dispose, root };
  }

  it("reads again on the visible-tab interval", async () => {
    const { dispose, root } = await mountAfterInitialRead();

    await vi.advanceTimersByTimeAsync(4_000);

    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    expect(root.querySelector("#board-freshness")?.textContent).toMatch(
      /last updated/i,
    );
    dispose();
  });

  it("pauses while hidden and reads immediately when visible again", async () => {
    const { dispose } = await mountAfterInitialRead();

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(fetchAllPaintedPixels)).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("backs off after failed reads and returns to the normal interval after success", async () => {
    const { dispose, root } = await mountAfterInitialRead();
    vi.mocked(fetchAllPaintedPixels)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ pixels: [], blockHeight: 2 })
      .mockResolvedValue({ pixels: [], blockHeight: 3 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(root.querySelector("#board-freshness")?.textContent).toMatch(/failed/i);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(2);
    expect(root.querySelector("#board-freshness")?.textContent).not.toMatch(/failed/i);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("keeps an unconfirmed pending paint when a poll supplies no confirmation", async () => {
    let api: WallMountTestApi | null = null;
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, createAppServices(), {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetchAllPaintedPixels).mockClear();
    api!.enqueueUnsent(
      createDrawRequest({
        x: 1,
        y: 1,
        colorIndex: 2,
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    );

    await vi.advanceTimersByTimeAsync(4_000);

    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    expect(api!.pendingPaintCount()).toBe(1);
    dispose();
  });
});

describe("mountWall Help-paint deep link via router", () => {
  beforeEach(() => {
    clearPageMounts();
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="outlet"></div>
    `;
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    clearPageMounts();
    document.body.innerHTML = "";
  });

  it("applies bounty Help-paint coordinates through the actual router", () => {
    registerPageMount("home", (root) => {
      root.textContent = "home";
      return () => root.replaceChildren();
    });
    registerPageMount("wall", mountWallPage);

    const services = createAppServices();
    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services });
    router.start();

    const href = buildHelpPaintDeepLink({
      board: "board.mpoo.testnet",
      x: 40,
      y: 20,
      zoom: 16,
      bounty: "7",
      template: "tmpl-demo",
    });
    router.navigate(href);

    expect(matchRoute(window.location.pathname, window.location.search).pageId).toBe(
      "wall",
    );
    const summary = outlet.querySelector("#selection-summary");
    expect(summary?.textContent).toMatch(/Selected square x=40, y=20/);
    const status = outlet.querySelector("#board-load-status");
    expect(status?.textContent).toMatch(/Bounty context 7/);
    expect(status?.textContent).toMatch(/Template id tmpl-demo/);

    router.stop();
  });
});
