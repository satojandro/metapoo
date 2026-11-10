// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServices, WalletService } from "./services";
import { mountAcquisitionPanel } from "./acquisition-panel";

const state = vi.hoisted(() => ({
  accountId: "alice.near" as string | null,
  epoch: 1,
  invalidate: vi.fn(),
  loadAssets: vi.fn(async () => undefined),
  dispose: vi.fn(),
}));

vi.mock("../config", () => ({
  ACQUISITION_PLAY_RESERVE_YOCTO: "1000",
  INTENTS_FUNDING_ENABLED: true,
  INTENTS_TEST_MODE: false,
  RHEA_MPOO_SWAP_ENABLED: false,
  PAGE_NETWORK: "mainnet",
  RPC_URL: "https://rpc.example",
}));
vi.mock("../wallet", () => ({
  getAcquisitionContext: (operationId: string) =>
    state.accountId
      ? {
          operationId,
          accountId: state.accountId,
          networkId: "mainnet",
          sessionEpoch: state.epoch,
        }
      : null,
  readConnectedAccountReadiness: vi.fn(),
  signAndSendApprovedTransactions: vi.fn(),
  configureAcquisitionPolicy: vi.fn(),
  reconcilePendingAcquisition: vi.fn(),
  getConnectedAcquisitionPublicKey: vi.fn(),
  supportsAcquisitionBatchRegistrations: vi.fn(),
}));
vi.mock("../integrations/rpc", () => ({ createAcquisitionRpc: () => vi.fn() }));
vi.mock("../integrations/operation-store", () => ({
  listRecoverableAcquisitions: () => [],
}));
vi.mock("../integrations/intents/client", () => ({
  createIntentsClient: () => ({}),
}));
vi.mock("../integrations/intents/storage", () => ({
  createIntentsStorage: () => ({}),
}));
vi.mock("../integrations/intents/receipt", () => ({
  createDestinationReconciler: () => vi.fn(),
}));
vi.mock("../integrations/intents/funding", () => ({
  createIntentsFundingController: () => ({
    invalidatePreview: state.invalidate,
    loadAssets: state.loadAssets,
    getState: () => ({ assets: [] }),
    dispose: state.dispose,
  }),
}));
vi.mock("../integrations/intents/panel", () => ({
  mountIntentsFundingPanel: (
    _host: unknown,
    controller: { loadAssets(): unknown; dispose(): void },
  ) => {
    // Model the real panel's mount-time asynchronous registry read. An unrelated parent
    // refresh must not invalidate it before its response can be consumed.
    void controller.loadAssets();
    return () => controller.dispose();
  },
}));

let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  state.accountId = "alice.near";
  state.epoch = 1;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
});

function mount() {
  let notify: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const wallet: WalletService = {
    getSession: () => ({ accountId: state.accountId, networkId: "mainnet" }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    whenReady: Promise.resolve({
      accountId: state.accountId,
      networkId: "mainnet",
    }),
    subscribe(listener) {
      notify = () => listener(wallet.getSession());
      notify(); // Existing wallet service subscriptions deliver an immediate snapshot.
      return unsubscribe;
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  cleanup = mountAcquisitionPanel(
    host,
    { wallet, operations: {} as AppServices["operations"] },
    vi.fn(),
  );
  return { notify: () => notify?.(), unsubscribe };
}

describe("acquisition parent identity notifications", () => {
  it("does not cancel the initial funding asset read or unchanged wallet snapshots", () => {
    const app = mount();
    expect(state.loadAssets).toHaveBeenCalledTimes(1);
    expect(state.invalidate).not.toHaveBeenCalled();
    app.notify();
    expect(state.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates a same-account session epoch change once, and also handles account switches", () => {
    const app = mount();
    state.epoch = 2;
    app.notify();
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    app.notify();
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    state.accountId = "bob.near";
    app.notify();
    expect(state.invalidate).toHaveBeenCalledTimes(2);
    state.accountId = null;
    state.epoch = 3;
    app.notify();
    expect(state.invalidate).toHaveBeenCalledTimes(3);
    cleanup?.();
    cleanup = undefined;
    expect(app.unsubscribe).toHaveBeenCalledTimes(1);
    expect(state.dispose).toHaveBeenCalledTimes(1);
  });

  it("re-reads funding assets when the wallet session restores after mount", () => {
    // Production: the panel mounts before restoreWalletSession() resolves, so the first read
    // fails with "Connect a wallet before adding funds" and the asset list stayed empty.
    state.accountId = null;
    const app = mount();
    expect(state.loadAssets).toHaveBeenCalledTimes(1);
    state.accountId = "alice.near";
    state.epoch = 2;
    app.notify();
    expect(state.loadAssets).toHaveBeenCalledTimes(2);
  });
});
