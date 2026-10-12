/**
 * HTTP-shaped pure handlers matching shared/protocol/history.ts.
 * These are the service contract; a thin HTTP layer can wrap them later.
 */

import type {
  BoardHistoryEvent,
  HistoryCoverage,
  HistoryEventPage,
  MomentLookup,
  SnapshotManifest,
} from "../../../shared/protocol/history.ts";
import type { HistoryServiceConfig } from "./config.ts";
import { buildCoverage } from "./coverage.ts";
import type { HistoryStore } from "./store.ts";
import { buildSnapshotManifest } from "./snapshot.ts";

export type SnapshotQueryResult =
  | { status: "ok"; manifest: SnapshotManifest }
  | { status: "pending"; coverage: HistoryCoverage }
  | { status: "gap"; coverage: HistoryCoverage; reason: string }
  | { status: "halted"; coverage: HistoryCoverage; reason: string };

export function getCoverage(
  store: HistoryStore,
  config: HistoryServiceConfig,
): HistoryCoverage {
  return buildCoverage(store, config);
}

/** True when coverage must not produce new certifiable manifests. */
export function isCertificationBlocked(coverage: HistoryCoverage): boolean {
  return coverage.status === "halted";
}

/**
 * GET /v1/boards/{board}/history?after_revision=&limit=
 */
export function getHistoryPage(
  store: HistoryStore,
  config: HistoryServiceConfig,
  query: { afterRevision?: string; limit?: number },
): HistoryEventPage {
  const after = query.afterRevision ?? "0";
  if (!/^\d+$/.test(after)) {
    throw new RangeError("after_revision must be a decimal string");
  }
  let limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) {
    limit = 1;
  }
  limit = Math.min(limit, config.maxHistoryPageLimit);

  const rows = store.listEventsAfter(after, limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const events: BoardHistoryEvent[] = page.map((e) => ({
    boardEpoch: e.boardEpoch,
    revision: e.revision,
    x: e.x,
    y: e.y,
    color: e.color,
    artist: e.artist,
    writtenAtNs: e.writtenAtNs,
    paletteVersion: e.paletteVersion,
    blockHash: e.blockHash,
    blockHeight: e.blockHeight,
    receiptId: e.receiptId,
    logIndex: e.logIndex,
    dataIndex: e.dataIndex,
  }));

  const nextCursor =
    hasMore && page.length > 0 ? page[page.length - 1]!.revision : null;

  return {
    events,
    nextCursor,
    coverage: buildCoverage(store, config),
  };
}

/**
 * GET /v1/boards/{board}/moments?at_time_ns=
 * Latest covered revision at/before requested time; same-time → highest revision.
 */
export function getMoment(
  store: HistoryStore,
  config: HistoryServiceConfig,
  atTimeNs: string,
): MomentLookup {
  if (!/^\d+$/.test(atTimeNs)) {
    throw new RangeError("at_time_ns must be a decimal string");
  }
  const target = BigInt(atTimeNs);
  const events = store.listEventsThrough(store.getIndexedRevision());
  let resolvedRevision = "0";
  let resolvedTimestampNs = store.baseline.finalizedBlockTimestampNs;

  for (const e of events) {
    const t = BigInt(e.writtenAtNs);
    if (t <= target) {
      // Contiguous ascending revisions: later event wins on equal time too.
      resolvedRevision = e.revision;
      resolvedTimestampNs = e.writtenAtNs;
    }
  }

  return {
    requestedAtNs: atTimeNs,
    resolvedRevision,
    resolvedTimestampNs,
    coverage: buildCoverage(store, config),
  };
}

/**
 * GET /v1/boards/{board}/snapshots/{revision}
 * Immutable manifest or pending/gap — never fabricate current state.
 */
export function getSnapshotByRevision(
  store: HistoryStore,
  config: HistoryServiceConfig,
  revision: string,
  opts?: {
    attesterAccountId?: string;
    manifestUri?: string;
  },
): SnapshotQueryResult {
  if (!/^\d+$/.test(revision)) {
    throw new RangeError("revision must be a decimal string");
  }
  const coverage = buildCoverage(store, config);
  // Disputed / halted coverage must not enter the registration workflow.
  if (isCertificationBlocked(coverage)) {
    return {
      status: "halted",
      coverage,
      reason:
        store.getHaltReason() ??
        "coverage halted; refusing new manifest certification",
    };
  }
  const indexed = BigInt(store.getIndexedRevision());
  const want = BigInt(revision);

  if (want > indexed) {
    return { status: "pending", coverage };
  }
  if (revision !== "0" && !store.getEventByRevision(revision)) {
    return {
      status: "gap",
      coverage,
      reason: `revision ${revision} not in covered event stream`,
    };
  }

  const extended = buildSnapshotManifest(store, revision, {
    attesterAccountId: opts?.attesterAccountId ?? "attester.fixture.testnet",
    manifestUri: opts?.manifestUri ?? "fixture://manifest",
  });
  const {
    stateBytesHex: _s,
    snapshotBytesHex: _b,
    ...manifest
  } = extended;
  return { status: "ok", manifest };
}
