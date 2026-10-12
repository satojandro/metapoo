/**
 * Operational history configuration.
 * Checkpoint interval is not part of canonical identity.
 */

export interface HistoryServiceConfig {
  /** Store a full pixel checkpoint every N successful revisions. Default 1000. */
  checkpointInterval: number;
  /** Max events returned by history page (protocol max 500). */
  maxHistoryPageLimit: number;
  /**
   * If observed_final_height - indexed_final_height exceeds this, status is
   * `lagging` (when otherwise healthy).
   */
  lagHealthyThresholdBlocks: number;
}

export const DEFAULT_HISTORY_CONFIG: HistoryServiceConfig = {
  checkpointInterval: 1000,
  maxHistoryPageLimit: 500,
  lagHealthyThresholdBlocks: 10,
};
