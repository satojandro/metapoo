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

import { signAndSendStrokeLocally } from "../../local-draw";

vi.mock("../../submit-draw", () => ({
  submitDraw: vi.fn(),
}));

vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    // Direct paint is off unless a test turns it on AND dispatches the toggle
    // change (mount-wall mirrors the toggle into `tapToPaintEnabled` on change).
    canUseLocalDrawingSession: vi.fn(() => false),
    fetchDrawingSessionAllowance: vi.fn(async () => ({ found: true, remainingYocto: null, permissionSummary: "" })),
    // Stroke submission is asserted; it must never really sign in unit tests.
    signAndSendStrokeLocally: vi.fn(async () => ({ status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [], failingChunk: null })),
  };
});

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
import { fetchAllPaintedPixels, getBoard, getPixelWithBlock } from "../../contract";
import { canUseLocalDrawingSession } from "../../local-draw";

describe("mountWall dispose", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    vi.mocked(submitDraw).mockReset();
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function connectedWallServices() {
    const services = createAppServices();
    const connect = vi.fn(async () => undefined);
    services.wallet = {
      getSession: () => ({ accountId: "alice.testnet", networkId: "testnet" }),
      connect,
      disconnect: async () => undefined,
      subscribe: (listener) => {
        listener({ accountId: "alice.testnet", networkId: "testnet" });
        return () => undefined;
      },
      whenReady: Promise.resolve({
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    };
    return { services, connect };
  }

  function touchPointer(
    viewport: HTMLElement,
    type: "pointerdown" | "pointermove" | "pointerup",
    pointerId: number,
    x: number,
    y: number,
  ): void {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId, clientX: x, clientY: y, pointerType: "touch" });
    viewport.dispatchEvent(event);
  }

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

  it("routes one stationary touch tap through the existing draw path, without a touch preview", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    vi.mocked(submitDraw).mockResolvedValue({
      status: "confirmation_delayed",
      title: "Delayed",
      message: "Still confirming",
      transactionId: "tx-touch-1",
      explorerUrl: null,
      pixel: null,
      observedBlockHeight: null,
    });
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 512, bottom: 512, width: 512, height: 512,
    } as DOMRect);
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    root.querySelector<HTMLButtonElement>("#zoom-paint")!.click();
    // A drawing session exists, so Direct paint is on without a second
    // decision (product decision 2026-10-27). Wait for it rather than poking
    // the checkbox, so the negative assertions below stay meaningful.
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    touchPointer(viewport, "pointerdown", 1, 40, 40);
    touchPointer(viewport, "pointerup", 1, 40, 40);

    await vi.waitFor(() => expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1));
    expect(root.querySelector<HTMLElement>(".pointer-preview")?.hidden).toBe(true);
    expect(root.querySelector("[data-placement-outcomes]")?.textContent).toMatch(/confirmation delayed/i);
    dispose();
  });

  it("never submits paint for a multi-touch pinch", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 512, bottom: 512, width: 512, height: 512,
    } as DOMRect);
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    root.querySelector<HTMLButtonElement>("#zoom-paint")!.click();
    // A drawing session exists, so Direct paint is on without a second
    // decision (product decision 2026-10-27). Wait for it rather than poking
    // the checkbox, so the negative assertions below stay meaningful.
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    touchPointer(viewport, "pointerdown", 1, 40, 40);
    touchPointer(viewport, "pointerdown", 2, 80, 80);
    touchPointer(viewport, "pointermove", 2, 130, 130);
    touchPointer(viewport, "pointerup", 2, 130, 130);
    touchPointer(viewport, "pointerup", 1, 40, 40);
    await Promise.resolve();

    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores a sub-threshold touch tap whose release lands in another fitted cell", () => {
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

    // A 200px-wide fitted view of the 128-cell board is ~1.44 px per cell, so
    // movement under the 8px tap threshold can still cross cell boundaries.
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 480,
      width: 200,
      height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }

    const summary = () => root.querySelector("#selection-summary")?.textContent ?? "";

    // The tap that stays inside one cell still selects it.
    touchPointer(viewport, "pointerdown", 1, 60, 200);
    touchPointer(viewport, "pointerup", 1, 60, 200);
    expect(summary()).toContain("Selected square x=36, y=36");

    // 4px of movement is a tap by threshold, but it releases over cell 38:
    // a sub-threshold move across a cell edge is a scroll, never a placement.
    touchPointer(viewport, "pointerdown", 1, 60, 200);
    touchPointer(viewport, "pointerup", 1, 64, 200);
    expect(summary()).toContain("Selected square x=36, y=36");

    dispose();
    vi.unstubAllGlobals();
  });

  it("keeps tap-to-paint state in this mount without requesting a wallet or draw", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const { services, connect } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const toggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;
    const affordance = toggle.closest<HTMLElement>("label")!;

    // Availability is no longer signalled by a disabled control: wait for the
    // live status line that replaced it.
    await vi.waitFor(() =>
      expect(toggle.checked).toBe(true),
    );

    expect(affordance.hidden).toBe(false);
    expect(toggle.disabled).toBe(false);
    window.dispatchEvent(new Event("online"));

    expect(toggle.checked).toBe(true);
    expect(root.querySelector("#tap-to-paint-status")?.textContent).toMatch(
      /drag or click to paint/i,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("paint-zoom tap does not bypass an explicit Direct paint opt-out", async () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    const toggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;

    // regression: isPaintZoom(camera) used to short-circuit the toggle check,
    // letting a tap at >=16px cells submit without consent.
    // Direct paint now defaults ON whenever a drawing session exists (product
    // decision 2026-10-27), so the guard under test is "an explicit opt-out is
    // honoured", and an opt-out arrives as a change event, not a DOM poke.
    // Simulate paint zoom (cellSize >= PAINT_MIN_CELL_PX = 16).
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
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
      whenReady: Promise.resolve({ accountId, networkId }),
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

  it("offers one-approval unlock in the dock instead of a dead Direct paint toggle", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
    const { services, connect } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);

    const unlock = root.querySelector<HTMLElement>("#paint-unlock")!;
    await vi.waitFor(() => expect(unlock.hidden).toBe(false));

    // The affordance has to be where the user is painting. The whole reason it
    // existed invisibly was that it lived inside <details>About / details.
    expect(unlock.closest("details")).toBeNull();
    expect(unlock.closest(".paint-dock")).not.toBeNull();

    // A control that cannot be used must not sit there looking usable.
    expect(
      root.querySelector("#direct-paint-toggle")!.closest("label")!.hidden,
    ).toBe(true);

    // No developer-facing copy in the dock.
    const dock = root.querySelector(".paint-dock")!;
    expect(dock.textContent).not.toMatch(/no wallet request was made/i);
    expect(dock.textContent).not.toMatch(/drawing session/i);

    root.querySelector<HTMLButtonElement>("#unlock-paint-button")!.click();
    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith({ authorizeDrawingSession: true }),
    );
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("defaults Direct paint on once a session exists and keeps an override off", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const services = createAppServices();
    type WalletListener = (session: {
      accountId: string | null;
      networkId: string | null;
    }) => void;
    let emit: WalletListener | null = null;
    services.wallet = {
      getSession: () => ({ accountId: "alice.testnet", networkId: "testnet" }),
      connect: vi.fn(async () => undefined),
      disconnect: async () => undefined,
      subscribe: (listener) => {
        emit = listener as WalletListener;
        listener({ accountId: "alice.testnet", networkId: "testnet" });
        return () => undefined;
      },
      whenReady: Promise.resolve({
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    };
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const toggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;
    const status = root.querySelector<HTMLElement>("#tap-to-paint-status")!;

    // A pre-approved session means painting is live without a second decision.
    await vi.waitFor(() => expect(toggle.checked).toBe(true));
    expect(root.querySelector<HTMLElement>("#paint-unlock")!.hidden).toBe(true);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/drag or click to paint/i);

    // An explicit "no" is honoured, and survives a wallet re-emit.
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    emit!({ accountId: "alice.testnet", networkId: "testnet" });
    expect(toggle.checked).toBe(false);
    expect(status.textContent).toMatch(/place paint/i);

    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });
  it("paints a drag at fitted zoom, with no paint-zoom precondition", async () => {
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
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    // 200 / 128 = ~1.56 px per cell: far below PAINT_MIN_CELL_PX (16). Drag used
    // to pan here no matter what, because paint zoom was part of the arm gate.
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 480, width: 200, height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    touchPointer(viewport, "pointerdown", 1, 60, 200);
    touchPointer(viewport, "pointermove", 1, 80, 200);
    touchPointer(viewport, "pointermove", 1, 100, 200);
    touchPointer(viewport, "pointerup", 1, 100, 200);

    await vi.waitFor(() =>
      expect(vi.mocked(signAndSendStrokeLocally)).toHaveBeenCalledTimes(1),
    );
    expect(vi.mocked(submitDraw)).not.toHaveBeenCalled();
    dispose();
  });

  it("still pans a drag while painting is armed when space is held", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 512, bottom: 512, width: 512, height: 512,
    } as DOMRect);
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    touchPointer(viewport, "pointerdown", 1, 40, 40);
    touchPointer(viewport, "pointermove", 1, 120, 40);
    touchPointer(viewport, "pointerup", 1, 200, 40);
    await Promise.resolve();

    expect(vi.mocked(signAndSendStrokeLocally)).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    dispose();
  });
  it("stops showing Place paint while Direct paint is armed, and keeps the unlock visible", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const place = root.querySelector<HTMLButtonElement>("#draw-button")!;
    const unlocked = root.querySelector<HTMLElement>("#paint-unlocked")!;
    const toggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;

    // Armed: clicking a cell already paints, so a Place button contradicts the
    // status line right above it.
    await vi.waitFor(() => expect(place.hidden).toBe(true));
    expect(unlocked.hidden).toBe(false);
    expect(unlocked.textContent).toMatch(/no wallet popup per pixel/i);

    // The one-approval prompt is gone after use, but the state must not be:
    // a vanished prompt with no confirmation reads as "did that work?".

    // Opting out of direct paint brings back the only pointer path.
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(place.hidden).toBe(false);
    expect(unlocked.hidden).toBe(false);
    dispose();
  });
  it("queues a second tap while the first paint is still confirming", async () => {
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
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const pixel = (x: number, y: number) => ({
      x, y, colorIndex: 0, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1",
    });
    const settled = {
      status: "confirmed" as const, title: "Placed", message: "Placed",
      transactionId: "tx", explorerUrl: null, validated_deposit: undefined,
      pixel: pixel(1, 1), observedBlockHeight: 9,
    };
    let releaseFirst: (value: unknown) => void = () => undefined;
    const firstInFlight = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(submitDraw)
      .mockReset()
      .mockReturnValueOnce(firstInFlight as never)
      .mockResolvedValue(settled as never);

    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 480, width: 200, height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    const tap = (x: number, y: number) => {
      touchPointer(viewport, "pointerdown", 1, x, y);
      touchPointer(viewport, "pointerup", 1, x, y);
    };

    tap(60, 200);
    await vi.waitFor(() => expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1));
    // Second deliberate tap arrives while the first transaction is unresolved.
    // It must be queued, not dropped: dropping it made the board feel dead
    // until the previous paint landed.
    tap(90, 200);
    expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(1);

    releaseFirst(settled);
    await vi.waitFor(() => expect(vi.mocked(submitDraw)).toHaveBeenCalledTimes(2));
    dispose();
  });
  it("stamps a confirmed stroke from its receipt, without waiting for a board read", async () => {
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
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    // Hold every *subsequent* full board read open: anything visible in the
    // cache below can only have come from the transaction receipt. The first
    // read must resolve, or bootstrap never validates the contract metadata.
    vi.mocked(fetchAllPaintedPixels)
      .mockResolvedValueOnce({ pixels: [], blockHeight: 1 } as never)
      .mockReturnValue(new Promise(() => undefined) as never);
    vi.mocked(signAndSendStrokeLocally).mockResolvedValue({
      status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [],
      failingChunk: null, executedBlocks: [{ chunkIndex: 0, blockHeight: 4321 }],
    });

    let api: WallMountTestApi | null = null;
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services, {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 480, width: 200, height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    root.querySelector<HTMLButtonElement>(".swatch")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("#direct-paint-toggle")!.checked,
      ).toBe(true),
    );

    touchPointer(viewport, "pointerdown", 1, 60, 200);
    touchPointer(viewport, "pointermove", 1, 80, 200);
    touchPointer(viewport, "pointerup", 1, 100, 200);

    await vi.waitFor(() =>
      expect(vi.mocked(signAndSendStrokeLocally)).toHaveBeenCalledTimes(1),
    );
    const painted = vi.mocked(signAndSendStrokeLocally).mock.calls[0][0].cells;
    expect(painted.length).toBeGreaterThan(1);

    await vi.waitFor(() => {
      // No pending marker left, and the cell reads back its colour at the
      // executed block — with the authoritative read still outstanding.
      expect(api!.pendingPaintCount()).toBe(0);
      expect(api!.cachedPixelColor(painted[0])).toBe(0);
    });
    dispose();
  });
  it("explains the contract and the board legend in plain language", async () => {
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);

    const line = root.querySelector<HTMLElement>("#wall-contract-line")!;
    await vi.waitFor(() => expect(line.textContent).toMatch(/board\.test\.near/));
    expect(line.textContent).toMatch(/every square is stored/i);
    expect(line.textContent).toMatch(/replaces the colour/i);
    expect(line.textContent).toMatch(/which account painted it and when/i);

    // The legend has to name the states a player can actually see.
    const legend = root.querySelector(".board-legend")!.textContent ?? "";
    expect(legend).toMatch(/magenta corner dot/i);
    expect(legend).toMatch(/ring marks the square/i);
    dispose();
  });

  it("tells you which precondition is missing when a drag does not paint", async () => {
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
    // No session here, so Direct paint is off and the drag will pan.
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 512, bottom: 512, width: 512, height: 512,
      toJSON: () => ({}),
    } as DOMRect);
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);

    touchPointer(viewport, "pointerdown", 1, 200, 200);

    expect(root.querySelector("#draw-state")!.textContent).toMatch(
      /direct paint is off/i,
    );
    expect(vi.mocked(signAndSendStrokeLocally)).not.toHaveBeenCalled();
    dispose();
  });
  it("recovers from a failed board read when Refresh is pressed", async () => {
    // The boot path validates get_board once. A transient failure used to leave
    // drawing disabled until a full page reload; Refresh now re-validates.
    vi.mocked(getBoard).mockRejectedValueOnce(new Error("rpc rate limited"));
    const { services } = connectedWallServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);

    const line = () => root.querySelector("#wall-contract-line")!.textContent ?? "";
    await vi.waitFor(() => expect(root.querySelector("#board-load-status")!.textContent).toMatch(/failed/i));
    expect(line()).not.toMatch(/board\.test\.near/);

    vi.mocked(getBoard).mockClear();
    root.querySelector<HTMLButtonElement>("#refresh-board")!.click();
    await vi.waitFor(() => expect(vi.mocked(getBoard)).toHaveBeenCalled());
    await vi.waitFor(() => expect(line()).toMatch(/board\.test\.near/));
    dispose();
  });});

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

  it("refreshes immediately when the browser reconnects", async () => {
    const { dispose } = await mountAfterInitialRead();

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(fetchAllPaintedPixels)).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("discards a late selected-cell read after a newer full refresh", async () => {
    let api: WallMountTestApi | null = null;
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, createAppServices(), {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetchAllPaintedPixels).mockClear();

    let resolveCellRead!: (value: {
      pixel: {
        x: number;
        y: number;
        colorIndex: number | null;
        artistAccountId: string | null;
        lastWriteTimestampNs: string | null;
      };
      blockHeight: number;
    }) => void;
    vi.mocked(getPixelWithBlock).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCellRead = resolve;
      }),
    );
    const lateRead = api!.refreshPixel({ x: 3, y: 4 });

    vi.mocked(fetchAllPaintedPixels).mockResolvedValueOnce({
      pixels: [{
        x: 3,
        y: 4,
        colorIndex: 6,
        artistAccountId: "newer.testnet",
        lastWriteTimestampNs: "2",
      }],
      blockHeight: 2,
    });
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    resolveCellRead({
      pixel: {
        x: 3,
        y: 4,
        colorIndex: 1,
        artistAccountId: "older.testnet",
        lastWriteTimestampNs: "1",
      },
      blockHeight: 1,
    });
    await lateRead;

    expect(api!.cachedPixelColor({ x: 3, y: 4 })).toBe(6);
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

describe("mounted paint strokes", () => {
  it.each(["drag", "tap", "pinch", "wheel", "cancel", "same-cell-drag"])("handles %s without accidental single-cell draws", async (kind) => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.mocked(submitDraw).mockReset().mockResolvedValue({ status: "confirmation_delayed", title: "Pending", message: "Pending", transactionId: null, explorerUrl: null, pixel: null, observedBlockHeight: null });
    vi.mocked(signAndSendStrokeLocally).mockClear();
    const services = createAppServices();
    services.wallet.subscribe = listener => {
      listener({ accountId: "alice.testnet", networkId: "testnet" });
      return () => {};
    };
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    await vi.waitFor(() => expect(root.querySelector("#board-load-status")?.textContent).toContain("painted cell"));
    const viewport = root.querySelector<HTMLElement>("#board-viewport")!;
    Object.assign(viewport, { setPointerCapture: vi.fn() });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 390, height: 480 } as DOMRect);
    root.querySelector<HTMLButtonElement>("#zoom-paint")!.click();
    root.querySelector<HTMLButtonElement>("#palette button")!.click();
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
    const paintToggle = root.querySelector<HTMLInputElement>("#direct-paint-toggle")!;
    paintToggle.checked = true;
    paintToggle.dispatchEvent(new Event("change"));
    const pointer = (type: string, x: number, id = 1) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId: id, clientX: x, clientY: 240 });
      viewport.dispatchEvent(event);
    };
    pointer("pointerdown", 195);
    expect(submitDraw).not.toHaveBeenCalled();
    expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    if (kind === "pinch") pointer("pointerdown", 215, 2);
    if (kind === "wheel") viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    const endX = kind === "same-cell-drag" ? 204 : kind === "tap" ? 195 : 255;
    if (kind !== "tap") pointer("pointermove", endX);
    expect(submitDraw).not.toHaveBeenCalled();
    expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    pointer(kind === "cancel" ? "pointercancel" : "pointerup", endX);
    if (kind === "pinch") pointer("pointerup", 215, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (kind === "drag") {
      expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1);
      expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0][0]).toMatchObject({
        cells: [{ x: 64, y: 64 }, { x: 65, y: 64 }, { x: 66, y: 64 }, { x: 67, y: 64 }],
        accountId: "alice.testnet", color: 0,
      });
      expect(submitDraw).not.toHaveBeenCalled();
    } else if (kind === "tap") {
      expect(submitDraw).toHaveBeenCalledTimes(1);
      expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    } else {
      expect(submitDraw).not.toHaveBeenCalled();
      expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    }
    dispose();
  });
});
