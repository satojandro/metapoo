import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), key: vi.fn(), price: vi.fn(), account: vi.fn() }));
vi.mock("@near-js/accounts", () => ({ Account: class {
  constructor(accountId: string) { mocks.account(accountId); }
  getAccessKey = mocks.key;
  callFunctionRaw = mocks.call;
} }));
vi.mock("@near-js/providers", () => ({ JsonRpcProvider: class { gasPrice = mocks.price; } }));
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
    mocks.call.mockResolvedValueOnce(success).mockRejectedValueOnce(new Error("lost response"));
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ status: "partial", confirmedChunks: 1, totalChunks: 3,
      failingChunk: { index: 1, mayHaveBroadcast: true, message: "lost response" } });
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });
  it("stops on a returned failed or unknown execution", async () => {
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
});
