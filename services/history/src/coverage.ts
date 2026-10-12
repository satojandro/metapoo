import type {
  HistoryCoverage,
  HistoryCoverageStatus,
} from "../../../shared/protocol/history.ts";
import type { HistoryServiceConfig } from "./config.ts";
import type { HistoryStore } from "./store.ts";

/**
 * Derive coverage health from store + observed head.
 * Missing data → gap; conflicting duplicate → halted; height lag → lagging.
 */
export function computeCoverageStatus(
  store: HistoryStore,
  config: HistoryServiceConfig,
): HistoryCoverageStatus {
  if (store.getStatus() === "halted") {
    return "halted";
  }
  if (store.getStatus() === "gap") {
    return "gap";
  }
  const indexed = BigInt(store.getIndexedFinalHeight());
  const observed = BigInt(store.getObservedFinalHeight());
  if (observed > indexed) {
    const lag = observed - indexed;
    if (lag > BigInt(config.lagHealthyThresholdBlocks)) {
      return "lagging";
    }
  }
  return "healthy";
}

export function buildCoverage(
  store: HistoryStore,
  config: HistoryServiceConfig,
): HistoryCoverage {
  const status = computeCoverageStatus(store, config);
  // Reflect derived lagging without mutating halted/gap.
  if (status === "lagging" && store.getStatus() === "healthy") {
    // ephemeral for response; do not persist as permanent halt
  }
  return {
    chainId: store.baseline.board.chainId,
    boardAccountId: store.baseline.board.boardAccountId,
    boardEpoch: store.baseline.board.boardEpoch,
    indexedFinalHeight: store.getIndexedFinalHeight(),
    indexedRevision: store.getIndexedRevision(),
    observedFinalHeight: store.getObservedFinalHeight(),
    coverageStartRevision: store.getCoverageStartRevision(),
    status,
  };
}
