/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "./services";

vi.mock("../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contract")>();
  return {
    ...actual,
    viewFunction: vi.fn(),
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    CONTRACT_ID: "board3.metapoo-player1.testnet",
  };
});

import { viewFunction } from "../contract";
import { mountBuyCreditsSheet } from "./buy-credits-sheet";

function services(): AppServices {
  return {
    wallet: {
      getSession: () => ({ accountId: null, networkId: null }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: () => () => undefined,
      whenReady: Promise.resolve({ accountId: null, networkId: null }),
    },
    operations: {
      list: () => [],
      get: () => undefined,
      upsert: vi.fn(),
      listRecoverable: () => [],
      subscribe: () => () => undefined,
    },
  };
}

afterEach(() => {
  vi.mocked(viewFunction).mockReset();
});

describe("mountBuyCreditsSheet", () => {
  it("keeps quantity, total and pay controls in the dock panel", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const sheet = mountBuyCreditsSheet(host, services());
    sheet.setVisible(true);
    sheet.open({ quantity: 10 });
    const panel = host.querySelector(".buy-credits-panel");
    expect(panel).not.toBeNull();
    expect(host.querySelector("#buy-credits-qty")).not.toBeNull();
    expect(host.querySelector("[data-buy=pay]")).not.toBeNull();
    expect(host.querySelector("[data-buy=lines]")).not.toBeNull();
    expect(host.textContent).toMatch(/Buy credits/);
    sheet.dispose();
    host.remove();
  });

  it("does not offer the token payment path at launch", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const sheet = mountBuyCreditsSheet(host, services());
    sheet.setVisible(true);
    sheet.open({ quantity: 10 });
    const tokenOption = host.querySelector("[data-buy=token-option]");
    expect(tokenOption).not.toBeNull();
    expect(tokenOption?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-buy=nearly]")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-buy=buy-near]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector<HTMLAnchorElement>("[data-buy=buy-near]")?.href).toContain(
      "near.org",
    );
    sheet.dispose();
    host.remove();
  });

  it("does not open when the board is not marked paid", () => {
    const host = document.createElement("div");
    const sheet = mountBuyCreditsSheet(host, services());
    sheet.setVisible(false);
    sheet.open({ quantity: 5 });
    expect(host.querySelector(".buy-credits-sheet")?.hasAttribute("hidden")).toBe(true);
    sheet.dispose();
  });

  it("shows Retry price when get_payment_config fails", async () => {
    vi.mocked(viewFunction).mockRejectedValue(new Error("rpc down"));
    const host = document.createElement("div");
    document.body.append(host);
    const sheet = mountBuyCreditsSheet(host, services());
    sheet.setVisible(true);
    sheet.open({ quantity: 10 });
    await vi.waitFor(() => {
      expect(host.querySelector("[data-buy=price]")?.textContent).toMatch(/unavailable/i);
    });
    expect(host.querySelector("[data-buy=retry-price]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector("[data-buy=status]")?.textContent).toMatch(/payment config/i);
    sheet.dispose();
    host.remove();
  });
});
