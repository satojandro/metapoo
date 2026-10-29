/**
 * @vitest-environment happy-dom
 *
 * Pins #29: after a confirmed paint on a paid board, the credits dock must
 * re-read get_credits. Before the fix it only refreshed on wallet change /
 * shortfall, so the UI stayed at the pre-spend balance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createDrawRequest } from "../../draw-request";
import { mountWall, type WallMountTestApi } from "./mount-wall";

vi.mock("../../submit-draw", () => ({
  submitDraw: vi.fn(),
}));

vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    canUseLocalDrawingSession: vi.fn(() => false),
    fetchDrawingSessionAllowance: vi.fn(async () => ({
      found: true,
      remainingYocto: null,
      permissionSummary: "",
    })),
    signAndSendStrokeLocally: vi.fn(async () => ({
      status: "confirmed",
      confirmedChunks: 1,
      totalChunks: 1,
      outcomes: [],
      failingChunk: null,
    })),
  };
});

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    CONTRACT_ID: "board3.metapoo-player1.testnet",
  };
});

const creditReads: Array<string | number> = [];

vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return {
    ...actual,
    isContractConfigured: () => true,
    getBoard: vi.fn(async () => ({
      schema_version: 4,
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
    getPixel: vi.fn(async () => ({
      x: 0,
      y: 0,
      colorIndex: null,
      artistAccountId: null,
      lastWriteTimestampNs: null,
    })),
    viewFunction: vi.fn(async (method: string) => {
      if (method === "get_credits") {
        const next = creditReads.shift();
        return next === undefined ? "10" : next;
      }
      if (method === "get_cell_cost") {
        return 1;
      }
      if (method === "get_tunables") {
        return {
          repaint_mid_ns: String(3_600_000_000_000),
          repaint_base_credits: 1,
        };
      }
      if (method === "get_payment_config") {
        return {
          mpoo_token: "metapoo-mpoo.testnet",
          near_per_credit: "2500000000000000000000",
          mpoo_per_credit: "1000000000000000000",
        };
      }
      throw new Error(`unexpected view ${method}`);
    }),
  };
});

import { submitDraw } from "../../submit-draw";

describe("credits dock refresh after paint", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    creditReads.length = 0;
    vi.mocked(submitDraw).mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("updates Credits after a confirmed paint spends one credit", async () => {
    // Initial dock refresh + ensurePaidQuote credits check + post-paint refresh.
    creditReads.push("10", "10", "9");
    vi.mocked(submitDraw).mockResolvedValue({
      status: "confirmed",
      title: "Paint confirmed",
      message: "Confirmed",
      transactionId: "tx-1",
      explorerUrl: "https://example.test/tx-1",
      pixel: {
        x: 1,
        y: 2,
        colorIndex: 3,
        artistAccountId: "alice.testnet",
        lastWriteTimestampNs: "1",
      },
      observedBlockHeight: 2,
    });

    const services = createAppServices();
    services.wallet = {
      getSession: () => ({ accountId: "alice.testnet", networkId: "testnet" }),
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: (listener) => {
        listener({ accountId: "alice.testnet", networkId: "testnet" });
        return () => undefined;
      },
      whenReady: Promise.resolve({
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    };

    let api: WallMountTestApi | null = null;
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services, {
      attachTestApi: (testApi) => {
        api = testApi;
      },
    });

    await vi.waitFor(() => {
      expect(root.querySelector("#credits-balance")?.textContent).toMatch(/Credits: 10/);
    });

    expect(api).not.toBeNull();
    api!.enqueueUnsent(
      createDrawRequest({
        x: 1,
        y: 2,
        colorIndex: 3,
        accountId: "alice.testnet",
        networkId: "testnet",
      }),
    );
    await api!.kickDrain();

    await vi.waitFor(() => {
      expect(root.querySelector("#credits-balance")?.textContent).toMatch(/Credits: 9/);
    });

    dispose();
  });
});
