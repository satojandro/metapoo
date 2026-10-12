/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createDrawRequest } from "../../draw-request";
import { createRouter } from "../../app/router";
import { clearPageMounts, registerPageMount } from "../../app/page-registry";
import { matchRoute } from "../../app/routes";
import { buildHelpPaintDeepLink } from "../bounties/deep-link";
import {
  mountWall,
  mountWallPage,
  type WallMountTestApi,
} from "./mount-wall";

vi.mock("../../submit-draw", () => ({
  submitDraw: vi.fn(),
}));

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    // Allow prepareDraw past ContractNotConfigured without a live deployment.
    CONTRACT_ID: "board.test.near",
  };
});

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    getBoard: vi.fn(async () => ({
      schema_version: 2,
      width: 128,
      height: 128,
      origin: "top-left",
      overwrite_rule: "open_wall",
      sponsorship_enabled: false,
      palette: [
        { index: 0, name: "Ink", hex: "#1c1917" },
        { index: 1, name: "Paper", hex: "#f4efe4" },
        { index: 2, name: "Brick", hex: "#b23a2f" },
        { index: 3, name: "Marigold", hex: "#e0a100" },
        { index: 4, name: "Moss", hex: "#3d7a4a" },
        { index: 5, name: "River", hex: "#2f6f8f" },
        { index: 6, name: "Grape", hex: "#6b4c7a" },
        { index: 7, name: "Clay", hex: "#c47b5a" },
      ],
    })),
    fetchAllPaintedPixels: vi.fn(async () => ({
      pixels: [],
      blockHeight: 1,
    })),
    getPixelWithBlock: vi.fn(async (x: number, y: number) => ({
      pixel: {
        x,
        y,
        colorIndex: null,
        artistAccountId: null,
        lastWriteTimestampNs: null,
      },
      blockHeight: 1,
    })),
  };
});

import { submitDraw } from "../../submit-draw";

describe("mountWall dispose", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    vi.mocked(submitDraw).mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("clears the wall DOM and does not clear shared operations", () => {
    const services = createAppServices();
    services.operations.upsert({
      id: "paint:keep",
      kind: "paint",
      phase: "submitted",
      accountId: "alice.testnet",
      networkId: "testnet",
      transactionId: "tx-keep",
      title: "Paint",
      detail: "must survive dispose",
    });

    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    expect(root.querySelector("#board")).not.toBeNull();
    expect(root.querySelector("#palette")).not.toBeNull();

    dispose();
    expect(root.querySelector("#board")).toBeNull();
    expect(root.childElementCount).toBe(0);
    expect(services.operations.listRecoverable()).toHaveLength(1);
    expect(services.operations.get("paint:keep")?.transactionId).toBe("tx-keep");
  });

  it("is safe to call dispose twice", () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it("clears unsent queue paints when navigating away during a pending draw", async () => {
    type DrawResult = Awaited<ReturnType<typeof submitDraw>>;
    const deferred: {
      promise: Promise<DrawResult>;
      resolve: (value: DrawResult) => void;
    } = {
      promise: null as unknown as Promise<DrawResult>,
      resolve: () => undefined,
    };
    deferred.promise = new Promise<DrawResult>((resolve) => {
      deferred.resolve = resolve;
    });
    vi.mocked(submitDraw).mockImplementation(() => deferred.promise);

    let api: WallMountTestApi | null = null;
    const root = document.querySelector<HTMLElement>("#root")!;

    // Wallet stub with a stable account so drawRequestMatchesSession passes.
    const stubServices = createAppServices();
    let accountId: string | null = "alice.testnet";
    let networkId: string | null = "testnet";
    const listeners = new Set<(s: { accountId: string | null; networkId: string | null }) => void>();
    stubServices.wallet = {
      getSession: () => ({ accountId, networkId }),
      connect: async () => {
        accountId = "alice.testnet";
        networkId = "testnet";
        for (const listener of listeners) {
          listener({ accountId, networkId });
        }
      },
      disconnect: async () => {
        accountId = null;
        networkId = null;
        for (const listener of listeners) {
          listener({ accountId, networkId });
        }
      },
      subscribe: (listener) => {
        listeners.add(listener);
        listener({ accountId, networkId });
        return () => listeners.delete(listener);
      },
    };

    const dispose = mountWall(root, stubServices, {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });
    expect(api).not.toBeNull();
    // Let bootstrapBoard finish so contractMetaOk is true.
    await vi.waitFor(() => {
      expect(root.querySelector("#board-load-status")?.textContent ?? "").not.toMatch(
        /fetching painted pages/i,
      );
    });

    const req = (x: number) =>
      createDrawRequest({
        x,
        y: 0,
        colorIndex: 2,
        accountId: "alice.testnet",
        networkId: "testnet",
      });

    api!.enqueueUnsent(req(1));
    api!.enqueueUnsent(req(2));
    api!.enqueueUnsent(req(3));
    expect(api!.queueLength()).toBe(3);

    const drainPromise = api!.kickDrain();
    // First item shifted and in flight; two remain queued.
    await vi.waitFor(() => {
      expect(vi.mocked(submitDraw).mock.calls.length).toBe(1);
    });
    expect(api!.queueLength()).toBe(2);

    // Navigate away / dispose while the first paint is still pending.
    dispose();
    expect(api!.queueLength()).toBe(0);

    deferred.resolve({
      status: "confirmation_delayed",
      title: "Delayed",
      message: "Still confirming",
      transactionId: "tx-pending-1",
      explorerUrl: null,
      pixel: null,
      observedBlockHeight: null,
    });
    await drainPromise;
    await Promise.resolve();

    // Remaining paints must not have been submitted after dispose.
    expect(vi.mocked(submitDraw).mock.calls.length).toBe(1);
    expect(
      stubServices.operations.list().some((op) => op.transactionId === "tx-pending-1"),
    ).toBe(true);
  });
});

describe("mountWall Help-paint deep link via router", () => {
  beforeEach(() => {
    clearPageMounts();
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="outlet"></div>
    `;
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    clearPageMounts();
    document.body.innerHTML = "";
  });

  it("applies bounty Help-paint coordinates through the actual router", () => {
    registerPageMount("home", (root) => {
      root.textContent = "home";
      return () => root.replaceChildren();
    });
    registerPageMount("wall", mountWallPage);

    const services = createAppServices();
    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services });
    router.start();

    const href = buildHelpPaintDeepLink({
      board: "board.mpoo.testnet",
      x: 40,
      y: 20,
      zoom: 16,
      bounty: "7",
      template: "tmpl-demo",
    });
    router.navigate(href);

    expect(matchRoute(window.location.pathname, window.location.search).pageId).toBe(
      "wall",
    );
    const summary = outlet.querySelector("#selection-summary");
    expect(summary?.textContent).toMatch(/Selected square x=40, y=20/);
    const status = outlet.querySelector("#board-load-status");
    expect(status?.textContent).toMatch(/Bounty context 7/);
    expect(status?.textContent).toMatch(/Template id tmpl-demo/);

    router.stop();
  });
});
