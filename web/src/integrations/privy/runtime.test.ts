import { afterEach, describe, expect, it, vi } from "vitest";
const vendor = vi.hoisted(() => {
  const client = {
    initialize: vi.fn().mockResolvedValue(undefined),
    user: { get: vi.fn() },
    fetchPrivyRoute: vi.fn(),
    getCompiledPath: vi.fn(),
    app: { appId: "app-id" },
    auth: {
      logout: vi.fn().mockResolvedValue(undefined),
      email: {
        sendCode: vi.fn().mockResolvedValue(undefined),
        loginWithCode: vi.fn().mockResolvedValue({}),
      },
      oauth: {
        generateURL: vi
          .fn()
          .mockResolvedValue({ url: "https://accounts.google.com/o/oauth2" }),
        loginWithCode: vi.fn().mockResolvedValue({}),
      },
    },
  };
  return {
    client,
    create: vi.fn().mockResolvedValue({}),
    handshake: vi
      .fn()
      .mockResolvedValue({
        payload: {},
        targetOrigin: "https://game.test",
        sign: vi.fn(),
      }),
  };
});
vi.mock("@privy-io/js-sdk-core", () => ({
  default: class {
    constructor() {
      return vendor.client;
    }
  },
  LocalStorage: class {},
  create: vendor.create,
}));
vi.mock("@peerfolio/privy-near-connect/sign-page", () => ({
  initSigningPage: vendor.handshake,
}));
import { createPrivyRuntime } from "./runtime";
import type { PrivyConfig } from "./config";
const config: PrivyConfig = {
  appId: "app-id",
  clientId: "client-id",
  network: "testnet",
  origin: "https://game.test",
  signPageUrl: "https://game.test/privy-sign.html",
  rpcUrl: "https://rpc.testnet.near.org",
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("real SDK adapter boundary", () => {
  it("uses the published NEAR create API and handles OAuthInitResponseBody.url", async () => {
    const runtime = createPrivyRuntime(config);
    await runtime.initialize();
    await runtime.createNearWallet();
    expect(vendor.create).toHaveBeenCalledWith(
      expect.objectContaining({ app: { appId: "app-id" } }),
      { request: { chain_type: "near" } },
    );
    expect(await runtime.googleUrl()).toBe(
      "https://accounts.google.com/o/oauth2",
    );
    expect(vendor.client.auth.oauth.generateURL).toHaveBeenCalledWith(
      "google",
      config.signPageUrl,
    );
    await runtime.completeOAuth("code", "state");
    expect(vendor.client.auth.oauth.loginWithCode).toHaveBeenCalledWith(
      "code",
      "state",
    );
    await runtime.logout();
    expect(vendor.client.auth.logout).toHaveBeenCalled();
    runtime.dispose();
  });
  it("binds the sign-page SDK to the configured origin and testnet RPC rather than its mainnet default", async () => {
    const runtime = createPrivyRuntime(config);
    await runtime.handshake();
    expect(vendor.handshake).toHaveBeenCalledWith(
      vendor.client,
      expect.objectContaining({
        allowedOrigins: ["https://game.test"],
        debug: false,
        rpcOptions: { url: "https://rpc.testnet.near.org" },
      }),
    );
    runtime.dispose();
  });
  it("cannot authorize AddKey or capital spending from a metadata-only/unfunded account", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ error: { name: "UNKNOWN_ACCOUNT" } }),
      });
    vi.stubGlobal("fetch", fetch);
    const runtime = createPrivyRuntime(config);
    await expect(
      runtime.assertReady({
        type: "wallet",
        chain_type: "near",
        id: "wallet-1",
        address: "12".repeat(32),
      }),
    ).rejects.toThrow("native NEAR");
    expect(fetch).toHaveBeenCalledWith(
      config.rpcUrl,
      expect.objectContaining({ method: "POST" }),
    );
    expect(vendor.handshake).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
