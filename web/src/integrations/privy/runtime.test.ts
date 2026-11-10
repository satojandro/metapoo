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
    handshake: vi.fn().mockResolvedValue({
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
import {
  PRIVY_UNSUBMITTED_REJECTION,
  isPrivyUnsubmittedRejection,
} from "./session";
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
  it("uses the pinned rejection envelope and never confuses window-close or RPC errors with it", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { opener: { postMessage } });
    const runtime = createPrivyRuntime(config);
    expect(() =>
      runtime.rejectBeforeBroadcast("https://untrusted.test"),
    ).toThrow();
    expect(postMessage).not.toHaveBeenCalled();
    runtime.rejectBeforeBroadcast(config.origin);
    expect(postMessage).toHaveBeenCalledWith(
      {
        source: "privy-near-connect",
        type: "ERROR",
        error: {
          type: PRIVY_UNSUBMITTED_REJECTION,
          message: "Cancelled before signing.",
        },
      },
      config.origin,
    );
    // This is the exact transformation performed by vendor-executor.js on ERROR.
    const executorError = Object.assign(
      new Error("Cancelled before signing."),
      {
        name: PRIVY_UNSUBMITTED_REJECTION,
        type: PRIVY_UNSUBMITTED_REJECTION,
      },
    );
    expect(isPrivyUnsubmittedRejection(executorError)).toBe(true);
    expect(
      isPrivyUnsubmittedRejection(new Error("Privy Sign window closed")),
    ).toBe(false);
    expect(isPrivyUnsubmittedRejection(new Error("RPC timeout"))).toBe(false);
    expect(
      isPrivyUnsubmittedRejection({ name: PRIVY_UNSUBMITTED_REJECTION }),
    ).toBe(false);
    runtime.dispose();
  });

  it("reports a signed-out visitor as no user, so the login form renders", async () => {
    // The real js-sdk-core@0.72.0 throws this for a fresh browser instead of returning
    // { user: null }; it previously took the sign page straight to "could not be restored".
    vendor.client.user.get.mockRejectedValueOnce(
      Object.assign(new Error("No tokens found in storage"), {
        code: "missing_or_invalid_token",
        status: 401,
      }),
    );
    await expect(createPrivyRuntime(config).user.get()).resolves.toEqual({
      user: null,
    });
  });
  it("records whether a signed-out popup had Privy tokens beforehand", async () => {
    const store = new Map<string, string>([
      ["privy:token", "a"],
      ["privy:refresh_token", "r"],
    ]);
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    // Object.keys(localStorage) lists stored keys; mirror that on the fake.
    const proxy = new Proxy(fake, {
      ownKeys: () => [...store.keys()],
      getOwnPropertyDescriptor: (_t, k) =>
        store.has(String(k))
          ? { enumerable: true, configurable: true, value: store.get(String(k)) }
          : undefined,
    });
    vi.stubGlobal("localStorage", proxy);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vendor.client.user.get.mockImplementationOnce(async () => {
      store.delete("privy:token");
      store.delete("privy:refresh_token");
      throw Object.assign(new Error("Invalid refresh token"), {
        code: "missing_or_invalid_token",
      });
    });
    await createPrivyRuntime(config).user.get();
    const record = JSON.parse(store.get("privy-sign:lastSignedOut")!);
    expect(record).toMatchObject({
      cause: "refresh_rejected",
      hadAccessToken: true,
      hadRefreshToken: true,
    });
    expect(JSON.stringify(record)).not.toContain('"r"');
    vi.unstubAllGlobals();
  });
  it("still surfaces Privy failures that do not mean signed out", async () => {
    const outage = Object.assign(new Error("Bad gateway"), { status: 502 });
    vendor.client.user.get.mockRejectedValueOnce(outage);
    await expect(createPrivyRuntime(config).user.get()).rejects.toBe(outage);
  });
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
    const fetch = vi.fn().mockResolvedValue({
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
