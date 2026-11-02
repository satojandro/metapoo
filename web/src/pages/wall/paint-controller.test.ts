/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createDrawRequest } from "../../draw-request";
import type { Cell } from "../../selection";
import { createPaintController } from "./paint-controller";
import type { CreditReservation, PaidQuote } from "./pricing-controller";
import type { UiPhase } from "./wall-view";
import { createWallScope } from "./wall-scope";

vi.mock("../../submit-draw", () => ({ submitDraw: vi.fn() }));
vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    canUseLocalDrawingSession: vi.fn(() => true),
    fetchDrawingSessionAllowance: vi.fn(async () => ({ found: true, remainingYocto: null, permissionSummary: "" })),
    signAndSendStrokeLocally: vi.fn(async () => ({
      status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [], failingChunk: null,
    })),
  };
});
vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, CONTRACT_ID: "board.paint.testnet", PAGE_NETWORK: "testnet" };
});
vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return { ...actual, isContractConfigured: () => true };
});
import { submitDraw } from "../../submit-draw";
import { canUseLocalDrawingSession, signAndSendStrokeLocally } from "../../local-draw";

type DrawResult = Awaited<ReturnType<typeof submitDraw>>;
const confirmed = (x: number, y: number, colorIndex: number): DrawResult => ({
  status: "confirmed",
  title: "Paint confirmed",
  message: "ok",
  transactionId: `tx-${x}-${y}`,
  explorerUrl: null,
  pixel: { x, y, colorIndex, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1" },
  observedBlockHeight: 3,
});

function setup(options: { metaOk?: boolean } = {}) {
  document.body.innerHTML = `
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
  let selected: Cell | null = null;
  let selectedColor: number | null = 2;
  let phase: UiPhase = "disconnected";
  const board = {
    contractMetaOk: () => options.metaOk ?? true,
    contractMetaIssue: () => ({ kind: "read" as const, detail: "offline" }),
    rememberPixel: vi.fn(),
    refreshBoardFromContract: vi.fn(async () => undefined),
  };
  const pricing = {
    paidBoard: vi.fn(() => false),
    priceUnavailable: vi.fn(() => false),
    allowGestureRetry: vi.fn(),
    ensurePaidQuote: vi.fn(async (): Promise<PaidQuote | null> => ({
      maxCredits: null, chunkMaxCredits: null, reservation: null,
    })),
    admitTap: vi.fn((): CreditReservation | null => ({ id: 0 })),
    settle: vi.fn(),
    release: vi.fn(),
    confirmRequote: vi.fn(async (): Promise<number | null> => null),
    refreshCreditsDock: vi.fn(async () => undefined),
    repriceCell: vi.fn(),
  };
  const view = {
    selected: () => selected,
    setSelected: (cell: Cell | null) => { selected = cell; },
    selectedColor: () => selectedColor,
    setFlow: vi.fn((next: UiPhase) => { phase = next; }),
    showSelection: vi.fn(),
  };
  const toggle = el<HTMLInputElement>("toggle");
  const paint = createPaintController({
    scope,
    services,
    sponsorship: { flagEnabled: false, message: "No sponsor." } as never,
    boardViewport: el("viewport"),
    drawState: el("draw-state"),
    flowState: el("flow"),
    drawButton: el<HTMLButtonElement>("draw"),
    result: el("result"),
    directPaintToggle: toggle,
    tapToPaintAffordance: toggle.closest("label")!,
    tapToPaintAnnouncement: el("tap-status"),
    paintUnlock: el("unlock"),
    paintUnlocked: el("unlocked"),
    unlockPaintButton: el<HTMLButtonElement>("unlock-btn"),
    authorizeSessionButton: el<HTMLButtonElement>("auth"),
    forgetSessionButton: el<HTMLButtonElement>("forget"),
    revokeSessionButton: el<HTMLButtonElement>("revoke"),
    drawingSessionStatus: el("session-status"),
    drawingSessionNote: el("session-note"),
    board,
    pricing,
    view,
    render: vi.fn(),
  });
  return {
    paint, scope, services, board, pricing, view, toggle,
    result: el("result"),
    drawButton: el<HTMLButtonElement>("draw"),
    select: (cell: Cell | null) => { selected = cell; },
    setColor: (c: number | null) => { selectedColor = c; },
    phase: () => phase,
    dispose: () => { paint.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

beforeEach(() => {
  vi.mocked(submitDraw).mockReset();
  vi.mocked(signAndSendStrokeLocally).mockClear();
  vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("paint controller", () => {
  it("attemptDraw with nothing selected explains and never submits", async () => {
    const t = setup();
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.result.querySelector("h3")?.textContent).toBeTruthy();
    expect(t.phase()).toBe("editing");
    t.dispose();
  });

  it("attemptDraw refuses while contract metadata is not valid", async () => {
    const t = setup({ metaOk: false });
    t.select({ x: 1, y: 1 });
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.phase()).toBe("failed");
    t.dispose();
  });

  it("a confirmed draw records the op, stamps the pixel, re-reads and re-prices", async () => {
    vi.mocked(submitDraw).mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.select({ x: 4, y: 5 });
    await t.paint.attemptDraw();
    expect(submitDraw).toHaveBeenCalledWith(expect.objectContaining({ x: 4, y: 5, colorIndex: 2, accountId: "alice.testnet" }));
    expect(t.services.operations.list()[0]).toMatchObject({
      kind: "paint", phase: "confirmed", transactionId: "tx-4-5", title: "Paint confirmed",
      meta: { x: 4, y: 5, colorIndex: 2 },
    });
    expect(t.board.rememberPixel).toHaveBeenCalledWith(confirmed(4, 5, 2).pixel, 3);
    expect(t.board.refreshBoardFromContract).toHaveBeenCalledWith({ reason: "after_draw" });
    expect(t.pricing.refreshCreditsDock).toHaveBeenCalled();
    expect(t.pricing.repriceCell).toHaveBeenCalledWith({ x: 4, y: 5 });
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.paint.drawInFlight()).toBe(false);
    t.dispose();
  });

  it("a refused price leaves no pending mark and no wallet prompt", async () => {
    const t = setup();
    t.pricing.ensurePaidQuote.mockResolvedValueOnce(null);
    t.select({ x: 4, y: 5 });
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.services.operations.list()).toHaveLength(0);
    t.dispose();
  });

  it("direct taps queue and drain one at a time", async () => {
    let release!: (r: DrawResult) => void;
    vi.mocked(submitDraw)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.paint.showDrawingSession();
    expect(t.toggle.checked).toBe(true);
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    t.paint.maybeEnqueueDirectPaint({ x: 2, y: 2 });
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(1));
    expect(t.paint.queueLength()).toBe(1);
    expect(t.paint.pendingCount()).toBe(2);
    release(confirmed(1, 1, 2));
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitDraw).mock.calls[1]![0]).toMatchObject({ x: 2, y: 2 });
    t.dispose();
  });

  it("a tap pricing refuses is not queued", () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.pricing.admitTap.mockReturnValueOnce(null);
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    expect(t.paint.queueLength()).toBe(0);
    expect(t.paint.pendingCount()).toBe(0);
    t.dispose();
  });

  it("onWalletChanged drops unsent paints and says so", () => {
    const t = setup();
    t.paint.enqueueUnsent(createDrawRequest({ x: 1, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.enqueueUnsent(createDrawRequest({ x: 2, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.onWalletChanged();
    expect(t.paint.queueLength()).toBe(0);
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.result.querySelector("h3")?.textContent).toBe("Queued paints cancelled");
    t.dispose();
  });

  it("an armed drag becomes one stroke; a blocked one names the reason", async () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    expect(t.paint.strokes.active()).toBe(true);
    t.paint.strokes.extend({ x: 2, y: 1 });
    expect(t.paint.overlayPixels()).toHaveLength(2);
    t.paint.strokes.finish({ x: 3, y: 1 }, "drag", vi.fn());
    expect(t.paint.strokes.active()).toBe(false);
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({
      cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }], color: 2,
    });
    await vi.waitFor(() => expect(t.result.querySelector("h3")?.textContent).toBe("Stroke confirmed"));

    t.setColor(null);
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    expect(t.paint.strokes.active()).toBe(false);
    expect(document.getElementById("draw-state")!.textContent).not.toBe("");
    t.dispose();
  });

  it("a one-cell tap stroke selects instead of committing", () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    const selectHere = vi.fn();
    t.paint.strokes.finish(null, "tap", selectHere);
    expect(selectHere).toHaveBeenCalled();
    expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    t.dispose();
  });

  it("Place paint is disabled by a latched price failure on a paid board", () => {
    const t = setup();
    t.select({ x: 1, y: 1 });
    t.pricing.paidBoard.mockReturnValue(true);
    t.pricing.priceUnavailable.mockReturnValue(true);
    t.paint.syncSubmitEnabled();
    expect(t.drawButton.disabled).toBe(true);
    t.pricing.priceUnavailable.mockReturnValue(false);
    t.paint.syncSubmitEnabled();
    expect(t.drawButton.disabled).toBe(false);
    t.dispose();
  });

  it("Direct paint follows the session and an explicit opt-out sticks", () => {
    const t = setup();
    t.paint.showDrawingSession();
    expect(t.toggle.checked).toBe(true);
    expect(t.drawButton.hidden).toBe(true);
    t.toggle.checked = false;
    t.toggle.dispatchEvent(new Event("change"));
    t.paint.updateDirectPaintAvailability();
    expect(t.toggle.checked).toBe(false);
    expect(t.drawButton.hidden).toBe(false);
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
    t.paint.updateDirectPaintAvailability();
    expect(document.getElementById("unlock")!.hidden).toBe(false);
    t.dispose();
  });

  it("dispose drops unsent paints quietly", () => {
    const t = setup();
    t.paint.enqueueUnsent(createDrawRequest({ x: 1, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.dispose();
    expect(t.paint.queueLength()).toBe(0);
    expect(t.result.textContent).toBe("");
  });
});
