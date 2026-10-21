import { describe, expect, it, vi } from "vitest";
import { beginBoardLoad, createBoardSyncState, loadPinnedBoard, markBoardLoadApplied, shouldApplyBoardLoad, submitAndResolveDraw } from "./board-sync";

describe("loadPinnedBoard", () => {
  it("pins every get_pixels page in one load to the first block", async () => {
    const getPixels = vi.fn().mockResolvedValueOnce({ pixels: ["a"], nextFromIndex: 1 }).mockResolvedValueOnce({ pixels: ["b"], nextFromIndex: null });
    const snapshot = await loadPinnedBoard({ getBlock: vi.fn().mockResolvedValue({ id: "block-hash-7", height: 7 }), getPixels }, 1);
    expect(snapshot).toEqual({ blockId: "block-hash-7", blockHeight: 7, pixels: ["a", "b"] });
    expect(getPixels.mock.calls.map(([request]) => request.blockId)).toEqual(["block-hash-7", "block-hash-7"]);
  });
  it("rejects a repeated page cursor", async () => {
    await expect(loadPinnedBoard({ getBlock: async () => ({ id: 8, height: 8 }), getPixels: async () => ({ pixels: [], nextFromIndex: 0 }) })).rejects.toThrow(/repeated page cursor/);
  });
});

describe("stale board guard", () => {
  it("rejects a block-height regression even from a newer request", () => {
    const state = createBoardSyncState();
    markBoardLoadApplied(state, beginBoardLoad(state), 20, 0);
    expect(shouldApplyBoardLoad(state, beginBoardLoad(state), 19)).toBe(false);
  });
  it("rejects a late older request", () => {
    const state = createBoardSyncState(); const older = beginBoardLoad(state); const newer = beginBoardLoad(state);
    markBoardLoadApplied(state, newer, 20, 0);
    expect(shouldApplyBoardLoad(state, older, 21)).toBe(false);
  });
});

describe("submitAndResolveDraw", () => {
  const pixel = { owner: "alice", color: 2 };
  function dependencies(overrides: Record<string, unknown> = {}) {
    return { submit: vi.fn().mockResolvedValue("tx-1"), confirm: vi.fn().mockResolvedValue({ status: "succeeded" }), readCurrentPixel: vi.fn().mockResolvedValue(pixel), matchesRequestedPixel: (value: typeof pixel) => value.owner === "alice" && value.color === 2, isOverwritten: (value: typeof pixel) => value.owner !== "alice", ...overrides };
  }
  it("emits submitted and then confirmed", async () => {
    const onOutcome = vi.fn(); const result = await submitAndResolveDraw(dependencies({ onOutcome }));
    expect(onOutcome).toHaveBeenCalledWith({ status: "submitted", transaction: "tx-1" }); expect(result.status).toBe("confirmed");
  });
  it("reports known execution failure distinctly", async () => {
    const result = await submitAndResolveDraw(dependencies({ confirm: vi.fn().mockResolvedValue({ status: "failed", reason: "out of gas" }) }));
    expect(result).toMatchObject({ status: "failed", transaction: "tx-1" });
  });
  it("keeps an unresolved confirmation out of failed", async () => {
    const result = await submitAndResolveDraw(dependencies({ confirm: vi.fn().mockResolvedValue({ status: "unresolved", reason: "RPC lag" }) }));
    expect(result).toMatchObject({ status: "confirmation_delayed", transaction: "tx-1" });
  });
  it("reports a successful transaction later owned by another artist as overwritten", async () => {
    const result = await submitAndResolveDraw(dependencies({ readCurrentPixel: vi.fn().mockResolvedValue({ owner: "bob", color: 5 }) }));
    expect(result).toMatchObject({ status: "overwritten", transaction: "tx-1" });
  });
  it("does not resubmit an uncertain send", async () => {
    const uncertain = new Error("connection dropped after broadcast"); const submit = vi.fn().mockRejectedValue(uncertain);
    const result = await submitAndResolveDraw(dependencies({ submit, isUncertainSubmitError: (error: unknown) => error === uncertain }));
    expect(result.status).toBe("confirmation_delayed"); expect(submit).toHaveBeenCalledTimes(1);
  });
});
