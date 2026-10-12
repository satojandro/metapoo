/**
 * Canonical board-state / snapshot / print identity encoders (Wave 1 stub).
 *
 * Spec: docs/implementation/history-and-prints.md
 * Full SHA-256 golden vectors land with History agent C; this module freezes
 * the byte layout so contracts and clients share one identity definition.
 *
 * All multi-byte integers are unsigned big-endian. Strings are UTF-8 preceded
 * by a u32 byte length. Hashes are 32 raw SHA-256 bytes when hashing is applied.
 */

import type { CropRect } from "../protocol/bounties.ts";
import type { PaletteEntryCanonical } from "../protocol/history.ts";

const textEncoder = new TextEncoder();

/** Domain separators (ASCII + trailing NUL). */
export const STATE_DOMAIN = "MPOO_STATE_V1\0";
export const SNAPSHOT_DOMAIN = "MPOO_SNAPSHOT_V1\0";
export const PRINT_DOMAIN = "MPOO_PRINT_V1\0";

export function encodeU16BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16 out of range: ${value}`);
  }
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

export function encodeU32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export function encodeU64BEFromDecimal(decimal: string): Uint8Array {
  if (!/^\d+$/.test(decimal)) {
    throw new RangeError(`u64 decimal string required, got ${decimal}`);
  }
  let n = BigInt(decimal);
  const max = (1n << 64n) - 1n;
  if (n < 0n || n > max) {
    throw new RangeError(`u64 out of range: ${decimal}`);
  }
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function encodePrefixedString(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  const length = encodeU32BE(bytes.length);
  const out = new Uint8Array(length.length + bytes.length);
  out.set(length, 0);
  out.set(bytes, length.length);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface CanonicalStateEncodeInput {
  /**
   * Chain genesis / crypto hash as 64 hex chars (optional 0x). Encoded as
   * 32 raw bytes — not a length-prefixed UTF-8 string.
   */
  chainGenesisHash: string;
  boardAccountId: string;
  boardEpoch: string;
  width: number;
  height: number;
  paletteVersion: string;
  palette: readonly PaletteEntryCanonical[];
  emptyRgba: readonly [number, number, number, number];
  /**
   * Exactly width×height cells, row-major.
   * Absent: [0]. Present: [1, color u16 BE..., artist string..., written_at u64 BE...].
   * Prefer helpers below rather than hand-building cell bytes.
   */
  cells: readonly Uint8Array[];
}

export function encodeAbsentCell(): Uint8Array {
  return Uint8Array.of(0);
}

export function encodePresentCell(
  colorIndex: number,
  artist: string,
  writtenAtNs: string,
): Uint8Array {
  return concatBytes([
    Uint8Array.of(1),
    encodeU16BE(colorIndex),
    encodePrefixedString(artist),
    encodeU64BEFromDecimal(writtenAtNs),
  ]);
}

/**
 * Encode MPOO_STATE_V1 board-state bytes (without hashing).
 * Caller must supply exactly width×height cell encodings.
 */
export function encodeCanonicalStateBytes(input: CanonicalStateEncodeInput): Uint8Array {
  if (input.cells.length !== input.width * input.height) {
    throw new RangeError(
      `expected ${input.width * input.height} cells, got ${input.cells.length}`,
    );
  }
  const sortedPalette = [...input.palette].sort((a, b) => a.index - b.index);
  const paletteParts: Uint8Array[] = [
    encodePrefixedString(input.paletteVersion),
    encodeU16BE(sortedPalette.length),
  ];
  for (const entry of sortedPalette) {
    paletteParts.push(
      encodeU16BE(entry.index),
      encodePrefixedString(entry.name),
      Uint8Array.of(entry.r & 0xff, entry.g & 0xff, entry.b & 0xff),
    );
  }
  const [er, eg, eb, ea] = input.emptyRgba;
  return concatBytes([
    textEncoder.encode(STATE_DOMAIN),
    hexToBytes32(input.chainGenesisHash),
    encodePrefixedString(input.boardAccountId),
    encodePrefixedString(input.boardEpoch),
    encodeU32BE(input.width),
    encodeU32BE(input.height),
    ...paletteParts,
    Uint8Array.of(er & 0xff, eg & 0xff, eb & 0xff, ea & 0xff),
    ...input.cells,
  ]);
}

export interface SnapshotIdentityInput {
  stateHashHex: string;
  /**
   * Finalized block crypto hash as 64 hex chars (optional 0x). Encoded as
   * 32 raw bytes — not a length-prefixed UTF-8 string.
   */
  finalizedBlockHash: string;
  blockHeight: string;
  blockTimestampNs: string;
  revision: string;
  /** Empty only for baseline/end-of-block legacy snapshots. */
  receiptId: string;
}

/** Encode MPOO_SNAPSHOT_V1 bytes (state + block hashes as 32 raw bytes). */
export function encodeSnapshotIdentityBytes(input: SnapshotIdentityInput): Uint8Array {
  return concatBytes([
    textEncoder.encode(SNAPSHOT_DOMAIN),
    hexToBytes32(input.stateHashHex),
    hexToBytes32(input.finalizedBlockHash),
    encodeU64BEFromDecimal(input.blockHeight),
    encodeU64BEFromDecimal(input.blockTimestampNs),
    encodeU64BEFromDecimal(input.revision),
    encodePrefixedString(input.receiptId),
  ]);
}

export interface PrintIdentityInput {
  snapshotHashHex: string;
  crop: CropRect;
}

/** Encode MPOO_PRINT_V1 identity bytes. */
export function encodePrintIdentityBytes(input: PrintIdentityInput): Uint8Array {
  const { crop } = input;
  if (crop.width <= 0 || crop.height <= 0) {
    throw new RangeError("crop dimensions must be positive");
  }
  return concatBytes([
    textEncoder.encode(PRINT_DOMAIN),
    hexToBytes32(input.snapshotHashHex),
    encodeU32BE(crop.x),
    encodeU32BE(crop.y),
    encodeU32BE(crop.width),
    encodeU32BE(crop.height),
  ]);
}

export function hexToBytes32(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new RangeError("expected 32-byte hash as 64 hex chars");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Hex encode without 0x prefix (lowercase). */
export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
