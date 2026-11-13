import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  BYTES_PER_PIXEL,
  EMPTY_A,
  EMPTY_B,
  REGION_BYTES,
  REGION_SIDE,
  crc32,
  encodePng,
  entrySkeleton,
  gridFromChainPixels,
  gridFromRegionBlob,
  parseCrop,
  rasterize,
} from "../lib.mjs";

const PALETTE = [
  { index: 0, name: "Ink", hex: "#1c1917" },
  { index: 2, name: "Brick", hex: "#b23a2f" },
];

function blobWith(tiles) {
  const bytes = new Uint8Array(REGION_BYTES);
  for (const { x, y, rgb, owner } of tiles) {
    const at = (y * REGION_SIDE + x) * BYTES_PER_PIXEL;
    bytes.set(rgb, at);
    bytes[at + 3] = owner & 0xff;
    bytes[at + 4] = (owner >> 8) & 0xff;
    bytes[at + 5] = (owner >> 16) & 0xff;
  }
  return bytes;
}

test("the region blob keeps painted tiles and leaves owner-0 tiles empty", () => {
  const bytes = blobWith([
    { x: 1, y: 0, rgb: [0xb2, 0x3a, 0x2f], owner: 7 },
    // RGB set but owner 0: never painted, must stay empty.
    { x: 2, y: 0, rgb: [0xff, 0xff, 0xff], owner: 0 },
  ]);
  const grid = gridFromRegionBlob(bytes, 4);
  assert.deepEqual(grid.cells[1], [0xb2, 0x3a, 0x2f]);
  assert.equal(grid.cells[2], null);
  assert.equal(grid.cells[0], null);
});

test("a blob of the wrong length is refused, not read", () => {
  assert.throws(() => gridFromRegionBlob(new Uint8Array(10), 4), /expected 98304/);
});

test("chain pixels map through the palette, and an unknown colour is an error", () => {
  const grid = gridFromChainPixels([{ x: 0, y: 1, color: 2 }], 2, PALETTE);
  assert.deepEqual(grid.cells[2], [0xb2, 0x3a, 0x2f]);
  assert.throws(() => gridFromChainPixels([{ x: 0, y: 0, color: 9 }], 2, PALETTE), /not in the palette/);
});

test("crop defaults to the whole board and refuses a rectangle off the edge", () => {
  assert.deepEqual(parseCrop(undefined, 64), { x: 0, y: 0, w: 64, h: 64 });
  assert.deepEqual(parseCrop("10, 12, 8, 4", 64), { x: 10, y: 12, w: 8, h: 4 });
  assert.throws(() => parseCrop("60,0,8,8", 64), /does not fit/);
  assert.throws(() => parseCrop("1,2,3", 64), /x,y,w,h/);
});

test("rasterize scales each tile to a solid block and checkers empty tiles by board position", () => {
  const grid = gridFromChainPixels([{ x: 1, y: 1, color: 0 }], 4, PALETTE);
  // Crop starting at (1,0): the checker must key on board coordinates, not crop ones.
  const { width, height, rgb } = rasterize(grid, { x: 1, y: 0, w: 2, h: 2 }, 3);
  assert.equal(width, 6);
  assert.equal(height, 6);
  const at = (px, py) => [...rgb.subarray((py * width + px) * 3, (py * width + px) * 3 + 3)];
  assert.deepEqual(at(0, 0), EMPTY_B); // board (1,0): odd
  assert.deepEqual(at(3, 0), EMPTY_A); // board (2,0): even
  assert.deepEqual(at(0, 3), [0x1c, 0x19, 0x17]); // board (1,1): Ink
  assert.deepEqual(at(2, 5), [0x1c, 0x19, 0x17]); // same tile, other corner
});

test("the PNG is valid: signature, IHDR, CRCs, and the pixels inflate back", () => {
  const image = { width: 2, height: 1, rgb: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const png = encodePng(image, { Block: "123" });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  const chunks = {};
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `${type} CRC`);
    chunks[type] = data;
    at += 12 + len;
  }
  assert.equal(chunks.IHDR.readUInt32BE(0), 2);
  assert.equal(chunks.IHDR.readUInt32BE(4), 1);
  assert.equal(chunks.tEXt.toString("latin1"), "Block\u0000123");
  assert.deepEqual([...inflateSync(chunks.IDAT)], [0, 1, 2, 3, 4, 5, 6]);
  assert.ok("IEND" in chunks);
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("the entry skeleton centres the camera on the crop and leaves the human fields as TODO", () => {
  const entry = entrySkeleton({ id: "a", block: 9, crop: { x: 10, y: 20, w: 8, h: 4 }, image: "/hall/a.png", date: "2026-11-13" });
  assert.equal(entry.x, 14);
  assert.equal(entry.y, 22);
  assert.equal(entry.title, "TODO");
  assert.deepEqual(entry.painters, ["TODO"]);
});
