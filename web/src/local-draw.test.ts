import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseEncode } from "@near-js/utils";
const mocks = vi.hoisted(() => ({
  call: vi.fn(), key: vi.fn(), price: vi.fn(), account: vi.fn(), block: vi.fn(),
  viewBlock: vi.fn(), send: vi.fn(), status: vi.fn(), sign: vi.fn(),
}));
vi.mock("@near-js/accounts", () => ({ Account: class {
  constructor(accountId: string) { mocks.account(accountId); }
  callFunctionRaw = mocks.call;
} }));
vi.mock("@near-js/providers", () => ({ JsonRpcProvider: class {
  gasPrice = mocks.price;
  block = mocks.block;
  async viewBlock(query: unknown) { return mocks.viewBlock(query); }
  sendTransactionUntil = mocks.send;
  txStatus = mocks.status;
} }));
vi.mock("@near-js/crypto", () => ({ KeyPair: { fromString: vi.fn() } }));
vi.mock("@near-js/transactions", () => ({
  createTransaction: (signerId: string, publicKey: string, receiverId: string, nonce: bigint, actions: unknown[], blockHash: Uint8Array) =>
    ({ signerId, publicKey, receiverId, nonce, actions, blockHash }),
  actionCreators: {
    functionCall: (methodName: string, args: unknown, gas: bigint, deposit: bigint) => ({ methodName, args, gas, deposit }),
  },
}));
// Pre-send reads go through the shared read transport, not the signer's provider.
vi.mock("./read-rpc", () => ({ readRpcFetch: async (_url: string, init: RequestInit) => {
  const { method } = JSON.parse(String(init.body)) as { method: string };
  const result = method === "gas_price" ? await mocks.price() : await mocks.key();
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "t", result }));
} }));
vi.mock("@near-js/signers", () => ({ KeyPairSigner: class {
  async getPublicKey() { return "ed25519:public"; }
  signTransaction = mocks.sign;
} }));
vi.mock("./drawing-session", async (importOriginal) => ({
  isDrawingKeyLow: (await importOriginal<typeof import("./drawing-session")>()).isDrawingKeyLow,
  loadDrawingSessionRecord: () => ({ publicKey: "public", secretKey: "ed25519:secret" }),
  describeDrawingSession: () => ({ phase: "active" }),
}));
import { fetchDrawingSessionAllowance, signAndSendStrokeLocally } from "./local-draw";
import { DRAW_GAS } from "./config";

type SentTx = { tx: { nonce: bigint; actions: Array<{ methodName: string; args: { cells: unknown[]; max_credits?: number }; gas: bigint; deposit: bigint }> } };
const cells = Array.from({ length: 130 }, (_, i) => ({ x: i % 128, y: Math.floor(i / 128) }));
const timing = { pollMs: 1, deadlineMs: 200 };
const args = { accountId: "alice.testnet", networkId: "testnet", cells, color: 3, timing };
const FULL = "1000000000000000000000000";
const key = (nonce: number, allowance: string | null = FULL) =>
  ({ nonce, permission: { FunctionCall: { allowance } } });
/** The hash the mocked signer gives a transaction: its nonce as one byte. */
const hashOf = (nonce: number) => baseEncode(new Uint8Array([nonce]));
const ok = (blockHash = "BH") => ({ status: { SuccessValue: "" }, transaction: { hash: "h" }, transaction_outcome: { block_hash: blockHash } });
const failed = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "PriceRoseAboveMax" } } } } }, transaction: { hash: "h" } };
const typed = (type: string, message = type) => Object.assign(new Error(message), { type });
const sentNonces = () => mocks.send.mock.calls.map(([signed]) => Number((signed as SentTx).tx.nonce));
const sentModes = () => mocks.send.mock.calls.map(([, mode]) => mode);
const sentArgs = () => mocks.send.mock.calls.map(([signed]) => (signed as SentTx).tx.actions[0]!);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockReset().mockResolvedValue(key(10));
  mocks.price.mockReset().mockResolvedValue({ gas_price: "100000000" });
  mocks.block.mockReset().mockResolvedValue({ header: { height: 777 } });
  mocks.viewBlock.mockReset().mockResolvedValue({ header: { hash: "11111111111111111111111111111111", height: 700 } });
  mocks.sign.mockReset().mockImplementation(async (tx: { nonce: bigint }) => [new Uint8Array([Number(tx.nonce)]), { tx }]);
  mocks.send.mockReset().mockImplementation(async (_signed: unknown, mode: string) =>
    mode === "NONE" ? { final_execution_status: "NONE" } : ok());
  mocks.status.mockReset().mockResolvedValue(ok());
  mocks.call.mockReset();
});

describe("pipelined stroke submission", () => {
  it("signs every batch with consecutive nonces and sends them in order", async () => {
    const result = await signAndSendStrokeLocally(args);
    expect(result).toMatchObject({ status: "confirmed", confirmedChunks: 3, totalChunks: 3, failingChunk: null });
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(sentNonces()).toEqual([11, 12, 13]);
    // Earlier batches only wait for the node's acknowledgement; the last one's
    // send waits for execution itself.
    expect(sentModes()).toEqual(["NONE", "NONE", "EXECUTED_OPTIMISTIC"]);
    expect(mocks.status.mock.calls.map(([hash]) => hash)).toEqual([hashOf(11), hashOf(12)]);
    expect(result.chunks.map((c) => c.transactionHash)).toEqual([hashOf(11), hashOf(12), hashOf(13)]);
    expect(sentArgs().map((a) => a.args.cells.length)).toEqual([64, 64, 2]);
    expect(sentArgs().flatMap((a) => a.args.cells)).toEqual(cells.map((cell) => ({ ...cell, color: 3 })));
    for (const action of sentArgs()) {
      expect(action).toMatchObject({ methodName: "draw_many", gas: BigInt(DRAW_GAS), deposit: 0n });
      // No per-cell artist or timestamp: the contract assigns predecessor + block time.
      expect(Object.keys(action.args)).toEqual(["cells"]);
    }
  });

  it("reads the key, the block and the gas price once per stroke", async () => {
    await signAndSendStrokeLocally(args);
    expect(mocks.key).toHaveBeenCalledTimes(1);
    expect(mocks.viewBlock).toHaveBeenCalledTimes(1);
    expect(mocks.price).toHaveBeenCalledTimes(1);
    // The #77 guarantee, still pinned: signatures are anchored to a finalized block.
    // near-api-js's own default is "optimistic", and a node that has not stored that
    // block rejects the send after signing (UNKNOWN_BLOCK, see traps.md).
    expect(mocks.viewBlock).toHaveBeenCalledWith({ finality: "final" });
  });

  it("a lone tap costs one parallel read set and one send, and nothing else on its path", async () => {
    // The property this path exists for. Count requests, not milliseconds:
    // timing drifts with the network, a new serial read is a regression.
    const lone = { ...args, cells: [{ x: 4, y: 5 }], deferBlockHeights: true };
    let releaseHeight!: (block: unknown) => void;
    mocks.block.mockReturnValueOnce(new Promise((resolve) => { releaseHeight = resolve; }));
    const result = await signAndSendStrokeLocally(lone);
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed"]);
    expect(mocks.key).toHaveBeenCalledTimes(1);
    expect(mocks.viewBlock).toHaveBeenCalledTimes(1);
    expect(mocks.price).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(sentModes()).toEqual(["EXECUTED_OPTIMISTIC"]);
    expect(mocks.status).not.toHaveBeenCalled();
    // Returned on the receipt: the height lookup is still open and nothing waited for it.
    expect(result.executedBlocks).toEqual([]);
    releaseHeight({ header: { height: 901 } });
    expect(await result.executedBlocksLater).toEqual([{ chunkIndex: 0, blockHeight: 901 }]);
  });

  it("uses reads started earlier instead of reading again", async () => {
    const { prefetchSigningContext } = await import("./local-draw");
    const prepared = prefetchSigningContext(args);
    await prepared;
    mocks.key.mockClear(); mocks.viewBlock.mockClear(); mocks.price.mockClear();
    const result = await signAndSendStrokeLocally({ ...args, cells: [{ x: 1, y: 1 }], prepared });
    expect(result.status).toBe("confirmed");
    expect(mocks.key).not.toHaveBeenCalled();
    expect(mocks.viewBlock).not.toHaveBeenCalled();
    expect(mocks.price).not.toHaveBeenCalled();
    expect(sentNonces()).toEqual([11]);
  });

  it("an unused prefetch that fails is not an unhandled rejection", async () => {
    const { prefetchSigningContext } = await import("./local-draw");
    mocks.key.mockRejectedValueOnce(new Error("busy"));
    prefetchSigningContext(args);
    // Let the rejection settle; vitest fails the run on an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("reports a failed prefetch as a batch that was not sent", async () => {
    const { prefetchSigningContext } = await import("./local-draw");
    mocks.viewBlock.mockRejectedValueOnce(new Error("block read down"));
    const result = await signAndSendStrokeLocally({ ...args, prepared: prefetchSigningContext(args) });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.failingChunk).toEqual({ index: 0, mayHaveBroadcast: false, message: "block read down" });
  });

  it("sends every batch before waiting for any result", async () => {
    let release!: (outcome: unknown) => void;
    mocks.status.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = signAndSendStrokeLocally(args);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3));
    release(ok());
    expect((await pending).status).toBe("confirmed");
  });

  it("sends each chunk's quoted max_credits on a paid board", async () => {
    await signAndSendStrokeLocally({ ...args, maxCredits: [64, 70, 2] });
    expect(sentArgs().map((a) => a.args.max_credits)).toEqual([64, 70, 2]);
    expect(Object.keys(sentArgs()[0]!.args)).toEqual(["cells", "max_credits"]);
  });

  it("reports a batch that fails in the middle without hiding the ones after it", async () => {
    mocks.status.mockResolvedValueOnce(ok()).mockResolvedValueOnce(failed);
    const result = await signAndSendStrokeLocally(args);
    expect(result.status).toBe("partial");
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "failed", "confirmed"]);
    expect(result.chunks[1]!.message).toMatch(/PriceRoseAboveMax/);
    expect(result.failingChunk).toMatchObject({ index: 1, mayHaveBroadcast: false });
  });

  it("stops sending after a batch the node refuses; that batch stored nothing", async () => {
    mocks.send
      .mockResolvedValueOnce({ final_execution_status: "NONE" })
      .mockRejectedValueOnce(typed("InvalidNonce", "Transaction nonce 12 must be larger than nonce of the used access key 12"));
    const result = await signAndSendStrokeLocally(args);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "failed", "not_sent"]);
    expect(result.chunks[2]!.message).toBe("Not sent: an earlier batch's send failed.");
  });

  it("logs the gas and gas price when the chain refuses the key, the only trace a refusal leaves", async () => {
    const refusal = "Access Key alice.testnet:public does not have enough balance 1 for transaction costing 2";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.send.mockRejectedValueOnce(typed("NotEnoughAllowance", refusal));
    const result = await signAndSendStrokeLocally(args);
    expect(result.chunks[0]).toMatchObject({ state: "failed", message: refusal });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[wall] drawing key refused:", {
      attachedGas: DRAW_GAS, gasPrice: "100000000", message: refusal,
    }));
    log.mockRestore();
  });

  it("looks up a send whose response was lost, and confirms it by hash", async () => {
    mocks.send.mockRejectedValueOnce(new Error("fetch failed"));
    mocks.status
      .mockRejectedValueOnce(typed("UNKNOWN_TRANSACTION"))
      .mockRejectedValueOnce(typed("UNKNOWN_TRANSACTION"))
      .mockResolvedValueOnce(ok());
    const result = await signAndSendStrokeLocally(args);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "not_sent", "not_sent"]);
  });

  it("reports a lost send that never shows up as uncertain, never as failed", async () => {
    mocks.send.mockRejectedValueOnce(new Error("fetch failed"));
    mocks.status.mockRejectedValue(typed("UNKNOWN_TRANSACTION"));
    const result = await signAndSendStrokeLocally(args);
    expect(result.chunks[0]).toMatchObject({ state: "uncertain", message: "fetch failed", transactionHash: hashOf(11) });
    expect(result.failingChunk).toMatchObject({ index: 0, mayHaveBroadcast: true });
  });

  it("recovers the last batch's outcome by hash when its send-and-wait times out", async () => {
    mocks.send.mockImplementation(async (_signed: unknown, mode: string) => {
      if (mode === "NONE") return { final_execution_status: "NONE" };
      throw typed("TIMEOUT_ERROR", "Transaction timed out");
    });
    const result = await signAndSendStrokeLocally(args);
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(mocks.status).toHaveBeenLastCalledWith(hashOf(13), "alice.testnet", "EXECUTED_OPTIMISTIC");
  });

  it("treats an outcome with no recognisable status as uncertain", async () => {
    mocks.status.mockResolvedValueOnce({ transaction: { hash: "h" } });
    const result = await signAndSendStrokeLocally(args);
    expect(result.chunks[0]!.state).toBe("uncertain");
  });

  it("does not claim a possible broadcast when signing fails before any send", async () => {
    mocks.sign.mockRejectedValueOnce(new Error("Expected Array-like not bigint"));
    const result = await signAndSendStrokeLocally(args);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.chunks.map((c) => c.state)).toEqual(["not_sent", "not_sent", "not_sent"]);
    expect(result.failingChunk).toEqual({ index: 0, mayHaveBroadcast: false, message: "Expected Array-like not bigint" });
  });

  it("signs only the batches the allowance covers and says why the rest were not sent", async () => {
    // Exactly two batches' reserve (30 Tgas × 0.1 Ggas price × 2 each).
    const reserve = 30_000_000_000_000n * 100_000_000n * 2n;
    mocks.key.mockResolvedValueOnce(key(10, String(reserve * 2n + 1n)));
    const result = await signAndSendStrokeLocally(args);
    expect(sentNonces()).toEqual([11, 12]);
    expect(sentModes()).toEqual(["NONE", "EXECUTED_OPTIMISTIC"]);
    expect(result.chunks.map((c) => c.state)).toEqual(["confirmed", "confirmed", "not_sent"]);
    expect(result.chunks[2]!.message).toMatch(/too little gas allowance/);
  });

  it("refuses a short allowance before broadcasting anything", async () => {
    mocks.key.mockResolvedValueOnce(key(10, "1"));
    expect(await signAndSendStrokeLocally(args)).toMatchObject({ status: "partial", confirmedChunks: 0, failingChunk: {
      index: 0, mayHaveBroadcast: false,
      message: "This drawing session has too little gas allowance for the next batch. Authorize a new session to continue.",
    } });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("signs nothing when the node does not report the key's nonce", async () => {
    mocks.key.mockResolvedValueOnce({ permission: { FunctionCall: { allowance: FULL } } });
    const result = await signAndSendStrokeLocally(args);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.failingChunk).toMatchObject({ index: 0, mayHaveBroadcast: false, message: expect.stringMatching(/nonce/) });
  });

  it("does not read the gas price into a refusal when the allowance is unlimited", async () => {
    mocks.key.mockResolvedValueOnce(key(10, null));
    mocks.price.mockRejectedValue(new Error("price read down"));
    expect((await signAndSendStrokeLocally(args)).status).toBe("confirmed");
  });

  it("resolves the executed block for every confirmed chunk", async () => {
    mocks.status.mockResolvedValue(ok("BH1"));
    mocks.send.mockImplementation(async (_s: unknown, mode: string) => mode === "NONE" ? {} : ok("BH1"));
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
    mocks.block.mockRejectedValue(new Error("rpc down"));
    const result = await signAndSendStrokeLocally(args);
    expect(result.status).toBe("confirmed");
    expect(result.confirmedChunks).toBe(3);
    expect(result.executedBlocks).toEqual([]);
  });
});

describe("drawing-session key reads", () => {
  it("reports a missing key from the node's UNKNOWN_ACCESS_KEY error", async () => {
    // Simulate the JSON-RPC error body rather than a thrown transport error.
    const readRpc = await import("./read-rpc");
    const spy = vi.spyOn(readRpc, "readRpcFetch").mockResolvedValueOnce(new Response(JSON.stringify({
      jsonrpc: "2.0", id: "t", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } },
    })));
    expect(await fetchDrawingSessionAllowance(args)).toMatchObject({ found: false });
    spy.mockRestore();
  });

  it("treats a busy network as an RPC failure, never as a missing key", async () => {
    const readRpc = await import("./read-rpc");
    const spy = vi.spyOn(readRpc, "readRpcFetch").mockRejectedValueOnce(new Error("Network busy. Please retry shortly."));
    await expect(fetchDrawingSessionAllowance(args)).rejects.toMatchObject({ code: "rpc", mayHaveBroadcast: false });
    spy.mockRestore();
  });
});
