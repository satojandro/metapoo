import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

const fixturePath = fileURLToPath(
  new URL("../fixtures/history/canonical-hash-encoding.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

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

test("present cell includes color artist and timestamp", () => {
  const cell = encodePresentCell(2, "alice.testnet", "100");
  assert.equal(cell[0], 1);
  assert.deepEqual([...cell.slice(1, 3)], [...encodeU16BE(2)]);
});

test("concatBytes preserves order", () => {
  const out = concatBytes([Uint8Array.of(1, 2), Uint8Array.of(3)]);
  assert.deepEqual([...out], [1, 2, 3]);
});

test("hexToBytes32 rejects non-32-byte values", () => {
  assert.throws(() => hexToBytes32("aa"));
  assert.throws(() => hexToBytes32("not-hex"));
});

test("canonical state encodes genesis as 32 raw bytes (golden)", () => {
  const { input, expect } = fixture.state_1x1_absent;
  const bytes = encodeCanonicalStateBytes({
    ...input,
    emptyRgba: input.emptyRgba as [number, number, number, number],
    cells: [encodeAbsentCell()],
  });
  assert.equal(bytesToHex(bytes), expect.full_bytes_hex);
  const offset = expect.genesis_offset as number;
  assert.equal(
    bytesToHex(bytes.slice(offset, offset + 32)),
    expect.genesis_raw_hex,
  );
  // Must NOT be length-prefixed UTF-8 of the hex string (u32 length 64 = 0x40).
  assert.notEqual(bytes[offset], 0x00);
  assert.notEqual(bytes[offset + 1], 0x00);
  assert.notEqual(bytes[offset + 2], 0x00);
  assert.notEqual(bytes[offset + 3], 0x40);
});

test("snapshot identity encodes state and block hashes as raw bytes (golden)", () => {
  const { input, expect } = fixture.snapshot_identity;
  const bytes = encodeSnapshotIdentityBytes(input);
  assert.equal(bytesToHex(bytes), expect.full_bytes_hex);
  const stateOff = expect.state_raw_at_offset as number;
  const blockOff = expect.block_raw_at_offset as number;
  assert.equal(
    bytesToHex(bytes.slice(stateOff, stateOff + 32)),
    fixture.fixture_hashes.state,
  );
  assert.equal(
    bytesToHex(bytes.slice(blockOff, blockOff + 32)),
    fixture.fixture_hashes.block,
  );
});

test("print identity golden", () => {
  const { input, expect } = fixture.print_identity;
  const bytes = encodePrintIdentityBytes(input);
  assert.equal(bytesToHex(bytes), expect.full_bytes_hex);
});
