/**
 * Meta Poo history service — fixture-first finalized ingest & reconstruction.
 *
 * Live NEAR Lake / archival provider: NOT WIRED.
 * Do not claim live-verified ingest from this package.
 */

export { DEFAULT_HISTORY_CONFIG, type HistoryServiceConfig } from "./config.ts";
export { HistoryService } from "./service.ts";
export { HistoryStore, type HistoryStoreSnapshot } from "./store.ts";
export {
  ingestExecutionRecord,
  ingestStream,
  parseLogPayload,
  type IngestResult,
} from "./ingest.ts";
export { reconstructRevision, pixelMapsEqual } from "./reconstruct.ts";
export {
  encodePixelsAsState,
  encodeSnapshotAtRevision,
  buildSnapshotManifest,
} from "./snapshot.ts";
export {
  getCoverage,
  getHistoryPage,
  getMoment,
  getSnapshotByRevision,
} from "./handlers.ts";
export { buildCoverage, computeCoverageStatus } from "./coverage.ts";
export { isEmptyCell, cellIndex } from "./board-state.ts";
export type {
  BaselineManifest,
  BoardGeometry,
  ExecutionRecord,
  NearEventEnvelope,
  NormalizedDrawEvent,
  StoredHistoryEvent,
  IngestCursor,
  PixelCell,
  PixelMap,
} from "./types.ts";
