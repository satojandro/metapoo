import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";

/** One square on the board. x grows right, y grows down, origin is top-left. */
export interface Cell {
  x: number;
  y: number;
}

export function clampCell(x: number, y: number): Cell | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) {
    return null;
  }
  return { x, y };
}

/**
 * Arrow keys move one square and stop at the edge.
 * If nothing is selected yet, the first arrow selects the top-left square
 * instead of skipping past it.
 */
export function moveSelection(current: Cell | null, key: string): Cell | null {
  if (
    current === null &&
    (key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowRight")
  ) {
    return { x: 0, y: 0 };
  }
  if (current === null) {
    return null;
  }
  if (key === "ArrowLeft") {
    return { x: Math.max(0, current.x - 1), y: current.y };
  }
  if (key === "ArrowRight") {
    return { x: Math.min(BOARD_WIDTH - 1, current.x + 1), y: current.y };
  }
  if (key === "ArrowUp") {
    return { x: current.x, y: Math.max(0, current.y - 1) };
  }
  if (key === "ArrowDown") {
    return { x: current.x, y: Math.min(BOARD_HEIGHT - 1, current.y + 1) };
  }
  return current;
}

/**
 * Turn a click into a square. `offsetX` / `offsetY` are positions inside the
 * picture as the user sees it, after CSS has stretched the canvas.
 */
export function cellFromOffset(
  offsetX: number,
  offsetY: number,
  displayedWidth: number,
  displayedHeight: number,
): Cell | null {
  if (displayedWidth <= 0 || displayedHeight <= 0) {
    return null;
  }
  const x = Math.floor((offsetX / displayedWidth) * BOARD_WIDTH);
  const y = Math.floor((offsetY / displayedHeight) * BOARD_HEIGHT);
  return clampCell(x, y);
}
