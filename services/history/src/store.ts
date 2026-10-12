/**
 * In-memory history store (fixture-first).
 * PostgreSQL migrations are deferred; crash/resume is simulated via serialize/restore.
 */

import type { HistoryCoverageStatus } from "../../../shared/protocol/history.ts";
import {
  applyDraw,
  clonePixelMap,
  emptyPixelMap,
  pixelsToSparseList,
  sparseListToPixels,
} from "./board-state.ts";
import type {
  BaselineManifest,
  CheckpointRecord,
  HaltReason,
  IngestCursor,
  IngestIdentity,
  PixelMap,
  StoredHistoryEvent,
} from "./types.ts";
import { ingestKey } from "./types.ts";

export interface HistoryStoreSnapshot {
  baseline: BaselineManifest;
  events: StoredHistoryEvent[];
  ingestKeys: Record<string, string>;
  pixels: Array<{
    x: number;
    y: number;
    color: number;
    artist: string;
    writtenAtNs: string;
  }>;
  checkpoints: CheckpointRecord[];
  cursor: IngestCursor;
  indexedFinalHeight: string;
  observedFinalHeight: string;
  status: HistoryCoverageStatus;
  haltReason: HaltReason | null;
}

export class HistoryStore {
  readonly baseline: BaselineManifest;
  /** revision decimal string → event */
  private readonly eventsByRevision = new Map<string, StoredHistoryEvent>();
  /** ingest identity → revision (for duplicate detection) */
  private readonly ingestKeys = new Map<string, string>();
  private pixels: PixelMap;
  private readonly checkpoints: CheckpointRecord[] = [];
  private cursor: IngestCursor;
  private indexedFinalHeight: string;
  private observedFinalHeight: string;
  private status: HistoryCoverageStatus = "healthy";
  private haltReason: HaltReason | null = null;

  constructor(baseline: BaselineManifest) {
    this.baseline = baseline;
    this.pixels = emptyPixelMap();
    if (baseline.pixels) {
      this.pixels = sparseListToPixels(
        baseline.pixels,
        baseline.geometry.width,
      );
    }
    this.indexedFinalHeight = baseline.finalizedBlockHeight;
    this.observedFinalHeight = baseline.finalizedBlockHeight;
    this.cursor = {
      lastCommittedBlockHeight: baseline.finalizedBlockHeight,
      lastCommittedRevision: "0",
      lastIngestKey: null,
    };
    // Baseline checkpoint at revision 0.
    this.checkpoints.push({
      revision: "0",
      pixels: pixelsToSparseList(this.pixels, baseline.geometry.width),
    });
  }

  get width(): number {
    return this.baseline.geometry.width;
  }

  get height(): number {
    return this.baseline.geometry.height;
  }

  getCoverageStartRevision(): string {
    return "0";
  }

  getIndexedRevision(): string {
    return this.cursor.lastCommittedRevision;
  }

  getCursor(): IngestCursor {
    return { ...this.cursor };
  }

  getStatus(): HistoryCoverageStatus {
    return this.status;
  }

  getHaltReason(): HaltReason | null {
    return this.haltReason;
  }

  getIndexedFinalHeight(): string {
    return this.indexedFinalHeight;
  }

  getObservedFinalHeight(): string {
    return this.observedFinalHeight;
  }

  setObservedFinalHeight(height: string): void {
    this.observedFinalHeight = height;
  }

  setStatus(status: HistoryCoverageStatus, reason?: HaltReason): void {
    this.status = status;
    if (status === "halted" && reason) {
      this.haltReason = reason;
    }
  }

  isHalted(): boolean {
    return this.status === "halted";
  }

  hasIngestKey(id: IngestIdentity): boolean {
    return this.ingestKeys.has(ingestKey(id));
  }

  getRevisionForIngestKey(id: IngestIdentity): string | undefined {
    return this.ingestKeys.get(ingestKey(id));
  }

  getEventByRevision(revision: string): StoredHistoryEvent | undefined {
    return this.eventsByRevision.get(revision);
  }

  listEventsAfter(afterRevision: string, limit: number): StoredHistoryEvent[] {
    const after = BigInt(afterRevision);
    const all = [...this.eventsByRevision.values()].sort((a, b) =>
      bigintCmp(a.revision, b.revision),
    );
    const filtered = all.filter((e) => BigInt(e.revision) > after);
    return filtered.slice(0, limit);
  }

  listEventsThrough(toRevision: string): StoredHistoryEvent[] {
    const to = BigInt(toRevision);
    return [...this.eventsByRevision.values()]
      .filter((e) => BigInt(e.revision) <= to)
      .sort((a, b) => bigintCmp(a.revision, b.revision));
  }

  getCurrentPixels(): PixelMap {
    return clonePixelMap(this.pixels);
  }

  getCheckpoints(): readonly CheckpointRecord[] {
    return this.checkpoints;
  }

  /** Nearest checkpoint at or before revision R. */
  nearestCheckpointAtOrBefore(revision: string): CheckpointRecord {
    const target = BigInt(revision);
    let best = this.checkpoints[0]!;
    for (const cp of this.checkpoints) {
      if (BigInt(cp.revision) <= target && BigInt(cp.revision) >= BigInt(best.revision)) {
        best = cp;
      }
    }
    return best;
  }

  /**
   * Atomically commit one accepted event (events + pixels + cursor).
   * Caller must already validate contiguity / duplicates.
   */
  commitEvent(
    event: StoredHistoryEvent,
    checkpointInterval: number,
  ): void {
    if (this.isHalted()) {
      throw new Error("store is halted; refusing commit");
    }
    const key = event.ingestKey;
    this.ingestKeys.set(key, event.revision);
    this.eventsByRevision.set(event.revision, event);
    applyDraw(
      this.pixels,
      this.width,
      this.height,
      event.x,
      event.y,
      event.color,
      event.artist,
      event.writtenAtNs,
    );
    this.cursor = {
      lastCommittedBlockHeight: event.blockHeight,
      lastCommittedRevision: event.revision,
      lastIngestKey: key,
    };
    this.indexedFinalHeight = event.blockHeight;

    const rev = BigInt(event.revision);
    if (checkpointInterval > 0 && rev % BigInt(checkpointInterval) === 0n) {
      this.checkpoints.push({
        revision: event.revision,
        pixels: pixelsToSparseList(this.pixels, this.width),
      });
    }
  }

  /** Serialize for crash/resume tests (stand-in for DB transaction). */
  serialize(): HistoryStoreSnapshot {
    return {
      baseline: this.baseline,
      events: [...this.eventsByRevision.values()].sort((a, b) =>
        bigintCmp(a.revision, b.revision),
      ),
      ingestKeys: Object.fromEntries(this.ingestKeys),
      pixels: pixelsToSparseList(this.pixels, this.width),
      checkpoints: this.checkpoints.map((c) => ({
        revision: c.revision,
        pixels: c.pixels.map((p) => ({ ...p })),
      })),
      cursor: { ...this.cursor },
      indexedFinalHeight: this.indexedFinalHeight,
      observedFinalHeight: this.observedFinalHeight,
      status: this.status,
      haltReason: this.haltReason,
    };
  }

  static restore(snap: HistoryStoreSnapshot): HistoryStore {
    const store = new HistoryStore(snap.baseline);
    store.eventsByRevision.clear();
    for (const e of snap.events) {
      store.eventsByRevision.set(e.revision, e);
    }
    store.ingestKeys.clear();
    for (const [k, v] of Object.entries(snap.ingestKeys)) {
      store.ingestKeys.set(k, v);
    }
    store.pixels = sparseListToPixels(snap.pixels, snap.baseline.geometry.width);
    store.checkpoints.length = 0;
    for (const c of snap.checkpoints) {
      store.checkpoints.push({
        revision: c.revision,
        pixels: c.pixels.map((p) => ({ ...p })),
      });
    }
    store.cursor = { ...snap.cursor };
    store.indexedFinalHeight = snap.indexedFinalHeight;
    store.observedFinalHeight = snap.observedFinalHeight;
    store.status = snap.status;
    store.haltReason = snap.haltReason;
    return store;
  }
}

function bigintCmp(a: string, b: string): number {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
