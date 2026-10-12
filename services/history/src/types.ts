/**
 * Internal types for fixture ingest and materialization.
 * Wire shapes for HTTP live in shared/protocol/history.ts.
 */

import type { PaletteEntryCanonical } from "../../../shared/protocol/history.ts";
import type { BoardIdentity } from "../../../shared/protocol/board.ts";

/** Sparse painted cell; absence means empty (not Ink / palette 0). */
export interface PixelCell {
  color: number;
  artist: string;
  writtenAtNs: string;
}

/** Row-major sparse map: key = y * width + x */
export type PixelMap = Map<number, PixelCell>;

export interface BoardGeometry {
  width: number;
  height: number;
  paletteVersion: string;
  palette: PaletteEntryCanonical[];
  emptyRgba: readonly [number, number, number, number];
  chainGenesisHash: string;
}

export interface BaselineManifest {
  board: BoardIdentity;
  geometry: BoardGeometry;
  /** Baseline is revision 0 end-of-block; receiptId empty. */
  finalizedBlockHash: string;
  finalizedBlockHeight: string;
  finalizedBlockTimestampNs: string;
  /** Optional starting pixels (usually empty). */
  pixels?: Array<{
    x: number;
    y: number;
    color: number;
    artist: string;
    writtenAtNs: string;
  }>;
}

/** Unique ingest identity (spec). */
export interface IngestIdentity {
  chain: string;
  blockHash: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
}

export function ingestKey(id: IngestIdentity): string {
  return [
    id.chain,
    id.blockHash,
    id.receiptId,
    String(id.logIndex),
    String(id.dataIndex),
  ].join("|");
}

/** Normalized draw after envelope parse. */
export interface NormalizedDrawEvent {
  boardEpoch: string;
  revision: string;
  x: number;
  y: number;
  color: number;
  artist: string;
  writtenAtNs: string;
  paletteVersion: string;
  costToilet?: string;
  pricingVersion?: string;
  actionNonce?: string;
}

/** One archived execution log entry (fixture or future Lake adapter). */
export interface ExecutionRecord {
  chain: string;
  boardAccountId: string;
  blockHash: string;
  blockHeight: string;
  blockTimestampNs: string;
  receiptId: string;
  /** Provider execution outcome; only SuccessValue / SuccessReceiptId are indexable. */
  executionOutcome: "SuccessValue" | "SuccessReceiptId" | "Failure" | "Unknown";
  logIndex: number;
  /** Raw log line or already-parsed EVENT_JSON payload. */
  log: string | NearEventEnvelope;
}

export interface NearEventEnvelope {
  standard: string;
  version: string;
  event: string;
  data: NormalizedDrawEvent | NormalizedDrawEvent[];
}

export interface StoredHistoryEvent extends NormalizedDrawEvent {
  blockHash: string;
  blockHeight: string;
  blockTimestampNs: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
  ingestKey: string;
}

export interface CheckpointRecord {
  revision: string;
  /** Sparse pixel list for compact fixture dumps. */
  pixels: Array<{
    x: number;
    y: number;
    color: number;
    artist: string;
    writtenAtNs: string;
  }>;
}

/** Durable ingest cursor — resume after crash from last commit. */
export interface IngestCursor {
  lastCommittedBlockHeight: string;
  lastCommittedRevision: string;
  lastIngestKey: string | null;
}

export type HaltReason =
  | "conflicting_duplicate"
  | "revision_gap"
  | "revision_conflict"
  | "failed_outcome"
  | "wrong_contract"
  | "invalid_event";
