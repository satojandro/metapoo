/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardController } from "./board-controller";
import { createWallScope } from "./wall-scope";

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, CONTRACT_ID: "board.unit.testnet", PAGE_NETWORK: "testnet" };
});

const board = (schema: number) => ({
  schema_version: schema,
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
});

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    getBoard: vi.fn(),
    fetchAllPaintedPixels: vi.fn(),
    getPixelWithBlock: vi.fn(),
  };
});
import { fetchAllPaintedPixels, getBoard, getPixelWithBlock } from "../../contract";

const pixel = (x: number, y: number, colorIndex: number) => ({
  x, y, colorIndex, artistAccountId: "a.testnet", lastWriteTimestampNs: "1",
});

function setup() {
  document.body.innerHTML = `
    <p id="evidence"></p><p id="line"></p><p id="status"></p><p id="fresh"></p>
    <button id="refresh"></button><p id="sponsor"></p>
  `;
  const el = (id: string) => document.getElementById(id)!;
  const scope = createWallScope();
  const deps = {
    scope,
    evidence: el("evidence"),
    contractLine: el("line"),
    boardLoadStatus: el("status"),
    boardFreshness: el("fresh"),
    refreshButton: el("refresh") as HTMLButtonElement,
    sponsorNote: el("sponsor"),
    sponsorship: { flagEnabled: false, message: "No sponsor." } as never,
    routeFocusesCell: false,
    selected: vi.fn(() => null as { x: number; y: number } | null),
    fillResult: vi.fn(),
    render: vi.fn(),
    showSelection: vi.fn(),
    updateCompactStatus: vi.fn(),
    updateDirectPaintAvailability: vi.fn(),
    applyRoutePaintingContext: vi.fn(),
    reconcilePending: vi.fn(),
    onBoardUpdated: vi.fn(),
    onSchemaChanged: vi.fn(),
    onManualRefresh: vi.fn(),
    onPaletteChanged: vi.fn(),
  };
  const controller = createBoardController(deps);
  return {
    controller, deps,
    dispose: () => { controller.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.mocked(getBoard).mockReset().mockResolvedValue(board(4) as never);
  vi.mocked(fetchAllPaintedPixels).mockReset().mockResolvedValue({ pixels: [pixel(1, 2, 3)], blockHeight: 7 });
  vi.mocked(getPixelWithBlock).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("board controller", () => {
  it("bootstraps: validates metadata, remembers the schema, loads every painted cell", async () => {
    const { controller, deps, dispose } = setup();
    await controller.bootstrap();
    expect(controller.contractMetaOk()).toBe(true);
    expect(controller.boardSchema()).toBe(4);
    expect(deps.onSchemaChanged).toHaveBeenCalledTimes(1);
    expect(controller.cachedPixel({ x: 1, y: 2 })?.colorIndex).toBe(3);
    expect(controller.paintedPixels()).toHaveLength(1);
    expect(deps.reconcilePending).toHaveBeenCalledWith([pixel(1, 2, 3)]);
    expect(deps.onBoardUpdated).toHaveBeenCalled();
    expect(deps.applyRoutePaintingContext).toHaveBeenCalled();
    expect(deps.boardLoadStatus.textContent).toMatch(/^Board load: 1 painted cell at block 7\./);
    expect(deps.contractLine.textContent).toContain("board.unit.testnet");
    // board3 reports 8 colours; the dock must not offer 8–15.
    expect(deps.onPaletteChanged).toHaveBeenCalledWith(8);
    dispose();
  });

  it("passes a 16-colour board's palette length on, and none when metadata fails", async () => {
    const sixteen = board(4);
    sixteen.palette.push(
      { index: 8, name: "Grout", hex: "#8a857c" },
      { index: 9, name: "Rust", hex: "#7a4528" },
      { index: 10, name: "Nicotine", hex: "#ecd9a0" },
      { index: 11, name: "Bubblegum", hex: "#ec8fb0" },
      { index: 12, name: "Bleach", hex: "#9ccbdc" },
      { index: 13, name: "Bruise", hex: "#263552" },
      { index: 14, name: "Bile", hex: "#9fb53a" },
      { index: 15, name: "Cone", hex: "#ef7a2c" },
    );
    vi.mocked(getBoard).mockResolvedValueOnce(sixteen as never);
    const first = setup();
    await first.controller.bootstrap();
    expect(first.deps.onPaletteChanged).toHaveBeenCalledWith(16);
    first.dispose();

    vi.mocked(getBoard).mockResolvedValueOnce({ ...board(4), palette: [] } as never);
    const rejected = setup();
    await rejected.controller.bootstrap();
    expect(rejected.controller.contractMetaOk()).toBe(false);
    expect(rejected.deps.onPaletteChanged).not.toHaveBeenCalled();
    rejected.dispose();
  });

  it("a failed metadata read blocks drawing with a read issue, and Refresh revalidates", async () => {
    vi.mocked(getBoard).mockRejectedValueOnce(new Error("offline"));
    const { controller, deps, dispose } = setup();
    await controller.bootstrap();
    expect(controller.contractMetaOk()).toBe(false);
    expect(controller.contractMetaIssue()).toEqual({ kind: "read", detail: "offline" });
    expect(controller.boardSchema()).toBeNull();
    expect(deps.boardLoadStatus.textContent).toBe("Board load failed: offline");

    deps.refreshButton.disabled = false;
    deps.refreshButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.contractMetaOk()).toBe(true);
    expect(controller.contractMetaIssue()).toBeNull();
    expect(deps.onManualRefresh).not.toHaveBeenCalled();
    dispose();
  });

  it("a metadata mismatch reports the contract's problem in the result block", async () => {
    vi.mocked(getBoard).mockResolvedValueOnce({ ...board(2), width: 64 } as never);
    const { controller, deps, dispose } = setup();
    await controller.bootstrap();
    expect(controller.contractMetaOk()).toBe(false);
    expect(controller.contractMetaIssue()?.kind).toBe("mismatch");
    expect(deps.fillResult).toHaveBeenCalled();
    expect(deps.boardLoadStatus.textContent).toMatch(/^Board metadata rejected: /);
    dispose();
  });

  it("Refresh with valid metadata asks pricing to re-read, then reloads", async () => {
    const { controller, deps, dispose } = setup();
    await controller.bootstrap();
    vi.mocked(fetchAllPaintedPixels).mockClear();
    deps.refreshButton.click();
    expect(deps.onManualRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAllPaintedPixels).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("polls every 4s and backs off after failures", async () => {
    const { controller, dispose } = setup();
    await controller.bootstrap();
    vi.mocked(fetchAllPaintedPixels).mockClear();
    vi.mocked(fetchAllPaintedPixels).mockRejectedValueOnce(new Error("x"));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchAllPaintedPixels).toHaveBeenCalledTimes(1);
    expect(controller.syncState().consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(fetchAllPaintedPixels).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchAllPaintedPixels).toHaveBeenCalledTimes(2);
    expect(controller.syncState().consecutiveFailures).toBe(0);
    dispose();
  });

  it("a cell read older than the applied snapshot is ignored", async () => {
    const { controller, dispose } = setup();
    await controller.bootstrap();
    vi.mocked(getPixelWithBlock).mockResolvedValueOnce({ pixel: pixel(1, 2, 6), blockHeight: 3 });
    await controller.refreshSelectedPixel({ x: 1, y: 2 });
    expect(controller.cachedPixel({ x: 1, y: 2 })?.colorIndex).toBe(3);
    vi.mocked(getPixelWithBlock).mockResolvedValueOnce({ pixel: pixel(1, 2, 6), blockHeight: 9 });
    await controller.refreshSelectedPixel({ x: 1, y: 2 });
    expect(controller.cachedPixel({ x: 1, y: 2 })?.colorIndex).toBe(6);
    dispose();
  });

  it("refreshSelectedPixel defaults to the current selection", async () => {
    const { controller, deps, dispose } = setup();
    deps.selected.mockReturnValue({ x: 4, y: 5 });
    vi.mocked(getPixelWithBlock).mockResolvedValueOnce({ pixel: pixel(4, 5, 1), blockHeight: 2 });
    await controller.refreshSelectedPixel();
    expect(getPixelWithBlock).toHaveBeenCalledWith(4, 5);
    expect(controller.cachedPixel({ x: 4, y: 5 })?.colorIndex).toBe(1);
    dispose();
  });

  it("rememberPixel keeps the newer block's evidence", () => {
    const { controller, dispose } = setup();
    controller.rememberPixel(pixel(0, 0, 2), 10);
    controller.rememberPixel(pixel(0, 0, 5), 4);
    expect(controller.cachedPixel({ x: 0, y: 0 })?.colorIndex).toBe(2);
    dispose();
  });

  it("dispose stops the poll and the visibility/online listeners", async () => {
    const { controller, dispose } = setup();
    await controller.bootstrap();
    vi.mocked(fetchAllPaintedPixels).mockClear();
    dispose();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchAllPaintedPixels).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
