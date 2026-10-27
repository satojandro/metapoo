import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import { clampCell, type Cell } from "./selection";

/**
 * Camera for the board viewport.
 *
 * `cellSize` is how many screen pixels one logical board square occupies.
 * Overview (fit) uses a small cellSize; painting zoom aims for ~16–24.
 * `panX` / `panY` are the screen position of board cell (0,0)'s top-left
 * inside the viewport (can be negative when zoomed in).
 */
export interface Camera {
  cellSize: number;
  panX: number;
  panY: number;
}

/** Comfortable paint target from the board-review brief. */
export const PAINT_CELL_PX = 20;
/** A cell must be at least this large before tap-to-paint is enabled. */
export const PAINT_MIN_CELL_PX = 16;
/** Floor for interactive zoom (not for fit-to-wall overview). */
export const MIN_CELL_PX = 2;
/** Absolute floor so fit can shrink below painting minimum on tiny viewports. */
export const FIT_MIN_CELL_PX = 0.25;
export const MAX_CELL_PX = 48;

/** Movement past this many screen pixels counts as a pan, not a tap. */
export const PAN_THRESHOLD_PX = 8;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One immutable projection of board coordinates into viewport coordinates.
 * The wall mount keeps a single instance for DOM placement, hit-testing, and
 * selection geometry, replacing it whenever the camera changes.
 */
export interface CameraTransform {
  readonly camera: Camera;
  readonly stage: ViewportRect & { transform: string };
  cellAt(viewportX: number, viewportY: number): Cell | null;
  cellRect(cell: Cell): ViewportRect;
}

/** Board size in screen pixels for the current camera. */
export function boardScreenSize(camera: Camera): { width: number; height: number } {
  return {
    width: BOARD_WIDTH * camera.cellSize,
    height: BOARD_HEIGHT * camera.cellSize,
  };
}

export function createCameraTransform(camera: Camera): CameraTransform {
  const snapshot = { ...camera };
  const board = boardScreenSize(snapshot);
  const stage = {
    left: snapshot.panX,
    top: snapshot.panY,
    width: board.width,
    height: board.height,
    transform: `translate(${snapshot.panX}px, ${snapshot.panY}px)`,
  };
  return {
    camera: snapshot,
    stage,
    cellAt(viewportX, viewportY) {
      // Reject against the same half-open rectangle used to render the stage
      // before dividing. At fractional scales, calculating the right/bottom
      // edge back into board coordinates can produce 127.999... and otherwise
      // misclassify an out-of-board pointer as the final cell.
      if (
        viewportX < stage.left ||
        viewportY < stage.top ||
        viewportX >= stage.left + stage.width ||
        viewportY >= stage.top + stage.height
      ) {
        return null;
      }
      const x = cellIndexAt(viewportX, stage.left, snapshot.cellSize);
      const y = cellIndexAt(viewportY, stage.top, snapshot.cellSize);
      return clampCell(x, y);
    },
    cellRect(cell) {
      return {
        left: snapshot.panX + cell.x * snapshot.cellSize,
        top: snapshot.panY + cell.y * snapshot.cellSize,
        width: snapshot.cellSize,
        height: snapshot.cellSize,
      };
    },
  };
}

/** Resolve rounding at rendered cell boundaries using the forward transform. */
function cellIndexAt(point: number, stageStart: number, cellSize: number): number {
  const approximate = Math.floor((point - stageStart) / cellSize);
  if (point < stageStart + approximate * cellSize) {
    return approximate - 1;
  }
  if (point >= stageStart + (approximate + 1) * cellSize) {
    return approximate + 1;
  }
  return approximate;
}

/**
 * Largest cell size that still shows the whole board inside the viewport.
 *
 * This is also the zoom-out floor. Zooming out past it only grows the empty
 * space between the board and its container: the wall keeps shrinking while
 * nothing else changes, which is unreadable and serves no purpose.
 */
export function fitCellSize(viewport: ViewportSize, margin = 8): number {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return FIT_MIN_CELL_PX;
  }
  const usableW = Math.max(1, viewport.width - margin * 2);
  const usableH = Math.max(1, viewport.height - margin * 2);
  return clampFitCellSize(
    Math.min(usableW / BOARD_WIDTH, usableH / BOARD_HEIGHT),
  );
}

/**
 * Fit the whole wall inside the viewport with a little margin.
 * Centers the board when the viewport aspect differs from the wall.
 */
export function fitCamera(viewport: ViewportSize, margin = 8): Camera {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { cellSize: FIT_MIN_CELL_PX, panX: 0, panY: 0 };
  }
  const cellSize = fitCellSize(viewport, margin);
  const board = boardScreenSize({ cellSize, panX: 0, panY: 0 });
  return {
    cellSize,
    panX: (viewport.width - board.width) / 2,
    panY: (viewport.height - board.height) / 2,
  };
}

/** Zoom so one cell is about `PAINT_CELL_PX`, keeping `focus` under the pivot. */
export function paintZoomCamera(
  viewport: ViewportSize,
  focus: Cell,
  cellSize: number = PAINT_CELL_PX,
): Camera {
  const size = clampCellSize(cellSize);
  const panX = viewport.width / 2 - (focus.x + 0.5) * size;
  const panY = viewport.height / 2 - (focus.y + 0.5) * size;
  return clampPan({ cellSize: size, panX, panY }, viewport);
}

export function clampCellSize(cellSize: number): number {
  if (!Number.isFinite(cellSize)) {
    return MIN_CELL_PX;
  }
  return Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, cellSize));
}

/** Whether the camera is close enough for an unambiguous paint target. */
export function isPaintZoom(camera: Camera): boolean {
  return camera.cellSize >= PAINT_MIN_CELL_PX;
}

/** Allow overview scales smaller than the painting zoom floor. */
export function clampFitCellSize(cellSize: number): number {
  if (!Number.isFinite(cellSize)) {
    return FIT_MIN_CELL_PX;
  }
  return Math.min(MAX_CELL_PX, Math.max(FIT_MIN_CELL_PX, cellSize));
}

/**
 * Keep some of the board visible. The whole board is always at least as large
 * as the viewport allows, so zooming out cannot open a gap around it.
 * When zoomed in, allow panning but do not lose the wall entirely.
 */
export function clampPan(camera: Camera, viewport: ViewportSize): Camera {
  const floor = fitCellSize(viewport);
  const cellSize = Math.min(MAX_CELL_PX, Math.max(floor, camera.cellSize));
  const board = boardScreenSize({ cellSize, panX: 0, panY: 0 });
  const panX = clampAxis(camera.panX, viewport.width, board.width);
  const panY = clampAxis(camera.panY, viewport.height, board.height);
  return { cellSize, panX, panY };
}

/** Zoom per wheel notch on a classic mouse (deltaY of 100). */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** A single wheel event may never move the camera more than this. */
const WHEEL_ZOOM_MAX_STEP = 1.2;

/**
 * Convert a wheel event into a zoom factor.
 *
 * A trackpad emits dozens of small events per gesture, so a fixed factor per
 * event multiplies into a violent jump: one flick crossed the entire zoom range.
 * Scaling by the actual delta, exponentially, makes a gesture compose smoothly,
 * while the per-event clamp keeps a single massive notch from teleporting.
 *
 * `deltaMode` 1 = lines, 2 = pages (Firefox and some mice).
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 1;
  }
  const pixels =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  const factor = Math.exp(-pixels * WHEEL_ZOOM_SENSITIVITY);
  return Math.min(
    WHEEL_ZOOM_MAX_STEP,
    Math.max(1 / WHEEL_ZOOM_MAX_STEP, factor),
  );
}

function clampAxis(pan: number, viewport: number, board: number): number {
  if (board <= viewport) {
    return (viewport - board) / 2;
  }
  const min = viewport - board;
  const max = 0;
  return Math.min(max, Math.max(min, pan));
}

/**
 * Zoom toward a pivot point in viewport coordinates (e.g. pointer position).
 * `factor` > 1 zooms in; < 1 zooms out.
 */
export function zoomAt(
  camera: Camera,
  viewport: ViewportSize,
  factor: number,
  pivotX: number,
  pivotY: number,
): Camera {
  if (!Number.isFinite(factor) || factor <= 0) {
    return camera;
  }
  // The floor is the fitted size: below that the board would float in empty
  // space, so a zoom-out gesture simply stops.
  const nextSize = Math.min(
    MAX_CELL_PX,
    Math.max(fitCellSize(viewport), camera.cellSize * factor),
  );
  if (nextSize === camera.cellSize) {
    return clampPan(camera, viewport);
  }
  const boardX = (pivotX - camera.panX) / camera.cellSize;
  const boardY = (pivotY - camera.panY) / camera.cellSize;
  const panX = pivotX - boardX * nextSize;
  const panY = pivotY - boardY * nextSize;
  return clampPan({ cellSize: nextSize, panX, panY }, viewport);
}

export function panBy(camera: Camera, viewport: ViewportSize, dx: number, dy: number): Camera {
  return clampPan(
    { cellSize: camera.cellSize, panX: camera.panX + dx, panY: camera.panY + dy },
    viewport,
  );
}

/** Map a point inside the viewport to a board cell, or null if outside the wall. */
export function cellFromViewportPoint(
  viewportX: number,
  viewportY: number,
  camera: Camera,
): Cell | null {
  return createCameraTransform(camera).cellAt(viewportX, viewportY);
}

/** CSS transform placing the board stage from camera state. */
export function stageTransform(camera: Camera): string {
  return createCameraTransform(camera).stage.transform;
}

/** Width/height CSS for the stage so each cell matches `camera.cellSize`. */
export function stageSizeStyle(camera: Camera): { width: string; height: string } {
  const board = createCameraTransform(camera).stage;
  return {
    width: `${board.width}px`,
    height: `${board.height}px`,
  };
}

export function isPanGesture(dx: number, dy: number, threshold = PAN_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
