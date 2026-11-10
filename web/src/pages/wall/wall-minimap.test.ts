/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import { fitCamera, paintZoomCamera, type Camera } from "../../viewport";
import { createWallMinimap, showsWholeWall, visibleCells } from "./wall-minimap";
import { createWallScope } from "./wall-scope";

const viewport = { width: 800, height: 600 };

describe("visibleCells", () => {
  it("is the whole board when fitted", () => {
    const view = visibleCells(fitCamera(viewport), viewport);
    expect(view.x).toBe(0);
    expect(view.y).toBe(0);
    expect(view.width).toBeCloseTo(BOARD_WIDTH);
    expect(view.height).toBeCloseTo(BOARD_HEIGHT);
    expect(showsWholeWall(fitCamera(viewport), viewport)).toBe(true);
  });

  it("is the window's share of the board when zoomed in", () => {
    const camera = paintZoomCamera(viewport, { x: 64, y: 64 }, 20);
    const view = visibleCells(camera, viewport);
    expect(view.width).toBeCloseTo(40);
    expect(view.height).toBeCloseTo(30);
    expect(view.x + view.width / 2).toBeCloseTo(64.5);
    expect(showsWholeWall(camera, viewport)).toBe(false);
  });
});

describe("createWallMinimap", () => {
  function setup(camera: Camera) {
    document.body.innerHTML = `<div id="host"></div>`;
    const centred: Array<{ x: number; y: number }> = [];
    const minimap = createWallMinimap({
      scope: createWallScope(),
      host: document.querySelector<HTMLElement>("#host")!,
      source: document.createElement("canvas"),
      camera: () => camera,
      viewport: () => viewport,
      centerOn: (cell) => centred.push(cell),
      visible: () => true,
    });
    const canvas = minimap.element.querySelector("canvas")!;
    canvas.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 128, height: 128, right: 138, bottom: 148, x: 10, y: 20 }) as DOMRect;
    return { minimap, centred };
  }

  it("hides itself when the whole wall is on screen", () => {
    const { minimap } = setup(fitCamera(viewport));
    expect(minimap.element.dataset.wholeWall).toBe("true");
  });

  it("frames the part on screen when zoomed in", () => {
    const { minimap } = setup(paintZoomCamera(viewport, { x: 64, y: 64 }, 20));
    expect(minimap.element.dataset.wholeWall).toBe("false");
    const frame = minimap.element.querySelector<HTMLElement>(".wall-minimap-frame")!;
    expect(parseFloat(frame.style.width)).toBeCloseTo((40 / BOARD_WIDTH) * 100);
  });

  it("a tap moves the wall to that cell and never reaches the board", () => {
    const { minimap, centred } = setup(paintZoomCamera(viewport, { x: 64, y: 64 }, 20));
    let reachedBoard = false;
    document.body.addEventListener("pointerdown", () => (reachedBoard = true));
    minimap.element.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 10 + 32, clientY: 20 + 100, bubbles: true, pointerId: 1 }),
    );
    expect(centred).toEqual([
      { x: Math.floor((32 / 128) * BOARD_WIDTH), y: Math.floor((100 / 128) * BOARD_HEIGHT) },
    ]);
    expect(reachedBoard).toBe(false);
  });
});
