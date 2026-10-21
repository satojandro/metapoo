/** A two-dimensional coordinate in screen or board-pixel space. */
export interface Point {
  x: number;
  y: number;
}

/** Width and height in one coordinate space. Both values must be positive. */
export interface Size {
  width: number;
  height: number;
}

/**
 * The one transform used for a board bitmap, its pointer hit testing, and its
 * overlays. Board coordinates are bitmap pixels, before this scale is applied.
 */
export interface CameraTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Bounds and optional scale limits used when changing a camera. */
export interface CameraBounds {
  board: Size;
  container: Size;
  minScale?: number;
  maxScale?: number;
}

/** Inclusive integer coordinates of a logical board cell. */
export interface BoardCell {
  x: number;
  y: number;
}

/**
 * Returns a centered overview camera. A board smaller than its container stays
 * centered; a larger board is scaled down so every board pixel is visible.
 */
export function fitCameraToContainer(
  board: Size,
  container: Size,
): CameraTransform {
  assertPositiveSize(board, "board");
  assertPositiveSize(container, "container");

  const scale = Math.min(
    container.width / board.width,
    container.height / board.height,
  );
  return clampCamera(
    { scale, offsetX: 0, offsetY: 0 },
    { board, container },
  );
}

/** Keep the board in view, centering an axis when it is smaller than the viewport. */
export function clampCamera(
  camera: CameraTransform,
  bounds: CameraBounds,
): CameraTransform {
  assertPositiveSize(bounds.board, "board");
  assertPositiveSize(bounds.container, "container");
  assertFinitePositive(camera.scale, "camera scale");

  const scale = clampScale(camera.scale, bounds);
  return {
    scale,
    offsetX: clampOffset(
      camera.offsetX,
      bounds.board.width * scale,
      bounds.container.width,
    ),
    offsetY: clampOffset(
      camera.offsetY,
      bounds.board.height * scale,
      bounds.container.height,
    ),
  };
}

/**
 * Scales around a screen-space focal point. The board point below the focal
 * point remains below it unless the resulting camera reaches an edge.
 */
export function zoomCameraAtPoint(
  camera: CameraTransform,
  focalPoint: Point,
  scaleMultiplier: number,
  bounds: CameraBounds,
): CameraTransform {
  assertFinitePositive(scaleMultiplier, "scale multiplier");
  const current = clampCamera(camera, bounds);
  const scale = clampScale(current.scale * scaleMultiplier, bounds);
  const scaleRatio = scale / current.scale;

  return clampCamera(
    {
      scale,
      offsetX: focalPoint.x - (focalPoint.x - current.offsetX) * scaleRatio,
      offsetY: focalPoint.y - (focalPoint.y - current.offsetY) * scaleRatio,
    },
    bounds,
  );
}

/** Move the board by a screen-space pointer delta, without exposing empty space. */
export function panCameraBy(
  camera: CameraTransform,
  screenDelta: Point,
  bounds: CameraBounds,
): CameraTransform {
  return clampCamera(
    {
      scale: camera.scale,
      offsetX: camera.offsetX + screenDelta.x,
      offsetY: camera.offsetY + screenDelta.y,
    },
    bounds,
  );
}

/** Convert a board-pixel point to screen coordinates. */
export function boardToScreenPoint(
  boardPoint: Point,
  camera: CameraTransform,
): Point {
  return {
    x: boardPoint.x * camera.scale + camera.offsetX,
    y: boardPoint.y * camera.scale + camera.offsetY,
  };
}

/** Convert a screen point to board-pixel coordinates. */
export function screenToBoardPoint(
  screenPoint: Point,
  camera: CameraTransform,
): Point {
  assertFinitePositive(camera.scale, "camera scale");
  return {
    x: (screenPoint.x - camera.offsetX) / camera.scale,
    y: (screenPoint.y - camera.offsetY) / camera.scale,
  };
}

/** Return the cell below a screen point, or null when it is outside the board. */
export function screenToBoardCell(
  screenPoint: Point,
  camera: CameraTransform,
  boardPixels: Size,
  cellSize = 1,
): BoardCell | null {
  assertPositiveSize(boardPixels, "board pixels");
  assertFinitePositive(cellSize, "cell size");
  const boardPoint = screenToBoardPoint(screenPoint, camera);
  if (
    boardPoint.x < 0 ||
    boardPoint.y < 0 ||
    boardPoint.x >= boardPixels.width ||
    boardPoint.y >= boardPixels.height
  ) {
    return null;
  }
  return {
    x: Math.floor(boardPoint.x / cellSize),
    y: Math.floor(boardPoint.y / cellSize),
  };
}

/** Return the screen-space top-left point of a board cell. */
export function boardCellToScreenPoint(
  cell: BoardCell,
  camera: CameraTransform,
  cellSize = 1,
): Point {
  assertFinitePositive(cellSize, "cell size");
  return boardToScreenPoint(
    { x: cell.x * cellSize, y: cell.y * cellSize },
    camera,
  );
}

/** Clamp an integer cell coordinate to the nearest board cell. */
export function clampBoardCell(cell: BoardCell, boardCells: Size): BoardCell {
  assertPositiveSize(boardCells, "board cells");
  return {
    x: Math.min(Math.max(cell.x, 0), Math.floor(boardCells.width) - 1),
    y: Math.min(Math.max(cell.y, 0), Math.floor(boardCells.height) - 1),
  };
}

/** Whether a cell is within board bounds. */
export function isCellInBounds(cell: BoardCell, boardCells: Size): boolean {
  return (
    Number.isInteger(cell.x) &&
    Number.isInteger(cell.y) &&
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < boardCells.width &&
    cell.y < boardCells.height
  );
}

/**
 * A pointer sequence is a tap when its straight-line movement stays within the
 * supplied screen-pixel threshold. The boundary itself still counts as a tap.
 */
export function isTap(
  start: Point,
  end: Point,
  movementThreshold = 8,
): boolean {
  if (!Number.isFinite(movementThreshold) || movementThreshold < 0) {
    throw new Error("movement threshold must be a non-negative finite number");
  }
  return Math.hypot(end.x - start.x, end.y - start.y) <= movementThreshold;
}

function clampOffset(offset: number, boardLength: number, containerLength: number): number {
  if (!Number.isFinite(offset)) {
    throw new Error("camera offset must be finite");
  }
  if (boardLength <= containerLength) {
    return (containerLength - boardLength) / 2;
  }
  return Math.min(0, Math.max(containerLength - boardLength, offset));
}

function clampScale(scale: number, bounds: CameraBounds): number {
  const minScale = bounds.minScale ?? Number.MIN_VALUE;
  const maxScale = bounds.maxScale ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minScale) || minScale <= 0) {
    throw new Error("minimum scale must be a positive finite number");
  }
  if (maxScale < minScale || Number.isNaN(maxScale) || maxScale <= 0) {
    throw new Error("maximum scale must be at least the minimum scale");
  }
  return Math.min(maxScale, Math.max(minScale, scale));
}

function assertPositiveSize(size: Size, name: string): void {
  assertFinitePositive(size.width, `${name} width`);
  assertFinitePositive(size.height, `${name} height`);
}

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}
