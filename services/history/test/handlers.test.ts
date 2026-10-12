import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryService } from "../src/service.ts";
import { loadBaseline, loadExecutionStream } from "./helpers.ts";

test("history page respects limit and nextCursor", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  svc.ingestAll(loadExecutionStream());
  const page = svc.historyPage({ afterRevision: "0", limit: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.nextCursor, "2");
  assert.equal(page.coverage.boardAccountId, "board.mpoo.testnet");
  const page2 = svc.historyPage({ afterRevision: "2", limit: 10 });
  assert.equal(page2.events[0]?.revision, "3");
  assert.equal(page2.nextCursor, null);
});

test("moments resolve same-time writes to highest revision", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  // Craft two events with identical writtenAtNs
  const baseline = loadBaseline();
  const local = new HistoryService(baseline, { checkpointInterval: 100 });
  local.ingest({
    chain: "testnet",
    boardAccountId: "board.mpoo.testnet",
    blockHash: "1111111111111111111111111111111111111111111111111111111111111111",
    blockHeight: "1001",
    blockTimestampNs: "1700000001000000000",
    receiptId: "m1",
    executionOutcome: "SuccessValue",
    logIndex: 0,
    log: {
      standard: "mpoo_board",
      version: "2.0.0",
      event: "draw",
      data: {
        boardEpoch: "1",
        revision: "1",
        x: 0,
        y: 0,
        color: 1,
        artist: "a.testnet",
        writtenAtNs: "5000",
        paletteVersion: "palette-v2",
        costToilet: "1",
        pricingVersion: "pressure-v1",
        actionNonce: "1",
      },
    },
  });
  local.ingest({
    chain: "testnet",
    boardAccountId: "board.mpoo.testnet",
    blockHash: "2222222222222222222222222222222222222222222222222222222222222222",
    blockHeight: "1002",
    blockTimestampNs: "1700000002000000000",
    receiptId: "m2",
    executionOutcome: "SuccessValue",
    logIndex: 0,
    log: {
      standard: "mpoo_board",
      version: "2.0.0",
      event: "draw",
      data: {
        boardEpoch: "1",
        revision: "2",
        x: 1,
        y: 0,
        color: 2,
        artist: "b.testnet",
        writtenAtNs: "5000",
        paletteVersion: "palette-v2",
        costToilet: "1",
        pricingVersion: "pressure-v1",
        actionNonce: "1",
      },
    },
  });
  const moment = local.moment("5000");
  assert.equal(moment.resolvedRevision, "2");
  assert.equal(moment.resolvedTimestampNs, "5000");
});

test("snapshot by revision returns ok for covered and pending beyond tip", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  svc.ingestAll(loadExecutionStream());
  const ok = svc.snapshot("3");
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.equal(ok.manifest.revision, "3");
    assert.match(ok.manifest.snapshotId, /^[0-9a-f]{64}$/);
    assert.match(ok.manifest.stateHash, /^[0-9a-f]{64}$/);
    assert.equal(ok.manifest.receiptId, "receipt-r2-same-block-batch");
  }
  const pending = svc.snapshot("99");
  assert.equal(pending.status, "pending");
});

test("baseline snapshot has empty receiptId", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const ok = svc.snapshot("0");
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.equal(ok.manifest.receiptId, "");
    assert.equal(ok.manifest.revision, "0");
  }
});

test("halted coverage blocks snapshot certification and direct manifest builder", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const stream = loadExecutionStream();
  const first = stream.find((r) => r.executionOutcome === "SuccessValue")!;
  svc.ingest(first);
  assert.equal(svc.snapshot("1").status, "ok");

  // Conflicting duplicate for the same ingest identity → halted.
  const conflict = {
    ...first,
    log: {
      ...first.log,
      data: {
        ...first.log.data,
        color: (first.log.data.color + 1) % 16,
      },
    },
  };
  const halt = svc.ingest(conflict);
  assert.equal(halt[0]?.outcome, "halted");
  assert.equal(svc.coverage().status, "halted");

  const blocked = svc.snapshot("1");
  assert.equal(blocked.status, "halted");
  if (blocked.status === "halted") {
    assert.equal(blocked.coverage.status, "halted");
    assert.equal(blocked.reason, "conflicting_duplicate");
  }

  assert.throws(
    () =>
      svc.buildManifestForWorkerD("1", {
        attesterAccountId: "attester.fixture.testnet",
        manifestUri: "fixture://blocked",
      }),
    /halted/,
  );
});
