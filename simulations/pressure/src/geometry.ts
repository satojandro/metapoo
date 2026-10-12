import type { BoardGeometry } from "./types.ts";

/**
 * region_columns = ceil(board_width / region_size)
 * region_id = floor(y / region_size) * region_columns + floor(x / region_size)
 *
 * Edge regions may be clipped when dimensions are not divisible by region_size.
 */
export function regionColumns(geometry: BoardGeometry): number {
  if (geometry.region_size <= 0) {
    throw new Error("region_size must be positive");
  }
  return Math.ceil(geometry.width / geometry.region_size);
}

export function regionRows(geometry: BoardGeometry): number {
  if (geometry.region_size <= 0) {
    throw new Error("region_size must be positive");
  }
  return Math.ceil(geometry.height / geometry.region_size);
}

export function regionCount(geometry: BoardGeometry): number {
  return regionColumns(geometry) * regionRows(geometry);
}

export function isInsideBoard(geometry: BoardGeometry, x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < geometry.width &&
    y < geometry.height
  );
}

export function regionId(geometry: BoardGeometry, x: number, y: number): number {
  if (!isInsideBoard(geometry, x, y)) {
    throw new Error(`coordinate (${x}, ${y}) is outside the board`);
  }
  const cols = regionColumns(geometry);
  const size = geometry.region_size;
  return Math.floor(y / size) * cols + Math.floor(x / size);
}

/** Inclusive pixel bounds for a region (clipped at the board edge). */
export function regionBounds(
  geometry: BoardGeometry,
  id: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const cols = regionColumns(geometry);
  const rows = regionRows(geometry);
  const total = cols * rows;
  if (!Number.isInteger(id) || id < 0 || id >= total) {
    throw new Error(`region_id ${id} is out of range 0..${total - 1}`);
  }
  const col = id % cols;
  const row = Math.floor(id / cols);
  const size = geometry.region_size;
  const x0 = col * size;
  const y0 = row * size;
  return {
    x0,
    y0,
    x1: Math.min(geometry.width - 1, x0 + size - 1),
    y1: Math.min(geometry.height - 1, y0 + size - 1),
  };
}
