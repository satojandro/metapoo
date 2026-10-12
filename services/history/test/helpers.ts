import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BaselineManifest, ExecutionRecord } from "../src/types.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

export function loadBaseline(): BaselineManifest {
  const doc = JSON.parse(
    readFileSync(join(fixturesDir, "baseline-empty-board.json"), "utf8"),
  );
  return doc.baseline as BaselineManifest;
}

export function loadExecutionStream(): ExecutionRecord[] {
  const doc = JSON.parse(
    readFileSync(join(fixturesDir, "execution-stream.json"), "utf8"),
  );
  return doc.records as ExecutionRecord[];
}

export function loadOverwriteScenario(): {
  records: ExecutionRecord[];
  expect: {
    atRevision1: { x: number; y: number; color: number; artist: string };
    atRevision2: { x: number; y: number; color: number; artist: string };
  };
} {
  const doc = JSON.parse(
    readFileSync(join(fixturesDir, "overwrite-scenario.json"), "utf8"),
  );
  return {
    records: doc.records as ExecutionRecord[],
    expect: doc.expect,
  };
}

export { fixturesDir };
