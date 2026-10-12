/**
 * Finalized history, canonical state/snapshot identity, and HTTP shapes.
 * A trusted attester certifies snapshots; a content hash alone is not proof
 * that bytes existed on NEAR.
 */

import type { BoardIdentity } from "./board.ts";
import type { CropRect } from "./bounties.ts";

export type HistoryCoverageStatus =
  | "healthy"
  | "lagging"
  | "gap"
  | "halted";

export interface HistoryCoverage {
  chainId: string;
  boardAccountId: string;
  boardEpoch: string;
  indexedFinalHeight: string;
  indexedRevision: string;
  observedFinalHeight: string;
  coverageStartRevision: string;
  status: HistoryCoverageStatus;
}

export interface PaletteEntryCanonical {
  index: number;
  name: string;
  r: number;
  g: number;
  b: number;
}

export interface CanonicalStateHeader {
  domain: "MPOO_STATE_V1";
  chainGenesisHash: string;
  boardAccountId: string;
  boardEpoch: string;
  width: number;
  height: number;
  paletteVersion: string;
  palette: PaletteEntryCanonical[];
  /** Empty-cell display RGBA frozen in baseline manifest. */
  emptyRgba: [number, number, number, number];
}

export interface CanonicalCellPresent {
  present: true;
  colorIndex: number;
  artist: string;
  writtenAtNs: string;
}

export interface CanonicalCellAbsent {
  present: false;
}

export type CanonicalCell = CanonicalCellPresent | CanonicalCellAbsent;

export interface SnapshotManifest {
  snapshotId: string;
  stateHash: string;
  board: BoardIdentity;
  width: number;
  height: number;
  paletteVersion: string;
  finalizedBlockHash: string;
  finalizedBlockHeight: string;
  finalizedBlockTimestampNs: string;
  revision: string;
  /** Empty string only for baseline/end-of-block legacy snapshots. */
  receiptId: string;
  manifestUri: string;
  manifestHash: string;
  attesterAccountId: string;
  mediaHash: string | null;
}

export interface HistoryEventPage {
  events: BoardHistoryEvent[];
  nextCursor: string | null;
  coverage: HistoryCoverage;
}

export interface BoardHistoryEvent {
  boardEpoch: string;
  revision: string;
  x: number;
  y: number;
  color: number;
  artist: string;
  writtenAtNs: string;
  paletteVersion: string;
  blockHash: string;
  blockHeight: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
}

export interface MomentLookup {
  requestedAtNs: string;
  resolvedRevision: string;
  resolvedTimestampNs: string;
  coverage: HistoryCoverage;
}

export interface PreparePrintRequest {
  snapshotId: string;
  crop: CropRect;
}

export interface PreparePrintResponse {
  printId: string;
  snapshotId: string;
  crop: CropRect;
  attestationStatus: "attested" | "pending" | "unavailable";
  availabilityStatus: "available" | "degraded" | "unavailable";
  publicSeries: SeriesAvailability;
  bountyEntitlement: {
    entitled: boolean;
    entitlementKey: string | null;
  } | null;
  storageEstimateNear: string;
}

export interface SeriesAvailability {
  seriesId: string;
  cap: number;
  issued: number;
  remaining: number;
}
