import type { PixelCell, PixelMap, BoardGeometry } from "./types.ts";

export function cellIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

export function emptyPixelMap(): PixelMap {
  return new Map();
}

export function clonePixelMap(pixels: PixelMap): PixelMap {
  const next = new Map<number, PixelCell>();
  for (const [k, v] of pixels) {
    next.set(k, { ...v });
  }
  return next;
}

export function applyDraw(
  pixels: PixelMap,
  width: number,
  height: number,
  x: number,
  y: number,
  color: number,
  artist: string,
  writtenAtNs: string,
): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new RangeError(`coordinate out of bounds: (${x},${y})`);
  }
  pixels.set(cellIndex(x, y, width), { color, artist, writtenAtNs });
}

export function pixelsToSparseList(
  pixels: PixelMap,
  width: number,
): Array<{ x: number; y: number; color: number; artist: string; writtenAtNs: string }> {
  const out: Array<{
    x: number;
    y: number;
    color: number;
    artist: string;
    writtenAtNs: string;
  }> = [];
  for (const [idx, cell] of pixels) {
    const x = idx % width;
    const y = Math.floor(idx / width);
    out.push({ x, y, color: cell.color, artist: cell.artist, writtenAtNs: cell.writtenAtNs });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

export function sparseListToPixels(
  list: Array<{ x: number; y: number; color: number; artist: string; writtenAtNs: string }>,
  width: number,
): PixelMap {
  const pixels = emptyPixelMap();
  for (const p of list) {
    pixels.set(cellIndex(p.x, p.y, width), {
      color: p.color,
      artist: p.artist,
      writtenAtNs: p.writtenAtNs,
    });
  }
  return pixels;
}

/** Ink (palette 0) is a real color; empty cells are absent from the map. */
export function isEmptyCell(pixels: PixelMap, x: number, y: number, width: number): boolean {
  return !pixels.has(cellIndex(x, y, width));
}

export function assertGeometry(geometry: BoardGeometry): void {
  if (geometry.width <= 0 || geometry.height <= 0) {
    throw new RangeError("board dimensions must be positive");
  }
}
