import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryService } from "../src/service.ts";
import { cellIndex, isEmptyCell } from "../src/board-state.ts";
import { loadBaseline, loadExecutionStream } from "./helpers.ts";
import type { ExecutionRecord } from "../src/types.ts";

test("replays contiguous fixture stream and ignores failed outcomes", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 2 });
  const results = svc.ingestAll(loadExecutionStream());
  const accepted = results.filter((r) => r.outcome === "accepted");
  const ignored = results.filter((r) => r.outcome === "ignored_failed_outcome");
  assert.equal(accepted.length, 5);
  assert.equal(ignored.length, 1);
  assert.equal(svc.getStore().getIndexedRevision(), "5");
});

test("duplicate identical delivery is a no-op", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const stream = loadExecutionStream().filter(
    (r) => r.executionOutcome === "SuccessValue",
  );
  svc.ingestAll(stream);
  const first = stream[0]!;
  const again = svc.ingest(first);
  assert.equal(again[0]?.outcome, "noop_duplicate");
  assert.equal(svc.getStore().getIndexedRevision(), "5");
});

test("conflicting duplicate halts certification", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const first = loadExecutionStream().find(
    (r) => r.executionOutcome === "SuccessValue",
  )!;
  svc.ingest(first);
  const conflict: ExecutionRecord = {
    ...first,
    log: {
      standard: "mpoo_board",
      version: "2.0.0",
      event: "draw",
      data: {
        boardEpoch: "1",
        revision: "1",
        x: 0,
        y: 0,
        color: 7, // different color — conflict
        artist: "alice.testnet",
        writtenAtNs: "1700000001000000001",
        paletteVersion: "palette-v2",
        costToilet: "10",
        pricingVersion: "pressure-v1",
        actionNonce: "1",
      },
    },
  };
  const result = svc.ingest(conflict);
  assert.equal(result[0]?.outcome, "halted");
  assert.equal(svc.coverage().status, "halted");
});

test("revision gap sets gap status and pauses advancement", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const first = loadExecutionStream().find(
    (r) => r.executionOutcome === "SuccessValue",
  )!;
  svc.ingest(first);
  const gapRecord: ExecutionRecord = {
    chain: "testnet",
    boardAccountId: "board.mpoo.testnet",
    blockHash: "9999999999999999999999999999999999999999999999999999999999999999",
    blockHeight: "1099",
    blockTimestampNs: "1700000099000000000",
    receiptId: "gap-receipt",
    executionOutcome: "SuccessValue",
    logIndex: 0,
    log: {
      standard: "mpoo_board",
      version: "2.0.0",
      event: "draw",
      data: {
        boardEpoch: "1",
        revision: "3", // skipped 2
        x: 1,
        y: 1,
        color: 1,
        artist: "gap.testnet",
        writtenAtNs: "1700000099000000001",
        paletteVersion: "palette-v2",
        costToilet: "10",
        pricingVersion: "pressure-v1",
        actionNonce: "1",
      },
    },
  };
  const result = svc.ingest(gapRecord);
  assert.equal(result[0]?.outcome, "gap");
  assert.equal(svc.coverage().status, "gap");
  assert.equal(svc.getStore().getIndexedRevision(), "1");
});

test("same-block multi-draw preserves data_index order", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const batch = loadExecutionStream().find(
    (r) => r.receiptId === "receipt-r2-same-block-batch",
  )!;
  // Need revision 1 first
  const first = loadExecutionStream().find((r) => r.receiptId === "receipt-r1")!;
  svc.ingest(first);
  const results = svc.ingest(batch);
  assert.deepEqual(
    results.map((r) => ("revision" in r ? r.revision : r.outcome)),
    ["2", "3"],
  );
  const page = svc.historyPage({ afterRevision: "1", limit: 10 });
  assert.equal(page.events[0]?.revision, "2");
  assert.equal(page.events[0]?.dataIndex, 0);
  assert.equal(page.events[1]?.revision, "3");
  assert.equal(page.events[1]?.dataIndex, 1);
  assert.equal(page.events[0]?.color, 0); // Ink — real paint, not empty
});

test("empty cell is distinct from Ink (color 0)", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const first = loadExecutionStream().find(
    (r) => r.receiptId === "receipt-r1",
  )!;
  const batch = loadExecutionStream().find(
    (r) => r.receiptId === "receipt-r2-same-block-batch",
  )!;
  svc.ingest(first);
  svc.ingest(batch);
  const pixels = svc.getStore().getCurrentPixels();
  // (1,0) is Ink (color 0) — present
  assert.equal(pixels.get(cellIndex(1, 0, 4))?.color, 0);
  // (0,2) never painted — empty, not Ink
  assert.equal(isEmptyCell(pixels, 0, 2, 4), true);
  assert.equal(pixels.has(cellIndex(0, 2, 4)), false);
});

test("crash between commits resumes from last cursor", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 2 });
  const success = loadExecutionStream().filter(
    (r) => r.executionOutcome === "SuccessValue",
  );
  // Commit through revision 3 (first + batch of 2)
  svc.ingest(success[0]!);
  svc.ingest(success[1]!);
  const snap = svc.serialize();
  assert.equal(snap.cursor.lastCommittedRevision, "3");

  // Simulate crash before revision 4/5
  const resumed = HistoryService.fromSerialized(snap, { checkpointInterval: 2 });
  assert.equal(resumed.getCursor().lastCommittedRevision, "3");
  resumed.ingest(success[2]!); // EVENT_JSON string rev 4
  resumed.ingest(success[3]!); // rev 5 (index after filtering — success[3] is receipt-r5)
  // success array: [r1, batch, r4 string, r5] — failed filtered out
  assert.equal(resumed.getStore().getIndexedRevision(), "5");
  // Replaying already-committed events is noop
  const noop = resumed.ingest(success[0]!);
  assert.equal(noop[0]?.outcome, "noop_duplicate");
});

test("observed height lag yields lagging coverage", () => {
  const svc = new HistoryService(loadBaseline(), {
    checkpointInterval: 100,
    lagHealthyThresholdBlocks: 5,
  });
  svc.ingest(
    loadExecutionStream().find((r) => r.receiptId === "receipt-r1")!,
  );
  svc.setObservedFinalHeight("2000");
  assert.equal(svc.coverage().status, "lagging");
});
