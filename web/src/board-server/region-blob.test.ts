import { describe, expect, it } from "vitest";
import {
  decodeRegionBlob,
  paletteIndexOfHex,
  readWrittenAtNs,
  REGION_BYTES,
  WRITTEN_AT_BYTES,
  writeBlobPixel,
  writeWrittenAtNs,
} from "./region-blob";

describe("board server region blob", () => {
  it("is 98,304 bytes and its written-at companion 131,072", () => {
    expect(REGION_BYTES).toBe(98_304);
    expect(WRITTEN_AT_BYTES).toBe(131_072);
  });

  it("decodes pixel (x, y) at byte (y*128+x)*6 as RGB and a u24 little-endian owner id", () => {
    const bytes = new Uint8Array(REGION_BYTES);
    const at = (5 * 128 + 3) * 6;
    // Brick #b23a2f, owner 0x030201.
    bytes.set([0xb2, 0x3a, 0x2f, 0x01, 0x02, 0x03], at);
    expect(decodeRegionBlob(bytes)).toEqual([{ x: 3, y: 5, colorIndex: 2, ownerId: 0x030201 }]);
  });

  it("skips never-painted tiles and colours outside the palette", () => {
    const bytes = new Uint8Array(REGION_BYTES);
    bytes.set([0xb2, 0x3a, 0x2f, 0, 0, 0], 0); // owner 0: never painted
    bytes.set([0x12, 0x34, 0x56, 1, 0, 0], 6); // not a palette colour
    expect(decodeRegionBlob(bytes)).toEqual([]);
  });

  it("rejects a blob of the wrong size", () => {
    expect(() => decodeRegionBlob(new Uint8Array(10))).toThrow(/98304/);
  });

  it("round-trips a WebSocket write through the blob", () => {
    const bytes = new Uint8Array(REGION_BYTES);
    writeBlobPixel(bytes, 127, 127, 15, 70_000);
    expect(decodeRegionBlob(bytes)).toEqual([{ x: 127, y: 127, colorIndex: 15, ownerId: 70_000 }]);
  });

  it("maps the server's RRGGBB back to the palette index", () => {
    expect(paletteIndexOfHex("1c1917")).toBe(0);
    expect(paletteIndexOfHex("EF7A2C")).toBe(15);
    expect(paletteIndexOfHex("000000")).toBeNull();
  });

  it("keeps every digit of a u64 written_at_ns", () => {
    const written = new Uint8Array(WRITTEN_AT_BYTES);
    const ns = "1762500000123456789"; // above 2^53
    writeWrittenAtNs(written, 4, 9, ns);
    expect(readWrittenAtNs(written, 4, 9)).toBe(ns);
    expect(readWrittenAtNs(written, 0, 0)).toBeNull();
  });
});
