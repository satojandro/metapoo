/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import { mountBuyCreditsSheet } from "./buy-credits-sheet";
import type { AppServices } from "./services";

function services(): AppServices {
  return {
    wallet: {
      getSession: () => ({ accountId: null, networkId: null }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: () => () => undefined,
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
    // Registration copy appears only after a null credits quote renders.
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
    // Buying with mPOO is a later phase: the exchange rate is undecided, so the
    // radio must be out of reach even before a config read runs.
    expect(tokenOption?.hasAttribute("hidden")).toBe(true);
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
});
