import { describe, expect, it, vi } from "vitest";
import {
  createPrivyManifest,
  readPrivyConfig,
  type PrivyConfig,
} from "./config";
import { reviewPrivyRequest, type SigningSession } from "./approval";
import {
  ensureNearWallet,
  getPrivyHostIdentity,
  logoutPrivySession,
  nearWallets,
  PRIVY_HOST_IDENTITY_KEY,
  setPrivyHostIdentity,
  type PrivyNearWallet,
  type PrivySessionClient,
} from "./session";
import { buildAddFunctionCallKeyParams } from "../../drawing-session";

const address = "12".repeat(32),
  other = "34".repeat(32);
const wallet: PrivyNearWallet = {
  type: "wallet",
  chain_type: "near",
  id: "wallet-1",
  address,
};
const config: PrivyConfig = {
  appId: "app-id",
  clientId: "client-id",
  network: "testnet",
  origin: "http://localhost:5173",
  signPageUrl: "http://localhost:5173/game/privy-sign.html",
  rpcUrl: "https://rpc.testnet.near.org/",
};
const host = {
  accountId: address,
  networkId: "testnet" as const,
  sessionEpoch: 1,
};
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}
function session(payload: unknown): SigningSession {
  return { payload, targetOrigin: config.origin, sign: vi.fn() };
}
const tx = {
  kind: "signAndSendTransaction",
  network: "testnet",
  receiverId: "wrap.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "near_deposit",
        args: {},
        deposit: "1000000000000000000000000",
        gas: "30000000000000",
      },
    },
  ],
};

describe("Privy configuration and manifest", () => {
  const env = {
    VITE_PRIVY_ENABLED: "true",
    VITE_PRIVY_APP_ID: "app-id",
    VITE_PRIVY_APP_CLIENT_ID: "client-id",
    VITE_NEAR_NETWORK: "testnet",
    VITE_PRIVY_SIGN_PAGE_URL: "/game/privy-sign.html",
  };
  it("leaves ordinary wallet setup untouched when disabled or incomplete", () => {
    expect(readPrivyConfig({}, config.origin)).toEqual({ state: "disabled" });
    expect(
      readPrivyConfig({ ...env, VITE_PRIVY_APP_ID: "" }, config.origin).state,
    ).toBe("unavailable");
  });
  it("rejects external sign pages, arbitrary routes and mock to mainnet fallback", () => {
    for (const value of [
      "https://attacker.invalid/privy-sign.html",
      "/wall",
      "/privy-sign.html?return=https://attacker.invalid",
    ]) {
      expect(
        readPrivyConfig(
          { ...env, VITE_PRIVY_SIGN_PAGE_URL: value },
          config.origin,
        ).state,
      ).toBe("unavailable");
    }
    expect(
      readPrivyConfig({ ...env, VITE_NEAR_NETWORK: "mock" }, config.origin)
        .state,
    ).toBe("unavailable");
  });
  it("preserves deployed subpaths and uses a vendored executor rather than a mutable URL", () => {
    const result = readPrivyConfig(env, config.origin);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error();
    const manifest = createPrivyManifest(result.config);
    expect(manifest.metadata.signPageURL).toBe(config.signPageUrl);
    expect(new URL(manifest.executor).origin).toBe(config.origin);
    expect(manifest.features.signInWithFunctionCallKey).toBe(true);
    expect(manifest.permissions.allowsOpen).toEqual([config.signPageUrl]);
    expect(manifest.features.signDelegateActions).toBe(false);
  });
});

describe("Privy account identity", () => {
  it("does not confuse an EVM wallet or a malformed address with a NEAR account", () => {
    expect(
      nearWallets({
        linked_accounts: [
          { ...wallet, chain_type: "ethereum" },
          { ...wallet, address: "0x123" },
          wallet,
        ],
      }),
    ).toEqual([wallet]);
  });
  it("provisions once across concurrent callers and restores the same selected wallet", async () => {
    const storage = memory();
    let created = false;
    const client: PrivySessionClient = {
      user: {
        get: async () => ({
          user: { linked_accounts: created ? [wallet] : [] },
        }),
      },
      createNearWallet: vi.fn(async () => {
        created = true;
      }),
      logout: vi.fn(),
    };
    const [first, second] = await Promise.all([
      ensureNearWallet(client, "testnet", storage),
      ensureNearWallet(client, "testnet", storage),
    ]);
    expect(first.address).toBe(address);
    expect(second.id).toBe(wallet.id);
    await ensureNearWallet(client, "testnet", storage);
    expect(client.createNearWallet).toHaveBeenCalledTimes(1);
  });
  it("cannot silently switch a disappeared selection or choose the first of multiple NEAR wallets", async () => {
    const storage = memory();
    const client = {
      user: {
        get: vi.fn().mockResolvedValue({ user: { linked_accounts: [wallet] } }),
      },
      createNearWallet: vi.fn(),
      logout: vi.fn(),
    };
    await ensureNearWallet(client, "testnet", storage);
    client.user.get.mockResolvedValue({
      user: { linked_accounts: [{ ...wallet, id: "new", address: other }] },
    });
    await expect(ensureNearWallet(client, "testnet", storage)).rejects.toThrow(
      "selected NEAR wallet",
    );
    client.user.get.mockResolvedValue({
      user: {
        linked_accounts: [wallet, { ...wallet, id: "new", address: other }],
      },
    });
    await expect(ensureNearWallet(client, "mainnet", memory())).rejects.toThrow(
      "Multiple",
    );
  });
  it("invalidates host approval even when provider logout fails and preserves drawing storage", async () => {
    const storage = memory();
    storage.setItem("drawing-secret", "untouched");
    setPrivyHostIdentity(host, storage);
    const client = {
      user: { get: vi.fn() },
      createNearWallet: vi.fn(),
      logout: vi.fn().mockRejectedValue(new Error("offline")),
    };
    await expect(
      logoutPrivySession(client, "testnet", storage),
    ).rejects.toThrow("offline");
    expect(getPrivyHostIdentity(storage)).toBeNull();
    expect(storage.getItem("drawing-secret")).toBe("untouched");
    storage.setItem(PRIVY_HOST_IDENTITY_KEY, "{broken");
    expect(getPrivyHostIdentity(storage)).toBeNull();
  });
});

describe("Privy signing request boundary", () => {
  it("allows login before account funding without treating the address as ready", () => {
    expect(
      reviewPrivyRequest(
        session({ kind: "signIn", network: "testnet" }),
        config,
        wallet,
        null,
        "wall.testnet",
      ),
    ).toMatchObject({ requiresFunds: false, requiresHost: false });
  });
  it("rejects missing network instead of upstream mainnet default, wrong origin and wrong account", () => {
    expect(() =>
      reviewPrivyRequest(
        session({ kind: "signIn" }),
        config,
        wallet,
        null,
        "wall.testnet",
      ),
    ).toThrow("network");
    expect(() =>
      reviewPrivyRequest(
        { ...session(tx), targetOrigin: "https://attacker.invalid" },
        config,
        wallet,
        host,
        "wall.testnet",
      ),
    ).toThrow("allowed");
    expect(() =>
      reviewPrivyRequest(
        session({ ...tx, signerId: other }),
        config,
        wallet,
        host,
        "wall.testnet",
      ),
    ).toThrow("signing account");
    expect(() =>
      reviewPrivyRequest(
        session(tx),
        config,
        wallet,
        { ...host, accountId: other },
        "wall.testnet",
      ),
    ).toThrow("changed");
  });
  it("permits only the already approved drawing-key scope and gas allowance", () => {
    const key = buildAddFunctionCallKeyParams(
      "wall.testnet",
      "ed25519:11111111111111111111111111111111",
    );
    const payload = {
      kind: "signIn",
      network: "testnet",
      addFunctionCallKey: key,
    };
    const pending = {
      ...host,
      publicKey: key.publicKey,
      contractId: "wall.testnet",
      methods: ["draw", "draw_many"],
      allowance: key.gasAllowance.amount,
      createdAtMs: Date.now(),
    };
    expect(
      reviewPrivyRequest(
        session(payload),
        config,
        wallet,
        host,
        "wall.testnet",
        undefined,
        pending,
      ).requiresFunds,
    ).toBe(true);
    for (const bad of [
      { ...key, contractId: "other.testnet" },
      { ...key, gasAllowance: { kind: "unlimited" } },
      { ...key, allowMethods: { anyMethod: true, methodNames: [] } },
    ]) {
      expect(() =>
        reviewPrivyRequest(
          session({ ...payload, addFunctionCallKey: bad }),
          config,
          wallet,
          host,
          "wall.testnet",
          undefined,
          pending,
        ),
      ).toThrow();
    }
  });
  it("reviews exact integer deposits without signing or sending", () => {
    const request = session(tx);
    const result = reviewPrivyRequest(
      request,
      config,
      wallet,
      host,
      "wall.testnet",
    );
    expect(result.details.join("\n")).toContain(
      "1000000000000000000000000 yoctoNEAR",
    );
    expect(request.sign).not.toHaveBeenCalled();
  });
  it("rejects sponsorship, full-access additions, arbitrary key deletion and invalid gas", () => {
    for (const payload of [
      { kind: "signDelegateActions", network: "testnet" },
      { ...tx, actions: [{ type: "AddKey", params: {} }] },
      {
        ...tx,
        receiverId: address,
        actions: [{ type: "DeleteKey", params: { publicKey: "different" } }],
      },
      {
        ...tx,
        actions: [
          {
            type: "FunctionCall",
            params: { ...tx.actions[0].params, gas: "999999999999999" },
          },
        ],
      },
    ]) {
      expect(() =>
        reviewPrivyRequest(
          session(payload),
          config,
          wallet,
          host,
          "wall.testnet",
        ),
      ).toThrow();
    }
  });
});
