import { beforeEach, describe, expect, it, vi } from "vitest";
const getAccessKey = vi.hoisted(() => vi.fn());
vi.mock("@near-js/accounts", () => ({
  Account: vi.fn().mockImplementation(() => ({ getAccessKey, getAccessKeyList: async () => ({ keys: [] }) })),
}));
const signAndSend = vi.hoisted(() => vi.fn());
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    on() {}
    async connect() {}
    async disconnect() {}
    async getConnectedWallet() {
      return null;
    }
    async wallet() {
      return {
        signAndSendTransaction: signAndSend,
        getAccounts: async () => [{ accountId: "alice.testnet" }],
      };
    }
  },
}));
vi.mock("./config", () => ({
  CONTRACT_ID: "board.testnet",
  TOILET_ID: "",
  RPC_URL: "https://rpc.testnet.near.org",
  PAGE_NETWORK: "testnet",
  WALLET_NETWORK: "testnet",
  PRIVY_ENABLED: false,
  INTENTS_FUNDING_ENABLED: false,
  RHEA_MPOO_SWAP_ENABLED: false,
  ACQUISITION_PLAY_RESERVE_YOCTO: "",
  rpcConnection: () => ({ url: "https://rpc.testnet.near.org" }),
}));
import { authorizeDrawingSession, verifyAccessKeyOnAccount } from "./wallet";
import { DRAWING_SESSION_GAS_ALLOWANCE_YOCTO } from "./drawing-session";

describe("authorizeDrawingSession", () => {
  it("adds the key as a wallet transaction carrying our own permission", async () => {
    signAndSend.mockReset();
    signAndSend.mockResolvedValue({
      transaction: { hash: "addkey-hash" },
      status: { SuccessValue: "" },
    });
    getAccessKey.mockResolvedValue({
      permission: {
        FunctionCall: {
          receiver_id: "board.testnet",
          method_names: ["draw", "draw_many"],
          allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
        },
      },
    });
    const result = await authorizeDrawingSession();
    expect(result.confirmed).toBe(true);
    expect(result.transactionHash).toBe("addkey-hash");
    const call = signAndSend.mock.calls[0][0];
    expect(call.receiverId).toBe("alice.testnet");
    expect(call.actions).toHaveLength(1);
    expect(call.actions[0].type).toBe("AddKey");
    // The whole point: the method filter is ours, so the wallet cannot widen it.
    expect(call.actions[0].params.accessKey.permission).toEqual({
      receiverId: "board.testnet",
      allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
      methodNames: ["draw", "draw_many"],
    });
  });

  describe("renewing", () => {
    const drawingKey = {
      permission: {
        FunctionCall: {
          receiver_id: "board.testnet",
          method_names: ["draw", "draw_many"],
          allowance: "30000000000000000000000",
        },
      },
    };
    beforeEach(() => {
      signAndSend.mockReset();
      signAndSend.mockResolvedValue({ transaction: { hash: "h" }, status: { SuccessValue: "" } });
      getAccessKey.mockReset();
    });
    const actionTypes = () => signAndSend.mock.calls[0][0].actions.map((a: { type: string }) => a.type);

    it("adds the new key and deletes the old one in a single transaction", async () => {
      getAccessKey.mockResolvedValue(drawingKey);
      await authorizeDrawingSession({ replacePublicKey: "ed25519:spent" });
      expect(signAndSend).toHaveBeenCalledTimes(1);
      expect(actionTypes()).toEqual(["AddKey", "DeleteKey"]);
      expect(signAndSend.mock.calls[0][0].actions[1].params).toEqual({ publicKey: "ed25519:spent" });
    });

    it("still adds the new key when the old one is gone: DeleteKey would fail the whole transaction", async () => {
      getAccessKey.mockRejectedValue(new Error("does not exist while viewing"));
      await authorizeDrawingSession({ replacePublicKey: "ed25519:gone" });
      expect(actionTypes()).toEqual(["AddKey"]);
    });

    it("never deletes a full-access key or another contract's key", async () => {
      getAccessKey.mockResolvedValue({ permission: "FullAccess" });
      await authorizeDrawingSession({ replacePublicKey: "ed25519:owner" });
      expect(actionTypes()).toEqual(["AddKey"]);

      signAndSend.mockClear();
      getAccessKey.mockResolvedValue({
        permission: { FunctionCall: { ...drawingKey.permission.FunctionCall, receiver_id: "other.testnet" } },
      });
      await authorizeDrawingSession({ replacePublicKey: "ed25519:other" });
      expect(actionTypes()).toEqual(["AddKey"]);
    });
  });

  it("keeps the secret when the chain read lags, and reports not-confirmed", async () => {
    signAndSend.mockReset();
    signAndSend.mockResolvedValue({ transaction: { hash: "h" }, status: { SuccessValue: "" } });
    getAccessKey.mockRejectedValue(new Error("does not exist while viewing"));
    const result = await authorizeDrawingSession();
    expect(result.confirmed).toBe(false);
  });
});

describe("drawing authorization verifies installed authority, not merely key existence", () => {
  beforeEach(() => {
    getAccessKey.mockReset();
  });
  it("rejects a full-access key even though the public key exists", async () => {
    getAccessKey.mockResolvedValue({ permission: "FullAccess" });
    expect(
      await verifyAccessKeyOnAccount("alice.testnet", "ed25519:fixture"),
    ).toBe(false);
  });
  it("accepts the board with drawing methods or a wallet-wide filter, and nothing wider", async () => {
    const permission = {
      receiver_id: "board.testnet",
      method_names: ["draw", "draw_many"],
      allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    };
    getAccessKey.mockResolvedValue({
      permission: { FunctionCall: permission },
    });
    expect(
      await verifyAccessKeyOnAccount("alice.testnet", "ed25519:fixture"),
    ).toBe(true);
    // Meteor stores an empty method filter, i.e. any method on the receiver. The key can
    // still paint, so it activates the session; the panel reports the wider scope.
    getAccessKey.mockResolvedValue({
      permission: { FunctionCall: { ...permission, method_names: [] } },
    });
    expect(
      await verifyAccessKeyOnAccount("alice.testnet", "ed25519:fixture"),
    ).toBe(true);
    for (const changed of [
      { receiver_id: "other.testnet" },
      { method_names: ["draw", "ft_transfer"] },
      { allowance: null },
      { allowance: (BigInt(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO) + 1n).toString() },
    ]) {
      getAccessKey.mockResolvedValue({
        permission: { FunctionCall: { ...permission, ...changed } },
      });
      expect(
        await verifyAccessKeyOnAccount("alice.testnet", "ed25519:fixture"),
      ).toBe(false);
    }
  });
  it("does not activate an authorization when the chain read fails", async () => {
    getAccessKey.mockRejectedValue(new Error("timeout"));
    expect(
      await verifyAccessKeyOnAccount("alice.testnet", "ed25519:fixture"),
    ).toBe(false);
  });
});
