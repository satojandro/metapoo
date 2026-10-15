import assert from "node:assert/strict";
import { test } from "node:test";
import { beginBoardLoad, createBoardSyncState, reconcilePlacementOutcome, rememberPixelAtBlock, replaceCacheAtBlock, createPixelCache, shouldApplyBoardLoad } from "./board-state.ts";

test("an older pinned board load cannot replace a newer one", () => {
  const state = createBoardSyncState();
  const older = beginBoardLoad(state);
  const newer = beginBoardLoad(state);
  state.appliedLoadId = newer;
  state.appliedBlockHeight = 22;
  assert.equal(shouldApplyBoardLoad(state, older, 21), false);
});

test("a full snapshot preserves later selected-cell evidence", () => {
  const cache = createPixelCache();
  rememberPixelAtBlock(cache, { x: 1, y: 1, colorIndex: 2, artistAccountId: "new.near", lastWriteTimestampNs: "20" }, 20);
  replaceCacheAtBlock(cache, [{ x: 1, y: 1, colorIndex: 1, artistAccountId: "old.near", lastWriteTimestampNs: "10" }], 10);
  assert.equal(cache.get("1,1")?.artistAccountId, "new.near");
});

test("an executed draw subsequently overwritten is not failed", () => {
  assert.equal(reconcilePlacementOutcome({ transactionStatus: "success", intent: { x: 1, y: 2, colorIndex: 3, accountId: "alice.near" }, observedPixel: { x: 1, y: 2, colorIndex: 4, artistAccountId: "bob.near", lastWriteTimestampNs: "2" } }), "overwritten");
});

test("unknown transaction status stays confirmation-delayed", () => {
  assert.equal(reconcilePlacementOutcome({ transactionStatus: "unknown", intent: { x: 1, y: 2, colorIndex: 3, accountId: "alice.near" }, observedPixel: null }), "confirmation_delayed");
});
