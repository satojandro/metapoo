import { describe, expect, it } from "vitest";
import {
  beginBoardLoad,
  createBoardSyncState,
  formatFreshness,
  isWriteAtLeastAsNew,
  markBoardLoadApplied,
  markBoardLoadFailed,
  nextPollDelayMs,
  shouldApplyBoardLoad,
  shouldPollNow,
  BOARD_POLL_BASE_MS,
} from "./board-sync";

describe("board sync stale guards", () => {
  it("applies the first load", () => {
    const state = createBoardSyncState();
    const loadId = beginBoardLoad(state);
    expect(shouldApplyBoardLoad(state, loadId, 100)).toBe(true);
    markBoardLoadApplied(state, loadId, 100, 1_000);
    expect(state.appliedBlockHeight).toBe(100);
  });

  it("rejects an older block after a newer one applied", () => {
    const state = createBoardSyncState();
    const first = beginBoardLoad(state);
    markBoardLoadApplied(state, first, 200, 1_000);
    const second = beginBoardLoad(state);
    expect(shouldApplyBoardLoad(state, second, 150)).toBe(false);
  });

  it("accepts a newer block even if an older load id finishes late", () => {
    const state = createBoardSyncState();
    const older = beginBoardLoad(state);
    const newer = beginBoardLoad(state);
    markBoardLoadApplied(state, newer, 300, 2_000);
    expect(shouldApplyBoardLoad(state, older, 301)).toBe(true);
  });

  it("rejects a same-block finish from an older load id", () => {
    const state = createBoardSyncState();
    const older = beginBoardLoad(state);
    const newer = beginBoardLoad(state);
    markBoardLoadApplied(state, newer, 300, 2_000);
    expect(shouldApplyBoardLoad(state, older, 300)).toBe(false);
  });

  it("compares write timestamps as bigints", () => {
    expect(isWriteAtLeastAsNew("2000", "1000")).toBe(true);
    expect(isWriteAtLeastAsNew("999", "1000")).toBe(false);
    expect(isWriteAtLeastAsNew("1000", null)).toBe(true);
  });
});

describe("board poll cadence", () => {
  it("uses the base delay when healthy", () => {
    expect(nextPollDelayMs(0)).toBe(BOARD_POLL_BASE_MS);
  });

  it("backs off after failures and caps", () => {
    expect(nextPollDelayMs(1)).toBe(BOARD_POLL_BASE_MS * 2);
    expect(nextPollDelayMs(10)).toBe(30_000);
  });

  it("resets failure count on successful apply", () => {
    const state = createBoardSyncState();
    markBoardLoadFailed(state);
    markBoardLoadFailed(state);
    expect(state.consecutiveFailures).toBe(2);
    markBoardLoadApplied(state, beginBoardLoad(state), 1, 0);
    expect(state.consecutiveFailures).toBe(0);
  });

  it("pauses when the tab is hidden or contract missing", () => {
    expect(
      shouldPollNow({
        contractConfigured: true,
        documentHidden: true,
        loadInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldPollNow({
        contractConfigured: false,
        documentHidden: false,
        loadInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldPollNow({
        contractConfigured: true,
        documentHidden: false,
        loadInFlight: false,
      }),
    ).toBe(true);
  });

  it("formats freshness with block height", () => {
    const state = createBoardSyncState();
    markBoardLoadApplied(state, beginBoardLoad(state), 42, 1_000);
    expect(formatFreshness(state, 1_000)).toMatch(/just updated.*block 42/);
    expect(formatFreshness(state, 6_000)).toMatch(/updated 5s ago/);
  });
});
