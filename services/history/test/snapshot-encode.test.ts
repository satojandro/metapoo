import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import {
  encodeCanonicalStateBytes,
  encodeAbsentCell,
  encodeSnapshotIdentityBytes,
  bytesToHex,
} from "../../../shared/history/encode.ts";
import { HistoryService } from "../src/service.ts";
import { sha256Hex } from "../src/hash.ts";
import {
  fixturesDir,
  loadBaseline,
  loadExecutionStream,
  loadOverwriteScenario,
} from "./helpers.ts";

test("shared encoder: empty board state hash is stable SHA-256", () => {
  const baseline = loadBaseline();
  const cells = Array.from(
    { length: baseline.geometry.width * baseline.geometry.height },
    () => encodeAbsentCell(),
  );
  const bytes = encodeCanonicalStateBytes({
    chainGenesisHash: baseline.geometry.chainGenesisHash,
    boardAccountId: baseline.board.boardAccountId,
    boardEpoch: baseline.board.boardEpoch,
    width: baseline.geometry.width,
    height: baseline.geometry.height,
    paletteVersion: baseline.geometry.paletteVersion,
    palette: baseline.geometry.palette,
    emptyRgba: baseline.geometry.emptyRgba,
    cells,
  });
  // Genesis must appear as raw 32 bytes right after domain (14 bytes).
  const genesisOff = 14;
  assert.equal(
    bytesToHex(bytes.slice(genesisOff, genesisOff + 32)),
    baseline.geometry.chainGenesisHash,
  );
  const hash = sha256Hex(bytes);
  assert.match(hash, /^[0-9a-f]{64}$/);

  const svc = new HistoryService(baseline);
  const encoded = svc.encodeSnapshot("0");
  assert.equal(encoded.stateHash, hash);
  assert.equal(encoded.receiptId, "");
});

test("Worker D manifest fixture exists and matches recomputed hashes", () => {
  const path = join(fixturesDir, "manifest-for-worker-d.json");
  if (!existsSync(path)) {
    assert.fail("run npm run generate-fixtures first");
  }
  const handoff = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(handoff.status.liveVerified.startsWith("N/A"), true);

  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 2 });
  svc.ingestAll(loadExecutionStream());
  const rev = handoff.primarySnapshot.revision as string;
  const encoded = svc.encodeSnapshot(rev);
  assert.equal(encoded.snapshotId, handoff.primarySnapshot.snapshotId);
  assert.equal(encoded.stateHash, handoff.primarySnapshot.stateHash);

  const { records } = loadOverwriteScenario();
  const ow = new HistoryService(loadBaseline(), { checkpointInterval: 1 });
  ow.ingestAll(records);
  assert.equal(
    ow.encodeSnapshot("1").snapshotId,
    handoff.overwritePair.revision1.snapshotId,
  );
  assert.equal(
    ow.encodeSnapshot("2").snapshotId,
    handoff.overwritePair.revision2.snapshotId,
  );
});

test("snapshot identity uses raw block hash bytes (shared layout)", () => {
  const stateHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const blockHash =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const bytes = encodeSnapshotIdentityBytes({
    stateHashHex: stateHash,
    finalizedBlockHash: blockHash,
    blockHeight: "1",
    blockTimestampNs: "2",
    revision: "3",
    receiptId: "",
  });
  // Domain MPOO_SNAPSHOT_V1\0 = 17 bytes; then 32 state; then 32 block
  assert.equal(bytesToHex(bytes.slice(17, 49)), stateHash);
  assert.equal(bytesToHex(bytes.slice(49, 81)), blockHash);
});
