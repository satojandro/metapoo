/**
 * The board server's region blob: Berry Fast's format, one region for the whole wall.
 *
 * 128 × 128 pixels, row-major, 6 bytes each: R, G, B, then the owner id as a u24
 * little-endian. Owner id 0 means the tile has never been painted. Pixel (x, y) starts
 * at byte (y * 128 + x) * 6. The server derives RGB from the palette index
 * (`shared/palette.ts`), so mapping it back is exact; a colour not in the palette is
 * dropped rather than guessed.
 */
import { PALETTE } from "@shared/palette.ts";

export const REGION_SIDE = 128;
export const BYTES_PER_PIXEL = 6;
export const REGION_BYTES = REGION_SIDE * REGION_SIDE * BYTES_PER_PIXEL; // 98,304

/** One painted tile as the blob knows it: no artist name and no write time. */
export interface BlobPixel {
  x: number;
  y: number;
  colorIndex: number;
  ownerId: number;
}

const RGB_TO_INDEX = new Map<number, number>(
  PALETTE.map((color) => [Number.parseInt(color.hex.slice(1), 16), color.index]),
);

/** Palette index for a 24-bit colour, or null when the palette has no such colour. */
export function paletteIndexOfRgb(rgb: number): number | null {
  return RGB_TO_INDEX.get(rgb) ?? null;
}

/** Palette index for "RRGGBB" (as the WebSocket sends it), or null. */
export function paletteIndexOfHex(hex: string): number | null {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return paletteIndexOfRgb(Number.parseInt(hex, 16));
}

export function isRegionBlob(bytes: Uint8Array): boolean {
  return bytes.byteLength === REGION_BYTES;
}

/** Every painted tile in the blob, in row-major order. */
export function decodeRegionBlob(bytes: Uint8Array): BlobPixel[] {
  if (!isRegionBlob(bytes)) {
    throw new Error(`Board server region is ${bytes.byteLength} bytes, expected ${REGION_BYTES}.`);
  }
  const pixels: BlobPixel[] = [];
  for (let y = 0; y < REGION_SIDE; y += 1) {
    for (let x = 0; x < REGION_SIDE; x += 1) {
      const at = (y * REGION_SIDE + x) * BYTES_PER_PIXEL;
      const ownerId = bytes[at + 3]! | (bytes[at + 4]! << 8) | (bytes[at + 5]! << 16);
      if (ownerId === 0) continue;
      const rgb = (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;
      const colorIndex = paletteIndexOfRgb(rgb);
      if (colorIndex === null) continue;
      pixels.push({ x, y, colorIndex, ownerId });
    }
  }
  return pixels;
}

/** Write one tile into the blob in place (a WebSocket draw). Out-of-range tiles are ignored. */
export function writeBlobPixel(bytes: Uint8Array, x: number, y: number, colorIndex: number, ownerId: number): void {
  if (!isRegionBlob(bytes)) return;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= REGION_SIDE || y >= REGION_SIDE) return;
  const color = PALETTE[colorIndex];
  if (!color || !Number.isInteger(ownerId) || ownerId < 0 || ownerId > 0xffffff) return;
  const rgb = Number.parseInt(color.hex.slice(1), 16);
  const at = (y * REGION_SIDE + x) * BYTES_PER_PIXEL;
  bytes[at] = (rgb >> 16) & 0xff;
  bytes[at + 1] = (rgb >> 8) & 0xff;
  bytes[at + 2] = rgb & 0xff;
  bytes[at + 3] = ownerId & 0xff;
  bytes[at + 4] = (ownerId >> 8) & 0xff;
  bytes[at + 5] = (ownerId >> 16) & 0xff;
}

/** `/api/region/0/0/written-at`: one u64 little-endian `written_at_ns` per tile, same order. */
export const WRITTEN_AT_BYTES = REGION_SIDE * REGION_SIDE * 8; // 131,072

export function isWrittenAtBlob(bytes: Uint8Array): boolean {
  return bytes.byteLength === WRITTEN_AT_BYTES;
}

function inRegion(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < REGION_SIDE && y < REGION_SIDE;
}

/** The tile's `written_at_ns` as digits, or null when unknown or never painted (0). */
export function readWrittenAtNs(bytes: Uint8Array | null, x: number, y: number): string | null {
  if (!bytes || !isWrittenAtBlob(bytes) || !inRegion(x, y)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getBigUint64((y * REGION_SIDE + x) * 8, true);
  return value === 0n ? null : value.toString();
}

/** Write one tile's `written_at_ns` (digits) in place. Ignores anything that is not a u64. */
export function writeWrittenAtNs(bytes: Uint8Array | null, x: number, y: number, writtenAtNs: string | null): void {
  if (!bytes || !isWrittenAtBlob(bytes) || writtenAtNs === null || !/^\d+$/.test(writtenAtNs) || !inRegion(x, y)) return;
  const value = BigInt(writtenAtNs);
  if (value >= 1n << 64n) return;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64((y * REGION_SIDE + x) * 8, value, true);
}
