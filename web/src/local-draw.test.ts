import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), key: vi.fn(), price: vi.fn(), account: vi.fn(), block: vi.fn() }));
vi.mock("@near-js/accounts", () => ({ Account: class {
  constructor(accountId: string) { mocks.account(accountId); }
  getAccessKey = mocks.key;
  callFunctionRaw = mocks.call;
} }));
vi.mock("@near-js/providers", () => ({ JsonRpcProvider: class { gasPrice = mocks.price; block = mocks.block; } }));
vi.mock("@near-js/crypto", () => ({ KeyPair: { fromString: vi.fn() } }));
vi.mock("@near-js/signers", () => ({ KeyPairSigner: class {} }));
vi.mock("./drawing-session", () => ({
  loadDrawingSessionRecord: () => ({ publicKey: "public", secretKey: "ed25519:secret" }),
  describeDrawingSession: () => ({ phase: "active" }),
}));
import { signAndSendStrokeLocally } from "./local-draw";
import { DRAW_GAS } from "./config";
const cells = Array.from({ length: 130 }, (_, i) => ({ x: i % 128, y: Math.floor(i / 128) }));
const args = { accountId: "alice.testnet", networkId: "testnet", cells, color: 3 };
const success = { status: { SuccessValue: "" }, transaction: { hash: "tx" } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockResolvedValue({ permission: { FunctionCall: { allowance: "1000000000000000000000000" } } });
  mocks.price.mockResolvedValue({ gas_price: "100000000" });
  mocks.block.mockResolvedValue({ header: { height: 777 } });
  mocks.call.mockReset().mockResolvedValue(success);
});
describe("session stroke submission", () => {
  it("sends ordered bounded chunks with one artist and timestamp assigned by each contract call", async () => {
    const result = await signAndSendStrokeLocally(args);
    expect(result).toMatchObject({ status: "confirmed", confirmedChunks: 3, totalChunks: 3, failingChunk: null });
    expect(mocks.call.mock.calls.map(([call]) => call.args.cells.length)).toEqual([64, 64, 2]);
    expect(mocks.call.mock.calls.flatMap(([call]) => call.args.cells)).toEqual(cells.map(cell => ({ ...cell, color: 3 })));
    for (const [call] of mocks.call.mock.calls) expect(call).toMatchObject({ methodName: "draw_many", gas: DRAW_GAS, deposit: "0" });
    expect(mocks.key).toHaveBeenCalledTimes(3);
    // One signer account per call; no per-cell artist or timestamp overrides.
    // The deployed contract assigns predecessor + block timestamp atomically.
    expect(mocks.account.mock.calls.every(([id]) => id === args.accountId)).toBe(true);
    for (const [call] of mocks.call.mock.calls) {
      expect(Object.keys(call.args)).toEqual(["cells"]);
      for (const cell of call.args.cells) expect(Object.keys(cell).sort()).toEqual(["color", "x", "y"]);
    }
  });
  it("stops at the first lost response without retry or fallback", async () => {
    // "lost response" means the transaction may exist. The allowance moving is
    // the evidence for that: chunk 1 read it before the call and again after
    // the failure, and it dropped, so gas was spent by a real transaction.
    mocks.key
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "1000000000000000000000000" } } })
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "1000000000000000000000000" } } })
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "900000000000000000000000" } } });
    mocks.call.mockResolvedValueOnce(success).mockRejectedValueOnce(new Error("lost response"));
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ status: "partial", confirmedChunks: 1, totalChunks: 3,
      failingChunk: { index: 1, mayHaveBroadcast: true, message: "lost response" } });
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it("does not claim a possible broadcast when the session key never spent gas", async () => {
    // A payload that never left the browser (serialisation, signer, or a
    // rejected RPC call) leaves the allowance byte-identical. Reporting
    // "may have been broadcast" there pinned every cell of the batch as
    // confirmation-delayed forever, on a chain with no such transaction.
    mocks.call.mockRejectedValueOnce(new Error("Expected Array-like not bigint"));
    const result = await signAndSendStrokeLocally(args);
    expect(result).toMatchObject({ status: "partial", confirmedChunks: 0, failingChunk: {
      index: 0, mayHaveBroadcast: false, message: "Expected Array-like not bigint",
    } });
  });
  it("stops on a returned failed or unknown execution", async () => {
    // Executed-but-failed still spends gas, so the allowance moves: uncertain.
    mocks.key
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "1000000000000000000000000" } } })
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "899000000000000000000000" } } });
    mocks.call.mockResolvedValueOnce({ status: { Failure: "failed" } });
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ status: "partial", confirmedChunks: 0, failingChunk: { mayHaveBroadcast: true } });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("refuses a short allowance before broadcasting the next chunk", async () => {
    mocks.key.mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "1" } } });
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ status: "partial", confirmedChunks: 0, failingChunk: {
      index: 0, mayHaveBroadcast: false,
      message: "This drawing session has too little gas allowance for the next batch. Authorize a new session to continue.",
    } });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("rechecks allowance between confirmed chunks", async () => {
    mocks.key.mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "1000000000000000000000000" } } })
      .mockResolvedValueOnce({ permission: { FunctionCall: { allowance: "0" } } });
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ confirmedChunks: 1, failingChunk: { index: 1, mayHaveBroadcast: false } });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it("resolves the executed block for every confirmed chunk", async () => {
    // The receipt is the proof of the write. Resolving its block lets the caller
    // stamp the cells it just painted instead of re-reading the whole board.
    mocks.call.mockResolvedValue({
      status: { SuccessValue: "" },
      transaction: { hash: "tx" },
      transaction_outcome: { block_hash: "BH1" },
    });
    const result = await signAndSendStrokeLocally(args);
    expect(result.executedBlocks).toEqual([
      { chunkIndex: 0, blockHeight: 777 },
      { chunkIndex: 1, blockHeight: 777 },
      { chunkIndex: 2, blockHeight: 777 },
    ]);
    expect(mocks.block).toHaveBeenCalledWith({ blockId: "BH1" });
  });

  it("stays confirmed when the executed block cannot be resolved", async () => {
    // A height lookup is an optimisation, never a condition of success.
    mocks.call.mockResolvedValue({
      status: { SuccessValue: "" },
      transaction: { hash: "tx" },
      transaction_outcome: { block_hash: "BH1" },
    });
    mocks.block.mockRejectedValue(new Error("rpc down"));
    const result = await signAndSendStrokeLocally(args);
    expect(result.status).toBe("confirmed");
    expect(result.confirmedChunks).toBe(3);
    expect(result.executedBlocks).toEqual([]);
  });
});
