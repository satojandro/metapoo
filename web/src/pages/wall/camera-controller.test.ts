/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cell } from "../../selection";
import { createCameraController, type CameraStrokeHooks } from "./camera-controller";
import { createWallScope } from "./wall-scope";

vi.mock("../../render-board", () => ({ renderBoard: vi.fn() }));
import { renderBoard } from "../../render-board";

function setup(size = { width: 512, height: 512 }) {
  document.body.innerHTML = `
    <div id="toolbar"></div>
    <div id="focus" tabindex="0"><div id="viewport"><div id="stage"><canvas id="board"></canvas><div id="ring"></div></div></div></div>
    <p id="hover"></p>
    <button id="zoom-paint"></button>
  `;
  const viewport = document.querySelector<HTMLElement>("#viewport")!;
  Object.assign(viewport, { setPointerCapture: vi.fn() });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height,
    width: size.width, height: size.height, toJSON: () => ({}),
  } as DOMRect);
  const scope = createWallScope();
  let selected: Cell | null = null;
  let active = false;
  const strokes: CameraStrokeHooks = {
    active: () => active,
    begin: vi.fn((cell: Cell | null, wantsPan: boolean) => {
      if (cell && !wantsPan && armed) active = true;
    }),
    extend: vi.fn(),
    finish: vi.fn(() => {
      active = false;
    }),
    cancel: vi.fn(() => {
      active = false;
    }),
  };
  let armed = false;
  const deps = {
    scope,
    canvas: document.querySelector<HTMLCanvasElement>("#board")!,
    boardViewport: viewport,
    boardStage: document.querySelector<HTMLElement>("#stage")!,
    boardToolbar: document.querySelector<HTMLElement>("#toolbar")!,
    boardFocus: document.querySelector<HTMLElement>("#focus")!,
    selectionRing: document.querySelector<HTMLElement>("#ring")!,
    hoverSummary: document.querySelector<HTMLElement>("#hover")!,
    zoomPaintButton: document.querySelector<HTMLButtonElement>("#zoom-paint")!,
    paintedPixels: () => [],
    overlayPixels: () => [],
    selection: {
      selected: () => selected,
      selectedColor: () => null,
      select: vi.fn((cell: Cell | null) => {
        selected = cell;
      }),
      showSelection: vi.fn(),
      refreshSelectedPixel: vi.fn(),
    },
    strokes,
    updateCompactStatus: vi.fn(),
    attemptDraw: vi.fn(),
    tapSelected: vi.fn(),
    hoverCell: vi.fn(),
  };
  const camera = createCameraController(deps);
  camera.fitWallToView();
  const pointer = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, clientX: x, clientY: y, ...extra });
    viewport.dispatchEvent(event);
  };
  return {
    camera, deps, scope, viewport, strokes, pointer,
    arm: () => { armed = true; },
    dispose: () => { camera.dispose(); scope.runCleanups(); },
  };
}

beforeEach(() => {
  vi.mocked(renderBoard).mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("camera controller", () => {
  it("fits the wall, zooms from the centre and reports zoom state", () => {
    const { camera, dispose } = setup();
    expect(camera.camera()).toEqual({ cellSize: 3.875, panX: 8, panY: 8 });
    expect(camera.readZoomState()).toMatchObject({ current: 3.875, minimum: 3.875, fitted: true });
    camera.zoomFromCenter(2);
    expect(camera.camera().cellSize).toBe(7.75);
    expect(camera.readZoomState().fitted).toBe(false);
    expect(document.querySelector(".position-readout")?.textContent).toBe(
      "Zoom 200% · Cell: none selected",
    );
    camera.fitWallToView();
    expect(camera.readZoomState().fitted).toBe(true);
    dispose();
  });

  it("maps client points to cells through the current transform", () => {
    const { camera, dispose } = setup();
    expect(camera.cellAtClientPoint(8, 8)).toEqual({ x: 0, y: 0 });
    expect(camera.cellAtClientPoint(4, 4)).toBeNull();
    expect(camera.cellAtClientPoint(48, 87)).toEqual({ x: 10, y: 20 });
    dispose();
  });

  it("a stationary tap selects the cell and offers it for direct paint", () => {
    const { deps, pointer, dispose } = setup();
    pointer("pointerdown", 48, 87);
    pointer("pointerup", 48, 87);
    expect(deps.selection.select).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(deps.selection.showSelection).toHaveBeenCalled();
    expect(deps.selection.refreshSelectedPixel).toHaveBeenCalled();
    expect(deps.tapSelected).toHaveBeenCalledWith({ x: 10, y: 20 }, { paintZoom: false });
    expect(document.querySelector<HTMLElement>("#ring")!.style.left).toBe("46.75px");
    dispose();
  });

  it("a drag pans and never selects", () => {
    const { camera, deps, pointer, dispose } = setup();
    camera.zoomFromCenter(4);
    const before = camera.camera();
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 160, 100);
    pointer("pointerup", 160, 100);
    expect(camera.camera().panX).toBe(before.panX + 60);
    expect(deps.selection.select).not.toHaveBeenCalled();
    expect(deps.tapSelected).not.toHaveBeenCalled();
    dispose();
  });

  it("hands an armed drag to the stroke hooks instead of panning", () => {
    const { camera, strokes, pointer, arm, dispose } = setup();
    arm();
    const before = camera.camera();
    pointer("pointerdown", 48, 87);
    expect(strokes.begin).toHaveBeenCalledWith({ x: 10, y: 20 }, false);
    pointer("pointermove", 60, 87);
    expect(strokes.extend).toHaveBeenCalledWith({ x: 13, y: 20 });
    pointer("pointerup", 60, 87);
    expect(strokes.finish).toHaveBeenCalledWith({ x: 13, y: 20 }, "drag", expect.any(Function));
    expect(camera.camera()).toEqual(before);
    dispose();
  });

  it("right button, held space or the margin ask begin() for a pan", () => {
    const { strokes, pointer, dispose } = setup();
    pointer("pointerdown", 48, 87, { button: 2 });
    expect(strokes.begin).toHaveBeenLastCalledWith({ x: 10, y: 20 }, true);
    pointer("pointerup", 48, 87);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    pointer("pointerdown", 48, 87);
    expect(strokes.begin).toHaveBeenLastCalledWith({ x: 10, y: 20 }, true);
    pointer("pointerup", 48, 87);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    pointer("pointerdown", 2, 2);
    expect(strokes.begin).toHaveBeenLastCalledWith(null, true);
    dispose();
  });

  it("a second finger cancels the stroke and pinches the camera", () => {
    const { camera, strokes, pointer, arm, dispose } = setup();
    arm();
    pointer("pointerdown", 200, 200);
    pointer("pointerdown", 300, 300, { pointerId: 2 });
    expect(strokes.cancel).toHaveBeenCalled();
    pointer("pointermove", 400, 400, { pointerId: 2 });
    expect(camera.camera().cellSize).toBeGreaterThan(3.875);
    dispose();
  });

  it("keyboard: Enter draws, +/-/0 zoom, arrows select and zoom to the cell", () => {
    const { camera, deps, dispose } = setup();
    const key = (k: string) =>
      deps.boardFocus.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("Enter");
    expect(deps.attemptDraw).toHaveBeenCalledTimes(1);
    key("+");
    expect(camera.camera().cellSize).toBeCloseTo(3.875 * 1.25);
    key("0");
    expect(camera.readZoomState().fitted).toBe(true);
    key("ArrowRight");
    expect(deps.selection.select).toHaveBeenCalledWith({ x: 0, y: 0 });
    expect(deps.selection.refreshSelectedPixel).toHaveBeenCalled();
    dispose();
  });

  it("zoom-to-paint centres the selection or the middle of the board", () => {
    const { camera, deps, dispose } = setup();
    deps.zoomPaintButton.click();
    expect(camera.camera()).toEqual({ cellSize: 20, panX: -1034, panY: -1034 });
    expect(deps.updateCompactStatus).toHaveBeenCalled();
    dispose();
  });

  it("render draws the pixels and overlay, then refreshes the status", () => {
    const { camera, deps, dispose } = setup();
    camera.render();
    expect(renderBoard).toHaveBeenCalledWith(deps.canvas, [], [], undefined, null);
    expect(deps.updateCompactStatus).toHaveBeenCalled();
    dispose();
  });

  it("hover shows the preview and asks for the cell price; touch never does", () => {
    const { deps, pointer, dispose } = setup();
    pointer("pointermove", 48, 87, { pointerType: "mouse" });
    expect(deps.hoverCell).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(document.querySelector<HTMLElement>(".pointer-preview")!.hidden).toBe(false);
    expect(deps.hoverSummary.textContent).toBe("x 10 · y 20");
    pointer("pointermove", 48, 87, { pointerType: "touch" });
    expect(document.querySelector<HTMLElement>(".pointer-preview")!.hidden).toBe(true);
    expect(deps.hoverCell).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("dispose disconnects the resize observer and listeners stop responding", () => {
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    });
    const { deps, pointer, dispose } = setup();
    dispose();
    expect(disconnect).toHaveBeenCalled();
    pointer("pointerdown", 48, 87);
    pointer("pointerup", 48, 87);
    expect(deps.selection.select).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
