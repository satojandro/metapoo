import { beforeEach, describe, expect, it, vi } from "vitest";
const getAccessKey = vi.hoisted(() => vi.fn());
vi.mock("@near-js/accounts", () => ({
  Account: vi.fn().mockImplementation(() => ({ getAccessKey })),
}));
vi.mock("./config", () => ({
  CONTRACT_ID: "board.testnet",
  RPC_URL: "https://rpc.testnet.near.org",
  PAGE_NETWORK: "testnet",
  WALLET_NETWORK: "testnet",
  PRIVY_ENABLED: false,
  INTENTS_FUNDING_ENABLED: false,
  RHEA_MPOO_SWAP_ENABLED: false,
  ACQUISITION_PLAY_RESERVE_YOCTO: "",
}));
import { verifyAccessKeyOnAccount } from "./wallet";
import { DRAWING_SESSION_GAS_ALLOWANCE_YOCTO } from "./drawing-session";

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
  it("accepts only the existing board, exact drawing methods and bounded gas allowance", async () => {
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
    for (const changed of [
      { receiver_id: "other.testnet" },
      { method_names: [] },
      { method_names: ["draw", "ft_transfer"] },
      { allowance: null },
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
