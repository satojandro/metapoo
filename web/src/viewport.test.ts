import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
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

const BOARD_LANDMARKS = [
  { point: { x: 0.5, y: 0.5 }, cell: { x: 0, y: 0 } },
  { point: { x: BOARD_WIDTH - 0.5, y: 0.5 }, cell: { x: 127, y: 0 } },
  { point: { x: 0.5, y: BOARD_HEIGHT - 0.5 }, cell: { x: 0, y: 127 } },
  {
    point: { x: BOARD_WIDTH - 0.5, y: BOARD_HEIGHT - 0.5 },
    cell: { x: 127, y: 127 },
  },
  {
    point: { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 },
    cell: { x: 64, y: 64 },
  },
] as const;

function expectBoardLandmarksToMap(camera: {
  cellSize: number;
  panX: number;
  panY: number;
}): void {
  const transform = createCameraTransform(camera);
  for (const { point, cell } of BOARD_LANDMARKS) {
    expect(
      transform.cellAt(
        transform.stage.left + point.x * camera.cellSize,
        transform.stage.top + point.y * camera.cellSize,
      ),
    ).toEqual(cell);
  }
}

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

  it.each([0.25, 0.7, 1.25, Math.PI, 16, 47.875])(
    "maps all four board corners and its centre at an arbitrary %spx zoom",
    (cellSize) => {
      expectBoardLandmarksToMap({ cellSize, panX: -37.125, panY: 23.625 });
    },
  );

  it("keeps landmarks mapped after resize changes the fit scale", () => {
    const portraitFit = fitCamera({ width: 640, height: 900 });
    const landscapeFit = fitCamera({ width: 1000, height: 430 });

    expect(portraitFit.cellSize).not.toBe(landscapeFit.cellSize);
    expectBoardLandmarksToMap(portraitFit);
    expectBoardLandmarksToMap(landscapeFit);
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

  it("uses the exact inverse of rendered stage placement for paint hit testing", () => {
    const transform = createCameraTransform({
      cellSize: 3.141592653589793,
      panX: -211.375,
      panY: 97.625,
    });
    const cells = [
      { x: 0, y: 0 },
      { x: 1, y: 126 },
      { x: 63, y: 64 },
      { x: 127, y: 127 },
    ];
    const inCellOffsets = [0, 0.125, 0.5, 0.999999];

    for (const cell of cells) {
      const renderedRect = transform.cellRect(cell);
      for (const offset of inCellOffsets) {
        const pointerX =
          transform.stage.left + (cell.x + offset) * transform.camera.cellSize;
        const pointerY =
          transform.stage.top + (cell.y + offset) * transform.camera.cellSize;

        expect(pointerX).toBeCloseTo(
          renderedRect.left + offset * renderedRect.width,
          12,
        );
        expect(pointerY).toBeCloseTo(
          renderedRect.top + offset * renderedRect.height,
          12,
        );
        expect(transform.cellAt(pointerX, pointerY)).toEqual(cell);
        expect(
          cellFromViewportPoint(pointerX, pointerY, transform.camera),
        ).toEqual(cell);
      }
    }
  });

  it("returns no cell outside any rendered board edge", () => {
    // This fractional transform makes the old divide-then-floor calculation
    // produce 127.999... at the exact right/bottom edge.
    const transform = createCameraTransform({
      cellSize: 1.25,
      panX: 96.4,
      panY: -73.6,
    });
    const { left, top, width, height } = transform.stage;
    const middleX = left + width / 2;
    const middleY = top + height / 2;

    expect(transform.cellAt(left - 0.001, middleY)).toBeNull();
    expect(transform.cellAt(left + width, middleY)).toBeNull();
    expect(transform.cellAt(middleX, top - 0.001)).toBeNull();
    expect(transform.cellAt(middleX, top + height)).toBeNull();
    expect(transform.cellAt(left - 100, top - 100)).toBeNull();
    expect(transform.cellAt(left + width + 100, top + height + 100)).toBeNull();

    expect(transform.cellAt(left, top)).toEqual({ x: 0, y: 0 });
    expect(transform.cellAt(left + width - 0.001, top + height - 0.001)).toEqual({
      x: 127,
      y: 127,
    });
  });

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
