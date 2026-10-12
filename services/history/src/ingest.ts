/**
 * Ordered ingestion worker logic (one board).
 * Live NEAR Lake adapter is NOT wired — feed ExecutionRecord fixtures only.
 */

import type { HistoryServiceConfig } from "./config.ts";
import { HistoryStore } from "./store.ts";
import type {
  ExecutionRecord,
  NearEventEnvelope,
  NormalizedDrawEvent,
  StoredHistoryEvent,
} from "./types.ts";
import { ingestKey } from "./types.ts";

export type IngestResult =
  | { outcome: "accepted"; revision: string }
  | { outcome: "noop_duplicate"; revision: string }
  | { outcome: "ignored_failed_outcome" }
  | { outcome: "ignored_wrong_contract" }
  | { outcome: "halted"; reason: string }
  | { outcome: "gap"; reason: string };

const EVENT_JSON_PREFIX = "EVENT_JSON:";

export function parseLogPayload(
  log: string | NearEventEnvelope,
): NearEventEnvelope | null {
  if (typeof log !== "string") {
    return log;
  }
  const trimmed = log.trim();
  const jsonPart = trimmed.startsWith(EVENT_JSON_PREFIX)
    ? trimmed.slice(EVENT_JSON_PREFIX.length)
    : trimmed;
  try {
    return JSON.parse(jsonPart) as NearEventEnvelope;
  } catch {
    return null;
  }
}

function eventsFromEnvelope(envelope: NearEventEnvelope): NormalizedDrawEvent[] {
  if (!Array.isArray(envelope.data)) {
    return [envelope.data];
  }
  return envelope.data;
}

function eventsEqual(a: StoredHistoryEvent, b: NormalizedDrawEvent & {
  blockHash: string;
  blockHeight: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
}): boolean {
  return (
    a.boardEpoch === b.boardEpoch &&
    a.revision === b.revision &&
    a.x === b.x &&
    a.y === b.y &&
    a.color === b.color &&
    a.artist === b.artist &&
    a.writtenAtNs === b.writtenAtNs &&
    a.paletteVersion === b.paletteVersion &&
    a.blockHash === b.blockHash &&
    a.blockHeight === b.blockHeight &&
    a.receiptId === b.receiptId &&
    a.logIndex === b.logIndex &&
    a.dataIndex === b.dataIndex
  );
}

/**
 * Ingest one execution record. May contain one EVENT_JSON with multiple data
 * entries (batch); each data_index is a separate ingest identity.
 */
export function ingestExecutionRecord(
  store: HistoryStore,
  config: HistoryServiceConfig,
  record: ExecutionRecord,
): IngestResult[] {
  if (store.isHalted()) {
    return [{ outcome: "halted", reason: store.getHaltReason() ?? "halted" }];
  }

  if (
    record.executionOutcome !== "SuccessValue" &&
    record.executionOutcome !== "SuccessReceiptId"
  ) {
    // Failed receipts are never indexable writes.
    return [{ outcome: "ignored_failed_outcome" }];
  }

  if (record.boardAccountId !== store.baseline.board.boardAccountId) {
    return [{ outcome: "ignored_wrong_contract" }];
  }

  if (record.chain !== store.baseline.board.chainId) {
    store.setStatus("halted", "invalid_event");
    return [{ outcome: "halted", reason: "chain_mismatch" }];
  }

  const envelope = parseLogPayload(record.log);
  if (
    !envelope ||
    envelope.standard !== "mpoo_board" ||
    envelope.version !== "2.0.0" ||
    envelope.event !== "draw"
  ) {
    return [{ outcome: "ignored_wrong_contract" }];
  }

  const draws = eventsFromEnvelope(envelope);
  const results: IngestResult[] = [];

  for (let dataIndex = 0; dataIndex < draws.length; dataIndex += 1) {
    const draw = draws[dataIndex]!;
    const result = ingestOneDraw(store, config, record, draw, dataIndex);
    results.push(result);
    if (result.outcome === "halted" || result.outcome === "gap") {
      break;
    }
  }

  return results;
}

function ingestOneDraw(
  store: HistoryStore,
  config: HistoryServiceConfig,
  record: ExecutionRecord,
  draw: NormalizedDrawEvent,
  dataIndex: number,
): IngestResult {
  if (store.isHalted()) {
    return { outcome: "halted", reason: store.getHaltReason() ?? "halted" };
  }

  if (draw.boardEpoch !== store.baseline.board.boardEpoch) {
    store.setStatus("halted", "invalid_event");
    return { outcome: "halted", reason: "board_epoch_mismatch" };
  }

  if (!/^\d+$/.test(draw.revision)) {
    store.setStatus("halted", "invalid_event");
    return { outcome: "halted", reason: "revision_not_decimal" };
  }

  const identity = {
    chain: record.chain,
    blockHash: record.blockHash,
    receiptId: record.receiptId,
    logIndex: record.logIndex,
    dataIndex,
  };
  const key = ingestKey(identity);

  const candidate = {
    ...draw,
    blockHash: record.blockHash,
    blockHeight: record.blockHeight,
    blockTimestampNs: record.blockTimestampNs,
    receiptId: record.receiptId,
    logIndex: record.logIndex,
    dataIndex,
    ingestKey: key,
  } satisfies StoredHistoryEvent;

  // Duplicate ingest identity
  if (store.hasIngestKey(identity)) {
    const existingRev = store.getRevisionForIngestKey(identity)!;
    const existing = store.getEventByRevision(existingRev);
    if (existing && eventsEqual(existing, candidate)) {
      return { outcome: "noop_duplicate", revision: existingRev };
    }
    store.setStatus("halted", "conflicting_duplicate");
    return { outcome: "halted", reason: "conflicting_duplicate" };
  }

  // Same revision already stored under a different ingest key?
  const priorSameRev = store.getEventByRevision(draw.revision);
  if (priorSameRev) {
    if (eventsEqual(priorSameRev, candidate)) {
      // Identical content, different ingest path — treat as conflicting identity
      // only if keys differ; content match with new key is still a conflict on uniqueness.
      store.setStatus("halted", "conflicting_duplicate");
      return { outcome: "halted", reason: "conflicting_duplicate" };
    }
    store.setStatus("halted", "revision_conflict");
    return { outcome: "halted", reason: "revision_conflict" };
  }

  // Contiguity: next revision must be last+1
  const expected = BigInt(store.getIndexedRevision()) + 1n;
  const got = BigInt(draw.revision);
  if (got < expected) {
    // Out-of-order older revision without matching ingest key → conflict/halt
    store.setStatus("halted", "revision_conflict");
    return { outcome: "halted", reason: "revision_not_contiguous" };
  }
  if (got > expected) {
    store.setStatus("gap", "revision_gap");
    return {
      outcome: "gap",
      reason: `expected revision ${expected}, got ${draw.revision}`,
    };
  }

  // Bounds / palette sanity (halt on invalid)
  if (
    draw.x < 0 ||
    draw.y < 0 ||
    draw.x >= store.width ||
    draw.y >= store.height
  ) {
    store.setStatus("halted", "invalid_event");
    return { outcome: "halted", reason: "coordinate_oob" };
  }

  store.commitEvent(candidate, config.checkpointInterval);
  // Advance observed height at least to this block when ingesting fixtures.
  if (BigInt(record.blockHeight) > BigInt(store.getObservedFinalHeight())) {
    store.setObservedFinalHeight(record.blockHeight);
  }

  return { outcome: "accepted", revision: draw.revision };
}

/** Ingest a contiguous stream; stops on gap/halt. */
export function ingestStream(
  store: HistoryStore,
  config: HistoryServiceConfig,
  records: readonly ExecutionRecord[],
): IngestResult[] {
  const all: IngestResult[] = [];
  for (const record of records) {
    const batch = ingestExecutionRecord(store, config, record);
    all.push(...batch);
    const last = batch[batch.length - 1];
    if (last && (last.outcome === "halted" || last.outcome === "gap")) {
      break;
    }
  }
  return all;
}
