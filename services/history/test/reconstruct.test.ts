import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryService } from "../src/service.ts";
import { cellIndex } from "../src/board-state.ts";
import {
  currentPixelsMatchReconstruction,
  reconstructRevision,
} from "../src/reconstruct.ts";
import {
  loadBaseline,
  loadExecutionStream,
  loadOverwriteScenario,
} from "./helpers.ts";

test("overwrite: reconstruct earlier revision restores prior artist/color", () => {
  const { records, expect } = loadOverwriteScenario();
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 1 });
  svc.ingestAll(records);

  const at1 = reconstructRevision(svc.getStore(), "1");
  const cell1 = at1.pixels.get(cellIndex(0, 0, 4))!;
  assert.equal(cell1.color, expect.atRevision1.color);
  assert.equal(cell1.artist, expect.atRevision1.artist);

  const at2 = reconstructRevision(svc.getStore(), "2");
  const cell2 = at2.pixels.get(cellIndex(0, 0, 4))!;
  assert.equal(cell2.color, expect.atRevision2.color);
  assert.equal(cell2.artist, expect.atRevision2.artist);

  // Distinct snapshot identities for overwritten moments
  const s1 = svc.encodeSnapshot("1");
  const s2 = svc.encodeSnapshot("2");
  assert.notEqual(s1.snapshotId, s2.snapshotId);
  assert.notEqual(s1.stateHash, s2.stateHash);
});

test("checkpoint + events rebuild matches live pixels", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 2 });
  svc.ingestAll(loadExecutionStream());
  assert.equal(currentPixelsMatchReconstruction(svc.getStore()), true);
  const cps = svc.getStore().getCheckpoints();
  // baseline 0 + every 2nd revision → 0,2,4
  assert.ok(cps.some((c) => c.revision === "0"));
  assert.ok(cps.some((c) => c.revision === "2"));
  assert.ok(cps.some((c) => c.revision === "4"));
});

test("reconstruct uses nearest checkpoint (eventsApplied count)", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 2 });
  svc.ingestAll(loadExecutionStream());
  const at5 = reconstructRevision(svc.getStore(), "5");
  // nearest checkpoint at or before 5 with interval 2 is 4 → apply 1 event
  assert.equal(at5.checkpointRevision, "4");
  assert.equal(at5.eventsApplied, 1);
});

test("baseline revision 0 is empty board", () => {
  const svc = new HistoryService(loadBaseline(), { checkpointInterval: 100 });
  const at0 = reconstructRevision(svc.getStore(), "0");
  assert.equal(at0.pixels.size, 0);
  assert.equal(at0.eventsApplied, 0);
});
