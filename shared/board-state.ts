import type { PixelView } from "./types.ts";

/** Pure state used by every client observing the communal board. */
export interface BoardSyncState {
  nextLoadId: number;
  appliedLoadId: number;
  appliedBlockHeight: number;
  lastAppliedAtMs: number | null;
  consecutiveFailures: number;
}

export function createBoardSyncState(): BoardSyncState {
  return { nextLoadId: 0, appliedLoadId: 0, appliedBlockHeight: 0, lastAppliedAtMs: null, consecutiveFailures: 0 };
}

export function beginBoardLoad(state: BoardSyncState): number {
  state.nextLoadId += 1;
  return state.nextLoadId;
}

/** A completed load can only replace a snapshot at an equal or newer block. */
export function shouldApplyBoardLoad(state: BoardSyncState, loadId: number, blockHeight: number): boolean {
  return blockHeight > state.appliedBlockHeight ||
    (blockHeight === state.appliedBlockHeight && loadId >= state.appliedLoadId);
}

export function markBoardLoadApplied(state: BoardSyncState, loadId: number, blockHeight: number, nowMs: number): void {
  state.appliedLoadId = Math.max(state.appliedLoadId, loadId);
  state.appliedBlockHeight = blockHeight;
  state.lastAppliedAtMs = nowMs;
  state.consecutiveFailures = 0;
}

export function markBoardLoadFailed(state: BoardSyncState): void { state.consecutiveFailures += 1; }

export function isWriteAtLeastAsNew(candidateNs: string | null, existingNs: string | null): boolean {
  if (candidateNs === null || existingNs === null) return true;
  try { return BigInt(candidateNs) >= BigInt(existingNs); } catch { return true; }
}

export const BOARD_POLL_BASE_MS = 4_000;
export const BOARD_POLL_MAX_MS = 30_000;

export function nextPollDelayMs(failures: number, baseMs = BOARD_POLL_BASE_MS, maxMs = BOARD_POLL_MAX_MS): number {
  return failures <= 0 ? baseMs : Math.min(maxMs, baseMs * 2 ** Math.min(failures, 4));
}

export function shouldPollNow(options: { contractConfigured: boolean; documentHidden: boolean; loadInFlight: boolean }): boolean {
  return options.contractConfigured && !options.documentHidden && !options.loadInFlight;
}

export function formatFreshness(state: BoardSyncState, nowMs: number): string {
  if (state.lastAppliedAtMs === null) return "Board freshness: not loaded yet.";
  const ageSec = Math.max(0, Math.round((nowMs - state.lastAppliedAtMs) / 1000));
  const block = state.appliedBlockHeight > 0 ? ` block ${state.appliedBlockHeight}` : "";
  return ageSec < 2 ? `Board freshness: just updated${block}.` : `Board freshness: updated ${ageSec}s ago${block}.`;
}

export interface CachedPixel extends PixelView { observedBlockHeight: number; }
export type PixelCache = Map<string, CachedPixel>;
export const cellKey = (x: number, y: number): string => `${x},${y}`;
export const createPixelCache = (): PixelCache => new Map();

/** Does not let a late selected-cell read overwrite fresher cache evidence. */
export function rememberPixelAtBlock(cache: PixelCache, pixel: PixelView, blockHeight: number): boolean {
  const key = cellKey(pixel.x, pixel.y);
  const existing = cache.get(key);
  if (existing && (blockHeight < existing.observedBlockHeight ||
    (blockHeight === existing.observedBlockHeight && !isWriteAtLeastAsNew(pixel.lastWriteTimestampNs, existing.lastWriteTimestampNs)))) return false;
  if (pixel.colorIndex === null) { cache.delete(key); return true; }
  cache.set(key, { ...pixel, observedBlockHeight: blockHeight });
  return true;
}

/** Applies a pinned full snapshot without deleting cell evidence from later blocks. */
export function replaceCacheAtBlock(cache: PixelCache, pixels: readonly PixelView[], blockHeight: number): void {
  const later = [...cache.entries()].filter(([, pixel]) => pixel.observedBlockHeight > blockHeight);
  cache.clear();
  for (const [key, pixel] of later) cache.set(key, pixel);
  for (const pixel of pixels) rememberPixelAtBlock(cache, pixel, blockHeight);
}

export type PlacementState = "submitted" | "confirmed" | "confirmation_delayed" | "failed" | "overwritten";
export type TransactionStatus = "success" | "failed" | "unknown";

export interface PlacementIntent { x: number; y: number; colorIndex: number; accountId: string; }

/**
 * Classify confirmation evidence. A different current owner after an executed
 * transaction is Open-wall overwrite evidence, never transaction failure.
 */
export function reconcilePlacementOutcome(input: {
  transactionStatus: TransactionStatus;
  intent: PlacementIntent;
  observedPixel: PixelView | null;
}): PlacementState {
  if (input.transactionStatus === "failed") return "failed";
  if (input.transactionStatus !== "success") return "confirmation_delayed";
  const pixel = input.observedPixel;
  if (pixel && pixel.x === input.intent.x && pixel.y === input.intent.y && pixel.colorIndex === input.intent.colorIndex && pixel.artistAccountId === input.intent.accountId) return "confirmed";
  if (pixel?.colorIndex !== null && pixel?.artistAccountId !== null && pixel.artistAccountId !== input.intent.accountId) return "overwritten";
  return "confirmation_delayed";
}
