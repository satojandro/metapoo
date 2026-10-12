import { describe, expect, it } from "vitest";
import {
  cellFromViewportPoint,
  clampPan,
  fitCamera,
  isPanGesture,
  paintZoomCamera,
  panBy,
  PAINT_CELL_PX,
  selectionRingStyle,
  zoomAt,
} from "./viewport";

describe("viewport camera", () => {
  it("fits the full board inside a square viewport", () => {
    const camera = fitCamera({ width: 400, height: 400 }, 0);
    expect(camera.cellSize).toBeCloseTo(400 / 128, 5);
    expect(camera.panX).toBeCloseTo(0, 5);
    expect(camera.panY).toBeCloseTo(0, 5);
  });

  it("maps viewport corners and center after fit", () => {
    const camera = fitCamera({ width: 256, height: 256 }, 0);
    expect(cellFromViewportPoint(0, 0, camera)).toEqual({ x: 0, y: 0 });
    expect(cellFromViewportPoint(255.9, 255.9, camera)).toEqual({
      x: 127,
      y: 127,
    });
    expect(cellFromViewportPoint(128, 128, camera)).toEqual({ x: 64, y: 64 });
  });

  it("keeps the focus cell under the viewport center after paint zoom", () => {
    const focus = { x: 10, y: 20 };
    const viewport = { width: 390, height: 480 };
    const camera = paintZoomCamera(viewport, focus);
    expect(camera.cellSize).toBe(PAINT_CELL_PX);
    const underCenter = cellFromViewportPoint(
      viewport.width / 2,
      viewport.height / 2,
      camera,
    );
    expect(underCenter).toEqual(focus);
  });

  it("zooms toward a pivot without jumping the cell under the pointer", () => {
    const viewport = { width: 300, height: 300 };
    const start = fitCamera(viewport, 0);
    const pivotX = 150;
    const pivotY = 150;
    const before = cellFromViewportPoint(pivotX, pivotY, start);
    const zoomed = zoomAt(start, viewport, 2, pivotX, pivotY);
    const after = cellFromViewportPoint(pivotX, pivotY, zoomed);
    expect(before).not.toBeNull();
    expect(after).toEqual(before);
    expect(zoomed.cellSize).toBeGreaterThan(start.cellSize);
  });

  it("distinguishes taps from pans", () => {
    expect(isPanGesture(2, 2)).toBe(false);
    expect(isPanGesture(10, 0)).toBe(true);
  });

  it("clamps pan so a zoomed board cannot fully leave the viewport", () => {
    const viewport = { width: 200, height: 200 };
    const camera = { cellSize: 20, panX: 500, panY: -5000 };
    const clamped = clampPan(camera, viewport);
    expect(clamped.panX).toBeLessThanOrEqual(0);
    expect(clamped.panY).toBeGreaterThanOrEqual(200 - 128 * 20);
  });

  it("pans by delta then reclamps", () => {
    const viewport = { width: 200, height: 200 };
    const start = paintZoomCamera(viewport, { x: 64, y: 64 });
    const moved = panBy(start, viewport, -40, 15);
    expect(moved.panX).toBeLessThan(start.panX);
    expect(moved.panY).toBeGreaterThan(start.panY);
  });

  it("draws the selection ring slightly outside the cell", () => {
    const style = selectionRingStyle({ x: 0, y: 0 });
    expect(parseFloat(style.left)).toBeLessThan(0);
    expect(parseFloat(style.top)).toBeLessThan(0);
    expect(parseFloat(style.width)).toBeGreaterThan(100 / 128);
  });
});
