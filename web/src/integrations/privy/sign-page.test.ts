// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPrivySignPage } from "./sign-page";
import {
  setPrivyHostIdentity,
  setPrivyPendingDrawingAuthorization,
} from "./session";
import { buildAddFunctionCallKeyParams } from "../../drawing-session";
import type { PrivyPageRuntime } from "./runtime";
import type { PrivyConfig } from "./config";

const address = "12".repeat(32);
const wallet = { type: "wallet", chain_type: "near", id: "wallet-1", address };
const config: PrivyConfig = {
  appId: "app-id",
  clientId: "client-id",
  network: "testnet",
  origin: "http://localhost:5173",
  signPageUrl: "http://localhost:5173/privy-sign.html",
  rpcUrl: "https://rpc.testnet.near.org",
};
const host = {
  accountId: address,
  networkId: "testnet" as const,
  sessionEpoch: 1,
};
const payload = {
  kind: "signAndSendTransaction",
  network: "testnet",
  receiverId: "wrap.testnet",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "near_deposit",
        args: {},
        deposit: "1",
        gas: "30000000000000",
      },
    },
  ],
};
const pages: Array<{ dispose(): void }> = [];
afterEach(() => {
  pages.forEach((p) => p.dispose());
  pages.length = 0;
  document.body.replaceChildren();
  localStorage.clear();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(
  request: unknown = payload,
  user: unknown = { linked_accounts: [wallet] },
) {
  setPrivyHostIdentity(host, localStorage);
  const sign = vi.fn().mockResolvedValue(undefined);
  const runtime: PrivyPageRuntime = {
    initialize: vi.fn().mockResolvedValue(undefined),
    handshake: vi.fn().mockResolvedValue({
      payload: request,
      targetOrigin: config.origin,
      sign,
    }),
    user: { get: vi.fn().mockResolvedValue({ user }) },
    createNearWallet: vi.fn(),
    logout: vi.fn(),
    sendEmailCode: vi.fn(),
    loginEmail: vi.fn(),
    googleUrl: vi.fn().mockResolvedValue("https://accounts.google.com/"),
    completeOAuth: vi.fn(),
    assertReady: vi.fn(),
    rejectBeforeBroadcast: vi.fn(),
    dispose: vi.fn(),
  };
  const root = document.createElement("main");
  document.body.append(root);
  const options = {
    config,
    runtime,
    storage: localStorage,
    boardContractId: "wall.testnet",
    location: { href: config.signPageUrl },
    navigate: vi.fn(),
    replaceUrl: vi.fn(),
    close: vi.fn(),
  };
  const page = mountPrivySignPage(root, options);
  pages.push(page);
  return { root, runtime, sign, page, options };
}
const button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  )!;

describe("standalone Privy approval page", () => {
  it("never auto-signs after restoring a valid session; approval rechecks identity and funds", async () => {
    const { root, runtime, sign, page } = setup();
    await page.ready;
    expect(sign).not.toHaveBeenCalled();
    expect(runtime.handshake).toHaveBeenLastCalledWith(wallet);
    button(root, "Approve").click();
    await flush();
    expect(runtime.assertReady).toHaveBeenCalledWith(wallet);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("rejects account changes while readiness checks are pending", async () => {
    const { root, runtime, sign, page } = setup();
    await page.ready;
    let finish!: () => void;
    vi.mocked(runtime.assertReady).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    button(root, "Approve").click();
    await flush();
    setPrivyHostIdentity({ ...host, sessionEpoch: 2 }, localStorage);
    finish();
    await flush();
    expect(sign).not.toHaveBeenCalled();
  });
  it("blocks expired provider auth at capital approval without touching local drawing keys", async () => {
    const { root, runtime, sign, page } = setup();
    await page.ready;
    localStorage.setItem("drawing-secret", "untouched");
    vi.mocked(runtime.user.get).mockResolvedValue({ user: null });
    button(root, "Approve").click();
    await flush();
    expect(sign).not.toHaveBeenCalled();
    expect(localStorage.getItem("drawing-secret")).toBe("untouched");
  });
  it("cannot retry an uncertain signature from the same approval page", async () => {
    const { root, sign, page } = setup();
    await page.ready;
    sign.mockRejectedValue(
      new Error("RPC response lost after possible broadcast"),
    );
    const approve = button(root, "Approve");
    approve.click();
    approve.click();
    await flush();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(button(root, "Approve")).toBeUndefined();
    expect(root.textContent).toContain("original operation");
  });
  it("rejects missing network before provisioning or showing auth buttons", async () => {
    const { root, runtime, sign, page } = setup({ kind: "signIn" }, null);
    await page.ready;
    expect(root.textContent).toContain("missing or different network");
    expect(runtime.createNearWallet).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(button(root, "Continue with Google")).toBeUndefined();
  });
  it("allows Google navigation only from the explicit button and login itself never signs", async () => {
    const { root, runtime, sign, page, options } = setup(
      { kind: "signIn", network: "testnet" },
      null,
    );
    await page.ready;
    expect(options.navigate).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    button(root, "Continue with Google").click();
    await flush();
    expect(runtime.googleUrl).toHaveBeenCalledTimes(1);
    expect(options.navigate).toHaveBeenCalledWith(
      "https://accounts.google.com/",
    );
  });
  it("cleans OAuth code/state from the callback URL even when verification fails", async () => {
    const { runtime, page, options } = setup(
      { kind: "signIn", network: "testnet" },
      null,
    );
    options.location.href += "?privy_oauth_code=secret&privy_oauth_state=state";
    vi.mocked(runtime.completeOAuth).mockRejectedValue(new Error("expired"));
    await page.ready;
    expect(options.replaceUrl).toHaveBeenCalledWith(config.signPageUrl);
  });
  it("authorizes the exact new pending AddKey without depending on the old stored drawing key", async () => {
    const key = buildAddFunctionCallKeyParams(
      "wall.testnet",
      "ed25519:11111111111111111111111111111111",
    );
    const { root, sign, page, options } = setup({
      kind: "signIn",
      network: "testnet",
      addFunctionCallKey: key,
    });
    Object.assign(options, { drawingPublicKey: "ed25519:old-key" });
    setPrivyPendingDrawingAuthorization(
      {
        ...host,
        publicKey: key.publicKey,
        contractId: "wall.testnet",
        methods: ["draw", "draw_many"],
        allowance: key.gasAllowance.amount,
        createdAtMs: Date.now(),
      },
      localStorage,
    );
    await page.ready;
    expect(root.textContent).toContain("Authorize drawing");
    button(root, "Approve").click();
    await flush();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(button(root, "Approve")).toBeUndefined();
  });
  it("rechecks that pending AddKey still belongs to the current host epoch before signing", async () => {
    const key = buildAddFunctionCallKeyParams(
      "wall.testnet",
      "ed25519:11111111111111111111111111111111",
    );
    const { root, sign, page } = setup({
      kind: "signIn",
      network: "testnet",
      addFunctionCallKey: key,
    });
    const pending = {
      ...host,
      publicKey: key.publicKey,
      contractId: "wall.testnet",
      methods: ["draw", "draw_many"],
      allowance: key.gasAllowance.amount,
      createdAtMs: Date.now(),
    };
    setPrivyPendingDrawingAuthorization(pending, localStorage);
    await page.ready;
    setPrivyPendingDrawingAuthorization(
      { ...pending, sessionEpoch: 2 },
      localStorage,
    );
    button(root, "Approve").click();
    await flush();
    expect(sign).not.toHaveBeenCalled();
  });
  it("emits a trusted rejection only for explicit Cancel before signing", async () => {
    const { root, runtime, sign, page, options } = setup();
    await page.ready;
    button(root, "Cancel").click();
    expect(sign).not.toHaveBeenCalled();
    expect(runtime.rejectBeforeBroadcast).toHaveBeenCalledOnce();
    expect(runtime.rejectBeforeBroadcast).toHaveBeenCalledWith(config.origin);
    expect(options.close).toHaveBeenCalledOnce();
  });

  it("never labels a possible broadcast as unsent when Cancel is clicked after signing fails", async () => {
    const { root, runtime, sign, page, options } = setup();
    await page.ready;
    sign.mockRejectedValue(new Error("Lost response after possible broadcast"));
    button(root, "Approve").click();
    await flush();
    button(root, "Cancel").click();
    expect(sign).toHaveBeenCalledOnce();
    expect(runtime.rejectBeforeBroadcast).not.toHaveBeenCalled();
    expect(options.close).toHaveBeenCalledOnce();
  });

  it("ignores even a dispatched Cancel event while signing is in progress", async () => {
    const { root, runtime, sign, page, options } = setup();
    await page.ready;
    let finish!: () => void;
    sign.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    button(root, "Approve").click();
    await flush();
    button(root, "Cancel").dispatchEvent(new Event("click"));
    expect(runtime.rejectBeforeBroadcast).not.toHaveBeenCalled();
    expect(options.close).not.toHaveBeenCalled();
    finish();
    await flush();
  });

  it("disposal aborts provider resources and a late completion cannot sign", async () => {
    const { root, runtime, sign, page } = setup();
    await page.ready;
    page.dispose();
    expect(runtime.dispose).toHaveBeenCalled();
    expect(root.childElementCount).toBe(0);
    expect(sign).not.toHaveBeenCalled();
  });
});
