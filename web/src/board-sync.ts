/**
 * Shared-board sync helpers: load generations, stale guards, polling cadence.
 *
 * A full board load is pinned to one NEAR block height. An older snapshot must
 * not replace a newer one. Visible-tab polling stays bounded with backoff.
 */

export interface BoardLoadSnapshot<T> {
  /** NEAR block height the pages were read against. */
  blockHeight: number;
  /** Monotonic id assigned when this load started. */
  loadId: number;
  data: T;
}

export interface BoardSyncState {
  /** Next loadId to hand out. */
  nextLoadId: number;
  /** Highest loadId that successfully updated the cache. */
  appliedLoadId: number;
  /** Block height of the applied snapshot (0 = none yet). */
  appliedBlockHeight: number;
  /** Wall-clock ms when the applied snapshot landed. */
  lastAppliedAtMs: number | null;
  /** Consecutive poll failures (for backoff). */
  consecutiveFailures: number;
}

export function createBoardSyncState(): BoardSyncState {
  return {
    nextLoadId: 0,
    appliedLoadId: 0,
    appliedBlockHeight: 0,
    lastAppliedAtMs: null,
    consecutiveFailures: 0,
  };
}

/** Reserve a load id before starting the async fetch. */
export function beginBoardLoad(state: BoardSyncState): number {
  state.nextLoadId += 1;
  return state.nextLoadId;
}

/**
 * Decide whether a finished load may replace the cache.
 * A response is stale if either its request started before the last applied
 * request or its pinned block predates the applied snapshot. Both dimensions
 * must be monotonic: a slow, older-started request must never regain authority
 * merely because its RPC resolved to a later block.
 */
export function shouldApplyBoardLoad(
  state: BoardSyncState,
  loadId: number,
  blockHeight: number,
): boolean {
  if (loadId < state.appliedLoadId) {
    return false;
  }
  if (blockHeight < state.appliedBlockHeight) {
    return false;
  }
  return true;
}

export function markBoardLoadApplied(
  state: BoardSyncState,
  loadId: number,
  blockHeight: number,
  nowMs: number,
): void {
  state.appliedLoadId = Math.max(state.appliedLoadId, loadId);
  state.appliedBlockHeight = blockHeight;
  state.lastAppliedAtMs = nowMs;
  state.consecutiveFailures = 0;
}

export function markBoardLoadFailed(state: BoardSyncState): void {
  state.consecutiveFailures += 1;
}

/** Compare nanosecond write times as digit strings. */
export function isWriteAtLeastAsNew(
  candidateNs: string | null,
  existingNs: string | null,
): boolean {
  if (candidateNs === null || candidateNs === undefined) {
    // Empty / clearing reads are allowed through (caller decides).
    return true;
  }
  if (existingNs === null || existingNs === undefined) {
    return true;
  }
  try {
    return BigInt(candidateNs) >= BigInt(existingNs);
  } catch {
    return true;
  }
}

export const BOARD_POLL_BASE_MS = 4_000;
export const BOARD_POLL_MAX_MS = 30_000;

/** Exponential backoff after failures, capped. */
export function nextPollDelayMs(
  consecutiveFailures: number,
  baseMs = BOARD_POLL_BASE_MS,
  maxMs = BOARD_POLL_MAX_MS,
): number {
  if (consecutiveFailures <= 0) {
    return baseMs;
  }
  const factor = 2 ** Math.min(consecutiveFailures, 4);
  return Math.min(maxMs, baseMs * factor);
}

export function formatFreshness(
  state: BoardSyncState,
  nowMs: number,
): string {
  if (state.lastAppliedAtMs === null) {
    return "Board freshness: not loaded yet.";
  }
  const ageSec = Math.max(0, Math.round((nowMs - state.lastAppliedAtMs) / 1000));
  const block =
    state.appliedBlockHeight > 0
      ? ` block ${state.appliedBlockHeight}`
      : "";
  if (ageSec < 2) {
    return `Board freshness: just updated${block}.`;
  }
  return `Board freshness: updated ${ageSec}s ago${block}.`;
}

/**
 * Whether automatic polling should run.
 * Hidden tabs pause; callers still refresh on becoming visible again.
 */
export function shouldPollNow(options: {
  contractConfigured: boolean;
  documentHidden: boolean;
  loadInFlight: boolean;
}): boolean {
  if (!options.contractConfigured) {
    return false;
  }
  if (options.documentHidden) {
    return false;
  }
  if (options.loadInFlight) {
    return false;
  }
  return true;
}
