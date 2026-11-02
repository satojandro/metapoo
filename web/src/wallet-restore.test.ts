/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getConnectedWallet = vi.fn();
const on = vi.fn();
const disconnect = vi.fn();

vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: vi.fn().mockImplementation(() => ({
    on,
    getConnectedWallet,
    connect: vi.fn(),
    disconnect,
    wallet: vi.fn(),
  })),
}));

describe("restoreWalletSession", () => {
  beforeEach(() => {
    getConnectedWallet.mockReset();
    on.mockReset();
    disconnect.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
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

  it("invalidates identity and popup authority before a delayed disconnect provider lookup", async () => {
    vi.stubEnv("VITE_PRIVY_ENABLED", "true");
    getConnectedWallet.mockResolvedValue({
      wallet: { manifest: { id: "meteor-wallet" } },
      accounts: [{ accountId: "alice.testnet" }],
    });
    const {
      restoreWalletSession,
      getWalletSession,
      getAcquisitionContext,
      disconnectWallet,
    } = await import("./wallet");
    const { getPrivyHostIdentity } = await import(
      "./integrations/privy/session"
    );
    await restoreWalletSession();
    expect(getAcquisitionContext("pending-approval")).not.toBeNull();
    expect(getPrivyHostIdentity(localStorage)?.accountId).toBe("alice.testnet");

    // Hold provider metadata lookup open, just as a slow sandbox/getAccounts call can.
    let releaseLookup!: (value: unknown) => void;
    getConnectedWallet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLookup = resolve;
        }),
    );
    const pendingDisconnect = disconnectWallet();

    // These checks happen before the first provider await resolves. An open popup's
    // final epoch/host checks must already reject the old authority at this point.
    expect(disconnect).not.toHaveBeenCalled();
    expect(getWalletSession().accountId).toBeNull();
    expect(getAcquisitionContext("pending-approval")).toBeNull();
    expect(getPrivyHostIdentity(localStorage)).toBeNull();

    releaseLookup({
      wallet: { manifest: { id: "meteor-wallet" } },
      accounts: [],
    });
    await pendingDisconnect;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getWalletSession().accountId).toBeNull();
  });

  it("stays disconnected when no wallet was selected", async () => {
    getConnectedWallet.mockRejectedValue(new Error("No wallet selected"));
    const { restoreWalletSession, getWalletSession } = await import("./wallet");
    const session = await restoreWalletSession();
    expect(session.accountId).toBeNull();
    expect(getWalletSession().accountId).toBeNull();
  });
});
