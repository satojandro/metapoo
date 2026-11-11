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
import {
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  DRAWING_SESSION_METHODS,
} from "../../drawing-session";

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
// A transaction the app actually sends: 10 credits for 0.025 NEAR on the board (the approved
// caption table, 11 Nov). The old fixture was a `near_deposit` on wrap.testnet — an action the
// game never sends, which the approval window now refuses on purpose.
const tx = {
  kind: "signAndSendTransaction",
  network: "testnet",
  receiverId: "wall.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "buy_credits_near",
        args: JSON.stringify({ min_credits: "10" }),
        deposit: "25000000000000000000000",
        gas: "30000000000000",
      },
    },
  ],
};
const facts = {
  stakingContractId: null,
  toiletTokenId: "toilet.testnet",
  mpooTokenId: "mpoo.testnet",
  pricePerCreditYocto: "2500000000000000000000",
  mpooPerCredit: null,
  unstakeBurnBps: null,
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
  it("treats an app client id as optional, like the SDK does", () => {
    const result = readPrivyConfig(
      { ...env, VITE_PRIVY_APP_CLIENT_ID: "" },
      config.origin,
    );
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error();
    expect(result.config.clientId).toBe("");
    expect(result.config.appId).toBe("app-id");
  });
  it("defaults an unset network to testnet instead of hiding social login", () => {
    const withoutNetwork: Record<string, string> = { ...env };
    delete withoutNetwork.VITE_NEAR_NETWORK;
    const result = readPrivyConfig(withoutNetwork, config.origin);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error();
    expect(result.config.network).toBe("testnet");
    expect(result.config.rpcUrl).toBe("https://rpc.testnet.near.org/");
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
      undefined,
      null,
      { facts },
    );
    expect(result.details.join("\n")).toContain("25000000000000000000000 yoctoNEAR");
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

describe("Privy picker entry and plain-language review", () => {
  it("ships an inline icon and names Privy as the sign-in host, not the game's origin", () => {
    const manifest = createPrivyManifest(config);
    // favicon.ico does not exist; the picker rendered a broken image.
    expect(manifest.icon.startsWith("data:image/svg+xml,")).toBe(true);
    expect(new URL(manifest.website).hostname).toBe("privy.io");
  });
  it("states amounts in NEAR and gas in TGas, keeping exact values under technical details", () => {
    const review = reviewPrivyRequest(
      session(tx),
      config,
      wallet,
      host,
      "wall.testnet",
      undefined,
      null,
      { facts },
    );
    const rows = Object.fromEntries(review.rows.map((r) => [r.label, r.value]));
    expect(review.title).toBe("Buy 10 credits");
    expect(rows.Pay).toBe("0.025 NEAR");
    expect(rows.To).toBe("the Meta Poo wall");
    expect(review.approveLabel).toBe("Pay 0.025 NEAR");
    expect(review.details.join("\n")).toContain("25000000000000000000000 yoctoNEAR");
    const free = reviewPrivyRequest(
      session({
        ...tx,
        actions: [
          { ...tx.actions[0], params: { ...tx.actions[0].params, deposit: "0" } },
        ],
      }),
      config,
      wallet,
      host,
      "wall.testnet",
      undefined,
      null,
      { facts },
    );
    // A zero deposit is still a purchase of zero credits: the row says what is paid, plainly.
    expect(free.rows.find((r) => r.label === "Pay")?.value).toBe("0 NEAR");
  });
  it("explains the drawing key as a capped allowance in NEAR, not yocto", () => {
    const key = buildAddFunctionCallKeyParams(
      "wall.testnet",
      "ed25519:11111111111111111111111111111111",
    );
    const review = reviewPrivyRequest(
      session({ kind: "signIn", network: "testnet", addFunctionCallKey: key }),
      config,
      wallet,
      host,
      "wall.testnet",
      undefined,
      {
        ...host,
        publicKey: key.publicKey,
        contractId: "wall.testnet",
        methods: ["draw", "draw_many"],
        allowance: key.gasAllowance.amount,
        createdAtMs: Date.now(),
      },
    );
    const text = review.rows.map((r) => r.value).join("\n");
    expect(text).toContain("Up to 0.25 NEAR");
    expect(text).not.toContain("yocto");
    expect(review.details.join("\n")).toContain("Methods: draw, draw_many");
  });
});

describe("drawing key added by an ordinary AddKey transaction", () => {
  const board = "wall.testnet";
  const addedKey = "ed25519:" + "2".repeat(43);
  const pending = {
    accountId: address,
    networkId: "testnet" as const,
    sessionEpoch: 1,
    publicKey: addedKey,
    contractId: board,
    methods: [...DRAWING_SESSION_METHODS],
    allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    createdAtMs: 1,
  };
  const addKeyTransaction = (overrides: Record<string, unknown> = {}) => ({
    kind: "signAndSendTransaction",
    network: "testnet",
    receiverId: address,
    actions: [
      {
        type: "AddKey",
        params: {
          publicKey: addedKey,
          accessKey: {
            nonce: 0,
            permission: {
              receiverId: board,
              allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
              methodNames: [...DRAWING_SESSION_METHODS],
            },
          },
        },
      },
    ],
    ...overrides,
  });
  const review = (
    payload: unknown,
    pendingDrawing: typeof pending | null = pending,
    drawingPublicKey?: string,
  ) =>
    reviewPrivyRequest(
      session(payload),
      config,
      wallet,
      host,
      board,
      drawingPublicKey,
      pendingDrawing,
    );

  it("reviews it in the same plain language as the sign-in key, not as an unsupported action", () => {
    const result = review(addKeyTransaction());
    expect(result.title).toBe("Let this browser paint for you");
    expect(result.eyebrow).toBe("Authorize drawing");
    const values = result.rows.map((r) => `${r.label}: ${r.value}`);
    expect(values).toContain("Adds: A drawing key for this browser");
    expect(values).toContain("Can do: Paint on the Meta Poo wall, nothing else");
    expect(values.join("\n")).toContain("Up to 0.25 NEAR");
    expect(result.details.join("\n")).toContain(`Add drawing key: ${addedKey}`);
    expect(result.details.join("\n")).toContain("Methods: draw, draw_many");
  });

  it("refuses without the record the game writes before opening the page", () => {
    // Otherwise this screen would approve whatever key a compromised game page asked for.
    expect(() => review(addKeyTransaction(), null)).toThrow(
      "Drawing authorization does not match the request pending in the game.",
    );
  });

  it("refuses a full-access key, a different key, contract, methods or allowance", () => {
    const fullAccess = addKeyTransaction({
      actions: [
        {
          type: "AddKey",
          params: { publicKey: addedKey, accessKey: { nonce: 0, permission: "FullAccess" } },
        },
      ],
    });
    expect(() => review(fullAccess)).toThrow("Only a limited drawing key");

    const otherKey = addKeyTransaction({
      actions: [
        {
          type: "AddKey",
          params: {
            publicKey: "ed25519:" + "3".repeat(43),
            accessKey: {
              nonce: 0,
              permission: {
                receiverId: board,
                allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
                methodNames: [...DRAWING_SESSION_METHODS],
              },
            },
          },
        },
      ],
    });
    expect(() => review(otherKey)).toThrow(
      "Drawing authorization does not match the request pending in the game.",
    );

    const wildcardMethods = addKeyTransaction({
      actions: [
        {
          type: "AddKey",
          params: {
            publicKey: addedKey,
            accessKey: {
              nonce: 0,
              permission: { receiverId: board, allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO },
            },
          },
        },
      ],
    });
    expect(() => review(wildcardMethods)).toThrow("A drawing key must use the board contract");

    const tooMuchAllowance = addKeyTransaction({
      actions: [
        {
          type: "AddKey",
          params: {
            publicKey: addedKey,
            accessKey: {
              nonce: 0,
              permission: {
                receiverId: board,
                allowance: "250000000000000000000001",
                methodNames: [...DRAWING_SESSION_METHODS],
              },
            },
          },
        },
      ],
    });
    expect(() => review(tooMuchAllowance)).toThrow("A drawing key must use the board contract");

    const otherAccount = addKeyTransaction({ receiverId: other });
    expect(() => review(otherAccount)).toThrow(
      "A drawing key can only be added to your own account.",
    );
  });

  it("reviews a renewal that adds the new key and retires the old one in the same transaction", () => {
    const oldKey = "ed25519:" + "4".repeat(43);
    const renewal = addKeyTransaction({
      actions: [
        ...addKeyTransaction().actions,
        { type: "DeleteKey", params: { publicKey: oldKey } },
      ],
    });
    const result = review(renewal, pending, oldKey);
    expect(result.title).toBe("Let this browser paint for you");
    const values = result.rows.map((r) => `${r.label}: ${r.value}`);
    expect(values).toContain("Adds: A drawing key for this browser");
    expect(values).toContain("Remove: This browser's painting key");
  });
});
