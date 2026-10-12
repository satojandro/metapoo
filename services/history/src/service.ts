/**
 * History service facade for one board.
 * Fixture ingest only — no live NEAR Lake / archival provider.
 */

import {
  DEFAULT_HISTORY_CONFIG,
  type HistoryServiceConfig,
} from "./config.ts";
import {
  getCoverage,
  getHistoryPage,
  getMoment,
  getSnapshotByRevision,
  type SnapshotQueryResult,
} from "./handlers.ts";
import {
  ingestExecutionRecord,
  ingestStream,
  type IngestResult,
} from "./ingest.ts";
import { reconstructRevision } from "./reconstruct.ts";
import {
  buildSnapshotManifest,
  encodeSnapshotAtRevision,
} from "./snapshot.ts";
import { HistoryStore, type HistoryStoreSnapshot } from "./store.ts";
import type { BaselineManifest, ExecutionRecord } from "./types.ts";

export class HistoryService {
  readonly config: HistoryServiceConfig;
  private store: HistoryStore;

  constructor(
    baseline: BaselineManifest,
    config: Partial<HistoryServiceConfig> = {},
  ) {
    this.config = { ...DEFAULT_HISTORY_CONFIG, ...config };
    this.store = new HistoryStore(baseline);
  }

  static fromSerialized(
    snap: HistoryStoreSnapshot,
    config: Partial<HistoryServiceConfig> = {},
  ): HistoryService {
    const svc = new HistoryService(snap.baseline, config);
    svc.store = HistoryStore.restore(snap);
    return svc;
  }

  getStore(): HistoryStore {
    return this.store;
  }

  /** Durable cursor after last successful commit. */
  getCursor() {
    return this.store.getCursor();
  }

  serialize(): HistoryStoreSnapshot {
    return this.store.serialize();
  }

  /** Resume after crash: replace store from last committed snapshot. */
  resumeFrom(snap: HistoryStoreSnapshot): void {
    this.store = HistoryStore.restore(snap);
  }

  ingest(record: ExecutionRecord): IngestResult[] {
    return ingestExecutionRecord(this.store, this.config, record);
  }

  ingestAll(records: readonly ExecutionRecord[]): IngestResult[] {
    return ingestStream(this.store, this.config, records);
  }

  setObservedFinalHeight(height: string): void {
    this.store.setObservedFinalHeight(height);
  }

  coverage() {
    return getCoverage(this.store, this.config);
  }

  historyPage(query: { afterRevision?: string; limit?: number }) {
    return getHistoryPage(this.store, this.config, query);
  }

  moment(atTimeNs: string) {
    return getMoment(this.store, this.config, atTimeNs);
  }

  snapshot(revision: string, opts?: {
    attesterAccountId?: string;
    manifestUri?: string;
  }): SnapshotQueryResult {
    return getSnapshotByRevision(this.store, this.config, revision, opts);
  }

  reconstruct(revision: string) {
    return reconstructRevision(this.store, revision);
  }

  encodeSnapshot(revision: string) {
    return encodeSnapshotAtRevision(this.store, revision);
  }

  buildManifestForWorkerD(
    revision: string,
    opts: { attesterAccountId: string; manifestUri: string },
  ) {
    const coverage = getCoverage(this.store, this.config);
    if (coverage.status === "halted") {
      throw new Error(
        `coverage halted (${this.store.getHaltReason() ?? "unknown"}); refusing manifest certification`,
      );
    }
    return buildSnapshotManifest(this.store, revision, opts);
  }
}
