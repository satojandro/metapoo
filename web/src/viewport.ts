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
  return {
    camera: snapshot,
    stage: {
      left: snapshot.panX,
      top: snapshot.panY,
      width: board.width,
      height: board.height,
      transform: `translate(${snapshot.panX}px, ${snapshot.panY}px)`,
    },
    cellAt(viewportX, viewportY) {
      const x = Math.floor((viewportX - snapshot.panX) / snapshot.cellSize);
      const y = Math.floor((viewportY - snapshot.panY) / snapshot.cellSize);
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

/**
 * Fit the whole wall inside the viewport with a little margin.
 * Centers the board when the viewport aspect differs from the wall.
 */
export function fitCamera(viewport: ViewportSize, margin = 8): Camera {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { cellSize: FIT_MIN_CELL_PX, panX: 0, panY: 0 };
  }
  const usableW = Math.max(1, viewport.width - margin * 2);
  const usableH = Math.max(1, viewport.height - margin * 2);
  // Overview may go below MIN_CELL_PX so small viewports still show the whole wall.
  const cellSize = clampFitCellSize(
    Math.min(usableW / BOARD_WIDTH, usableH / BOARD_HEIGHT),
  );
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
 * Keep some of the board visible. When zoomed out past the viewport, center.
 * When zoomed in, allow panning but do not lose the wall entirely.
 * Preserves sub-MIN overview scales from fitCamera.
 */
export function clampPan(camera: Camera, viewport: ViewportSize): Camera {
  const cellSize =
    camera.cellSize < MIN_CELL_PX
      ? clampFitCellSize(camera.cellSize)
      : clampCellSize(camera.cellSize);
  const board = boardScreenSize({ cellSize, panX: 0, panY: 0 });
  const panX = clampAxis(camera.panX, viewport.width, board.width);
  const panY = clampAxis(camera.panY, viewport.height, board.height);
  return { cellSize, panX, panY };
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
  // Keep fit/overview reachable with a wheel or pinch. `clampPan` already
  // distinguishes that sub-interactive range from normal zoomed-in values;
  // forcing MIN_CELL_PX here would make a zoom-out from a small overview jump
  // *in* to 2px cells.
  const nextSize = clampFitCellSize(camera.cellSize * factor);
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
