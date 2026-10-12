import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRINT_DOMAIN,
  SNAPSHOT_DOMAIN,
  STATE_DOMAIN,
  bytesToHex,
  concatBytes,
  encodeAbsentCell,
  encodeCanonicalStateBytes,
  encodePresentCell,
  encodePrintIdentityBytes,
  encodeSnapshotIdentityBytes,
  encodeU16BE,
  encodeU32BE,
  encodeU64BEFromDecimal,
  hexToBytes32,
} from "./encode.ts";

test("domain separators end with NUL", () => {
  assert.equal(STATE_DOMAIN.endsWith("\0"), true);
  assert.equal(SNAPSHOT_DOMAIN.endsWith("\0"), true);
  assert.equal(PRINT_DOMAIN.endsWith("\0"), true);
});

test("big-endian integer helpers", () => {
  assert.deepEqual([...encodeU16BE(0x1234)], [0x12, 0x34]);
  assert.deepEqual([...encodeU32BE(0x01020304)], [1, 2, 3, 4]);
  assert.deepEqual(
    [...encodeU64BEFromDecimal("255")],
    [0, 0, 0, 0, 0, 0, 0, 255],
  );
});

test("empty 1×1 board encodes domain and absent cell", () => {
  const bytes = encodeCanonicalStateBytes({
    chainGenesisHash: "g",
    boardAccountId: "board.test",
    boardEpoch: "1",
    width: 1,
    height: 1,
    paletteVersion: "palette-v2",
    palette: [{ index: 0, name: "Ink", r: 1, g: 2, b: 3 }],
    emptyRgba: [0, 0, 0, 0],
    cells: [encodeAbsentCell()],
  });
  assert.equal(bytes[0], "M".charCodeAt(0));
  assert.equal(bytes[bytes.length - 1], 0); // absent cell
  assert.ok(bytes.length > STATE_DOMAIN.length);
});

test("present cell includes color artist and timestamp", () => {
  const cell = encodePresentCell(2, "alice.testnet", "100");
  assert.equal(cell[0], 1);
  assert.deepEqual([...cell.slice(1, 3)], [...encodeU16BE(2)]);
});

test("snapshot and print identity round-trip hex helpers", () => {
  const hash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(bytesToHex(hexToBytes32(hash)), hash);
  const snap = encodeSnapshotIdentityBytes({
    stateHashHex: hash,
    finalizedBlockHash: "block",
    blockHeight: "1",
    blockTimestampNs: "2",
    revision: "3",
    receiptId: "",
  });
  assert.ok(snap.length > SNAPSHOT_DOMAIN.length);
  const print = encodePrintIdentityBytes({
    snapshotHashHex: hash,
    crop: { x: 0, y: 0, width: 8, height: 8 },
  });
  assert.ok(print.length > PRINT_DOMAIN.length);
});

test("concatBytes preserves order", () => {
  const out = concatBytes([Uint8Array.of(1, 2), Uint8Array.of(3)]);
  assert.deepEqual([...out], [1, 2, 3]);
});
