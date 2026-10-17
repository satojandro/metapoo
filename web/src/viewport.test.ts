import { describe, expect, it } from "vitest";
import {
  cellFromViewportPoint,
  clampPan,
  createCameraTransform,
  fitCamera,
  isPanGesture,
  paintZoomCamera,
  panBy,
  PAINT_CELL_PX,
  PAINT_MIN_CELL_PX,
  isPaintZoom,
  zoomAt,
} from "./viewport";

describe("viewport camera", () => {
  it("fits the full board inside a square viewport", () => {
    const camera = fitCamera({ width: 400, height: 400 }, 0);
    expect(camera.cellSize).toBeCloseTo(400 / 128, 5);
    expect(camera.panX).toBeCloseTo(0, 5);
    expect(camera.panY).toBeCloseTo(0, 5);
  });

  it("fits small viewports below the painting cell-size floor", () => {
    const camera = fitCamera({ width: 230, height: 190 }, 0);
    expect(camera.cellSize).toBeLessThan(2);
    expect(camera.cellSize * 128).toBeLessThanOrEqual(230 + 0.001);
    expect(camera.cellSize * 128).toBeLessThanOrEqual(190 + 0.001);
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

  it("hit-tests cells through the same zoom and pan transform used for rendering", () => {
    const camera = { cellSize: 20, panX: -190, panY: -390 };
    // Cell (10, 20) starts at viewport position (10, 10).
    expect(cellFromViewportPoint(19.9, 29.9, camera)).toEqual({ x: 10, y: 20 });
    expect(cellFromViewportPoint(30, 30, camera)).toEqual({ x: 11, y: 21 });
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

  it("only enables paint zoom at the 16px target threshold", () => {
    expect(
      isPaintZoom({ cellSize: PAINT_MIN_CELL_PX - 0.01, panX: 0, panY: 0 }),
    ).toBe(false);
    expect(
      isPaintZoom({ cellSize: PAINT_MIN_CELL_PX, panX: 0, panY: 0 }),
    ).toBe(true);
    expect(
      isPaintZoom(
        paintZoomCamera({ width: 390, height: 480 }, { x: 10, y: 20 }),
      ),
    ).toBe(true);
  });

  it("keeps overview zoom below the paint threshold when zooming out", () => {
    const viewport = { width: 230, height: 190 };
    const overview = fitCamera(viewport, 0);
    const zoomedOut = zoomAt(overview, viewport, 0.5, 115, 95);

    expect(zoomedOut.cellSize).toBeLessThan(overview.cellSize);
    expect(isPaintZoom(zoomedOut)).toBe(false);
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

  it.each([1.5, 16, 20, 24, 48])(
    "keeps rendering, selection, and corner hit-testing aligned at %spx per cell",
    (cellSize) => {
      const transform = createCameraTransform({
        cellSize,
        panX: -7.25,
        panY: 13.5,
      });
      const cell = { x: 37, y: 62 };
      const rect = transform.cellRect(cell);

      expect(rect).toEqual({
        left: -7.25 + 37 * cellSize,
        top: 13.5 + 62 * cellSize,
        width: cellSize,
        height: cellSize,
      });
      expect(transform.cellAt(rect.left + cellSize / 2, rect.top + cellSize / 2)).toEqual(
        cell,
      );
      expect(transform.cellAt(rect.left + 0.001, rect.top + 0.001)).toEqual(cell);
      expect(
        transform.cellAt(rect.left + cellSize - 0.001, rect.top + cellSize - 0.001),
      ).toEqual(cell);
    },
  );

  it("snapshots camera values so a transform cannot desync mid-frame", () => {
    const camera = { cellSize: 20, panX: -100, panY: -200 };
    const transform = createCameraTransform(camera);
    camera.cellSize = 48;
    camera.panX = 0;

    expect(transform.stage.width).toBe(128 * 20);
    expect(transform.cellRect({ x: 5, y: 10 })).toEqual({
      left: 0,
      top: 0,
      width: 20,
      height: 20,
    });
    expect(transform.cellAt(10, 10)).toEqual({ x: 5, y: 10 });
  });
});
