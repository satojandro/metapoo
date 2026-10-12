/**
 * Regenerate Worker D handoff: canonical state/snapshot hashes from shared encoder.
 *
 * Usage: npm run generate-fixtures
 * Live NEAR Lake is NOT used.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HistoryService } from "../src/service.ts";
import type { BaselineManifest, ExecutionRecord } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");

const baselineDoc = JSON.parse(
  readFileSync(join(fixturesDir, "baseline-empty-board.json"), "utf8"),
);
const streamDoc = JSON.parse(
  readFileSync(join(fixturesDir, "execution-stream.json"), "utf8"),
);
const overwriteDoc = JSON.parse(
  readFileSync(join(fixturesDir, "overwrite-scenario.json"), "utf8"),
);

const baseline = baselineDoc.baseline as BaselineManifest;
const svc = new HistoryService(baseline, { checkpointInterval: 2 });

const streamRecords = (streamDoc.records as ExecutionRecord[]).filter(
  (r) => r.executionOutcome === "SuccessValue" || r.executionOutcome === "Failure",
);
svc.ingestAll(streamRecords);

const revision = svc.getStore().getIndexedRevision();
const manifest = svc.buildManifestForWorkerD(revision, {
  attesterAccountId: "attester.mpoo.testnet",
  manifestUri: "fixture://services/history/fixtures/manifest-for-worker-d.json",
});

const overwriteSvc = new HistoryService(baseline, { checkpointInterval: 1 });
overwriteSvc.ingestAll(overwriteDoc.records as ExecutionRecord[]);
const ow1 = overwriteSvc.buildManifestForWorkerD("1", {
  attesterAccountId: "attester.mpoo.testnet",
  manifestUri: "fixture://overwrite-rev1",
});
const ow2 = overwriteSvc.buildManifestForWorkerD("2", {
  attesterAccountId: "attester.mpoo.testnet",
  manifestUri: "fixture://overwrite-rev2",
});

const handoff = {
  title: "History → Prints (Worker D) snapshot handoff",
  status: {
    implemented: true,
    fixtureTested: true,
    liveVerified: "N/A — fixture ingest only; NEAR Lake not wired",
  },
  note:
    "Canonical hashes from shared/history encoders (raw-byte genesis/block). Register via attester after independent verification. Do not treat content hash as proof of on-chain existence.",
  board: baseline.board,
  geometry: {
    width: baseline.geometry.width,
    height: baseline.geometry.height,
    paletteVersion: baseline.geometry.paletteVersion,
    chainGenesisHash: baseline.geometry.chainGenesisHash,
  },
  coverage: svc.coverage(),
  primarySnapshot: {
    revision: manifest.revision,
    snapshotId: manifest.snapshotId,
    stateHash: manifest.stateHash,
    manifestHash: manifest.manifestHash,
    receiptId: manifest.receiptId,
    finalizedBlockHash: manifest.finalizedBlockHash,
    finalizedBlockHeight: manifest.finalizedBlockHeight,
    finalizedBlockTimestampNs: manifest.finalizedBlockTimestampNs,
    attesterAccountId: manifest.attesterAccountId,
    manifestUri: manifest.manifestUri,
    mediaHash: null,
    stateBytesHex: manifest.stateBytesHex,
    snapshotBytesHex: manifest.snapshotBytesHex,
  },
  overwritePair: {
    note: "Same cell painted then overwritten; both revisions have distinct snapshotIds.",
    revision1: {
      revision: ow1.revision,
      snapshotId: ow1.snapshotId,
      stateHash: ow1.stateHash,
      receiptId: ow1.receiptId,
    },
    revision2: {
      revision: ow2.revision,
      snapshotId: ow2.snapshotId,
      stateHash: ow2.stateHash,
      receiptId: ow2.receiptId,
    },
  },
  sourceFixtures: [
    "baseline-empty-board.json",
    "execution-stream.json",
    "overwrite-scenario.json",
  ],
};

const outPath = join(fixturesDir, "manifest-for-worker-d.json");
writeFileSync(outPath, `${JSON.stringify(handoff, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
console.log(`primary snapshotId=${manifest.snapshotId}`);
console.log(`overwrite rev1=${ow1.snapshotId} rev2=${ow2.snapshotId}`);
