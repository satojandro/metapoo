/** Framework-free board synchronisation primitives. RPC, wallet, and UI stay outside. */

export interface BoardPage<T> { pixels: readonly T[]; nextFromIndex: number | null; }
export interface BoardBlock { id: string | number; height: number; }
export interface PinnedBoardLoadDependencies<T> {
  /** Called once; all page reads below use this exact id. */
  getBlock(): Promise<BoardBlock>;
  getPixels(request: { fromIndex: number; limit: number; blockId: BoardBlock["id"] }): Promise<BoardPage<T>>;
}
export interface PinnedBoardSnapshot<T> { blockId: BoardBlock["id"]; blockHeight: number; pixels: T[]; }

/** Download every page against a single immutable chain block. */
export async function loadPinnedBoard<T>(
  dependencies: PinnedBoardLoadDependencies<T>, pageLimit = 256,
): Promise<PinnedBoardSnapshot<T>> {
  if (!Number.isInteger(pageLimit) || pageLimit <= 0) throw new Error("pageLimit must be a positive integer.");
  const block = await dependencies.getBlock();
  if (!Number.isFinite(block.height)) throw new Error("Pinned board block must include a finite height.");
  const pixels: T[] = [];
  const seenCursors = new Set<number>();
  let fromIndex = 0;
  while (true) {
    if (seenCursors.has(fromIndex)) throw new Error("get_pixels returned a repeated page cursor.");
    seenCursors.add(fromIndex);
    const page = await dependencies.getPixels({ fromIndex, limit: pageLimit, blockId: block.id });
    pixels.push(...page.pixels);
    if (page.nextFromIndex === null) return { blockId: block.id, blockHeight: block.height, pixels };
    if (!Number.isInteger(page.nextFromIndex) || page.nextFromIndex < 0) throw new Error("get_pixels returned an invalid next page cursor.");
    fromIndex = page.nextFromIndex;
  }
}

export interface BoardLoadSnapshot<T> { blockHeight: number; loadId: number; data: T; }
export interface BoardSyncState {
  nextLoadId: number; appliedLoadId: number; appliedBlockHeight: number;
  lastAppliedAtMs: number | null; consecutiveFailures: number;
}
export function createBoardSyncState(): BoardSyncState {
  return { nextLoadId: 0, appliedLoadId: 0, appliedBlockHeight: 0, lastAppliedAtMs: null, consecutiveFailures: 0 };
}
export function beginBoardLoad(state: BoardSyncState): number { return ++state.nextLoadId; }
/** A completed request may not replace either a newer request or a newer block. */
export function shouldApplyBoardLoad(state: BoardSyncState, loadId: number, blockHeight: number): boolean {
  return loadId >= state.appliedLoadId && blockHeight >= state.appliedBlockHeight;
}
export function markBoardLoadApplied(state: BoardSyncState, loadId: number, blockHeight: number, nowMs: number): void {
  if (!shouldApplyBoardLoad(state, loadId, blockHeight)) throw new Error("Cannot apply a stale board load.");
  state.appliedLoadId = loadId;
  state.appliedBlockHeight = blockHeight;
  state.lastAppliedAtMs = nowMs;
  state.consecutiveFailures = 0;
}
export function markBoardLoadFailed(state: BoardSyncState): void { state.consecutiveFailures += 1; }

export type SubmittedDraw<TTransaction> = { status: "submitted"; transaction: TTransaction };
export type ResolvedDraw<TPixel, TTransaction> =
  | { status: "confirmed"; transaction: TTransaction; pixel: TPixel }
  | { status: "failed"; transaction: TTransaction | null; reason: string }
  | { status: "confirmation_delayed"; transaction: TTransaction | null; reason: string; pixel: TPixel | null }
  | { status: "overwritten"; transaction: TTransaction; pixel: TPixel };
export type DrawOutcome<TPixel, TTransaction> = SubmittedDraw<TTransaction> | ResolvedDraw<TPixel, TTransaction>;
export type DrawConfirmation =
  | { status: "succeeded" }
  | { status: "failed"; reason: string }
  | { status: "unresolved"; reason: string };
export interface SubmittedDrawDependencies<TPixel, TTransaction> {
  /** Invoked exactly once. There is deliberately no retry path in this module. */
  submit(): Promise<TTransaction>;
  confirm(transaction: TTransaction): Promise<DrawConfirmation>;
  readCurrentPixel(transaction: TTransaction): Promise<TPixel | null>;
  matchesRequestedPixel(pixel: TPixel): boolean;
  /** True only when this read proves another paint currently owns the cell. */
  isOverwritten(pixel: TPixel): boolean;
  onOutcome?(outcome: DrawOutcome<TPixel, TTransaction>): void;
  isUncertainSubmitError?(error: unknown): boolean;
}

/** Submit once, then classify execution separately from current board ownership. */
export async function submitAndResolveDraw<TPixel, TTransaction>(
  dependencies: SubmittedDrawDependencies<TPixel, TTransaction>,
): Promise<ResolvedDraw<TPixel, TTransaction>> {
  let transaction: TTransaction;
  try { transaction = await dependencies.submit(); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "Draw submission failed.";
    return dependencies.isUncertainSubmitError?.(error)
      ? { status: "confirmation_delayed", transaction: null, reason, pixel: null }
      : { status: "failed", transaction: null, reason };
  }
  dependencies.onOutcome?.({ status: "submitted", transaction });
  let confirmation: DrawConfirmation;
  try { confirmation = await dependencies.confirm(transaction); }
  catch (error) {
    return { status: "confirmation_delayed", transaction, reason: error instanceof Error ? error.message : "Confirmation could not be read.", pixel: null };
  }
  if (confirmation.status === "failed") return { status: "failed", transaction, reason: confirmation.reason };
  if (confirmation.status === "unresolved") return { status: "confirmation_delayed", transaction, reason: confirmation.reason, pixel: null };
  try {
    const pixel = await dependencies.readCurrentPixel(transaction);
    if (pixel !== null && dependencies.matchesRequestedPixel(pixel)) return { status: "confirmed", transaction, pixel };
    if (pixel !== null && dependencies.isOverwritten(pixel)) return { status: "overwritten", transaction, pixel };
    return { status: "confirmation_delayed", transaction, reason: "Transaction succeeded, but the current board read is not conclusive.", pixel };
  } catch (error) {
    return { status: "confirmation_delayed", transaction, reason: error instanceof Error ? error.message : "Current board read failed.", pixel: null };
  }
}

// Existing callers use these small utilities. Polling policy itself remains in UI code.
export function isWriteAtLeastAsNew(candidateNs: string | null, existingNs: string | null): boolean {
  if (candidateNs == null || existingNs == null) return true;
  try { return BigInt(candidateNs) >= BigInt(existingNs); } catch { return true; }
}
export const BOARD_POLL_BASE_MS = 4_000;
export const BOARD_POLL_MAX_MS = 30_000;
export function nextPollDelayMs(consecutiveFailures: number, baseMs = BOARD_POLL_BASE_MS, maxMs = BOARD_POLL_MAX_MS): number {
  return consecutiveFailures <= 0 ? baseMs : Math.min(maxMs, baseMs * 2 ** Math.min(consecutiveFailures, 4));
}
export function formatFreshness(state: BoardSyncState, nowMs: number): string {
  if (state.lastAppliedAtMs === null) return "Board freshness: not loaded yet.";
  const ageSec = Math.max(0, Math.round((nowMs - state.lastAppliedAtMs) / 1000));
  const block = state.appliedBlockHeight > 0 ? ` block ${state.appliedBlockHeight}` : "";
  return ageSec < 2 ? `Board freshness: just updated${block}.` : `Board freshness: updated ${ageSec}s ago${block}.`;
}
export function shouldPollNow(options: { contractConfigured: boolean; documentHidden: boolean; loadInFlight: boolean }): boolean {
  return options.contractConfigured && !options.documentHidden && !options.loadInFlight;
}
