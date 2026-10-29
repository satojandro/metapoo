/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getConnectedWallet = vi.fn();
const on = vi.fn();

vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: vi.fn().mockImplementation(() => ({
    on,
    getConnectedWallet,
    connect: vi.fn(),
    disconnect: vi.fn(),
    wallet: vi.fn(),
  })),
}));

describe("restoreWalletSession", () => {
  beforeEach(() => {
    getConnectedWallet.mockReset();
    on.mockReset();
    vi.resetModules();
  });

  it("hydrates the in-memory session from a previously selected wallet", async () => {
    getConnectedWallet.mockResolvedValue({
      wallet: {},
      accounts: [{ accountId: "alice.testnet" }],
    });
    const { restoreWalletSession, getWalletSession } = await import("./wallet");
    const session = await restoreWalletSession();
    expect(session.accountId).toBe("alice.testnet");
    expect(getWalletSession().accountId).toBe("alice.testnet");
  });

  it("stays disconnected when no wallet was selected", async () => {
    getConnectedWallet.mockRejectedValue(new Error("No wallet selected"));
    const { restoreWalletSession, getWalletSession } = await import("./wallet");
    const session = await restoreWalletSession();
    expect(session.accountId).toBeNull();
    expect(getWalletSession().accountId).toBeNull();
  });
});
