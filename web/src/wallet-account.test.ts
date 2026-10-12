import { describe, expect, it } from "vitest";
import { accountIdFromWallet } from "./wallet";

describe("accountIdFromWallet", () => {
  it("reads accountId from getAccounts when top-level accountId is missing", async () => {
    const wallet = {
      getAccounts: async () => [{ accountId: "artist.testnet" }],
    };
    expect(await accountIdFromWallet(wallet)).toBe("artist.testnet");
  });

  it("falls back to a top-level accountId property", async () => {
    const wallet = { accountId: "direct.testnet" };
    expect(await accountIdFromWallet(wallet)).toBe("direct.testnet");
  });

  it("returns null when neither getAccounts nor accountId is present", async () => {
    expect(await accountIdFromWallet({})).toBeNull();
  });
});
