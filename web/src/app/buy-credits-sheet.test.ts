/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "./services";

const sendToken = vi.fn();
const sendNear = vi.fn();

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
    PAGE_NETWORK: "testnet",
  };
});

vi.mock("../wallet", () => ({
  signAndSendBuyCreditsNear: (...args: unknown[]) => sendNear(...args),
  signAndSendBuyCreditsToken: (...args: unknown[]) => sendToken(...args),
}));

import { viewFunction } from "../contract";
import { formatResetTime, mountBuyCreditsSheet } from "./buy-credits-sheet";

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

  it("does not offer the token payment path before the board reports open sales", () => {
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
      "near.com",
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

// ---- FE-4: token (mPOO) checkout, feature-detected per board ----------------

const NEAR_PRICE = "2500000000000000000000";
// Not a round number, and above 2^53, so a float multiplication would show.
const TOKEN_PRICE = "1234567890123456789";
const RESETS_AT_NS = "1793750400000000000"; // 2026-11-04T00:00:00Z

type SalesFixture = Record<string, string> | "missing";

function sales(remaining: string, cap = "20000"): Record<string, string> {
  return {
    day_index: "20760",
    sold_today: "0",
    cap,
    remaining,
    resets_at_ns: RESETS_AT_NS,
  };
}

function connectedServices(): AppServices {
  const base = services();
  return {
    ...base,
    wallet: {
      ...base.wallet,
      getSession: () => ({ accountId: "alice.testnet", networkId: "testnet" }),
    },
  };
}

function chain(state: { sales: () => SalesFixture; credits: () => string | null }): void {
  vi.mocked(viewFunction).mockImplementation(async (method: string) => {
    if (method === "get_payment_config") {
      return {
        mpoo_token: "metapoo-mpoo.testnet",
        near_per_credit: NEAR_PRICE,
        mpoo_per_credit: TOKEN_PRICE,
        registration_fee: "10000000000000000000000",
      };
    }
    if (method === "get_credits") return state.credits();
    if (method === "get_mpoo_sales_today") {
      const value = state.sales();
      if (value === "missing") {
        // What an old (pre-REV-B) board answers.
        throw new Error("wasm execution failed: MethodNotFound");
      }
      return value;
    }
    throw new Error(`unexpected view ${method}`);
  });
}

const readTokenMetadata = async () => ({ symbol: "tPOO", decimals: 18 });

async function mountOpen(
  svc: AppServices,
  extra: Parameters<typeof mountBuyCreditsSheet>[2] = {},
): Promise<{ host: HTMLElement; sheet: ReturnType<typeof mountBuyCreditsSheet> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const sheet = mountBuyCreditsSheet(host, svc, { readTokenMetadata, ...extra });
  sheet.setVisible(true);
  sheet.open({ quantity: 3 });
  await vi.waitFor(() => {
    expect(host.querySelector("[data-buy=price]")?.textContent).toMatch(/NEAR \/ credit/);
  });
  return { host, sheet };
}

function pickToken(host: HTMLElement): void {
  const radio = host.querySelector<HTMLInputElement>('input[name="buy-asset"][value="token"]')!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
}

describe("mountBuyCreditsSheet — token checkout (FE-4)", () => {
  afterEach(() => {
    sendToken.mockReset();
    document.body.replaceChildren();
  });

  it("hides the token path when get_mpoo_sales_today is missing (old board)", async () => {
    chain({ sales: () => "missing", credits: () => "12" });
    const { host, sheet } = await mountOpen(services());
    expect(host.querySelector("[data-buy=token-option]")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-buy=token-info]")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-buy=buy-near]")?.hasAttribute("hidden")).toBe(false);
    sheet.dispose();
  });

  it("hides the token path when the cap is 0 (sales closed)", async () => {
    chain({ sales: () => sales("0", "0"), credits: () => "12" });
    const { host, sheet } = await mountOpen(services());
    expect(host.querySelector("[data-buy=token-option]")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-buy=buy-near]")?.hasAttribute("hidden")).toBe(false);
    sheet.dispose();
  });

  it("hides the token path when today's remaining is 0", async () => {
    chain({ sales: () => sales("0"), credits: () => "12" });
    const { host, sheet } = await mountOpen(services());
    expect(host.querySelector("[data-buy=token-option]")?.hasAttribute("hidden")).toBe(true);
    sheet.dispose();
  });

  it("labels the token by its metadata symbol and shows discount, remaining and reset", async () => {
    chain({ sales: () => sales("5"), credits: () => "12" });
    const { host, sheet } = await mountOpen(services());
    expect(host.querySelector("[data-buy=token-option]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector("[data-buy=token-label]")?.textContent).toBe("tPOO");
    const info = host.querySelector("[data-buy=token-info]")!;
    expect(info.hasAttribute("hidden")).toBe(false);
    expect(info.textContent).toContain("20% holder discount");
    expect(info.textContent).toContain("set weekly");
    expect(info.textContent).toContain("5 tPOO credits left today");
    expect(info.textContent).toContain(`resets ${formatResetTime(BigInt(RESETS_AT_NS))}`);
    expect(host.textContent).not.toMatch(/mPOO/);
    sheet.dispose();
  });

  it("sends the exact integer token amount for N credits", async () => {
    let credits = "12";
    chain({ sales: () => sales("5"), credits: () => credits });
    sendToken.mockImplementation(async (args: { amount: string }) => {
      credits = "15";
      return {
        transaction: { hash: "tx-ok" },
        status: { SuccessValue: btoa(JSON.stringify(args.amount)) },
        receipts_outcome: [],
      };
    });
    const settled = vi.fn();
    const { host, sheet } = await mountOpen(connectedServices(), { onPurchaseSettled: settled });
    pickToken(host);
    // 3 × 1234567890123456789 = 3703703670370370367 (18 decimals)
    expect(host.querySelector("[data-buy=pay]")?.textContent).toBe(
      "Pay 3.703703670370370367 tPOO",
    );
    host.querySelector<HTMLButtonElement>("[data-buy=pay]")!.click();
    await vi.waitFor(() => expect(sendToken).toHaveBeenCalledTimes(1));
    const args = sendToken.mock.calls[0][0] as {
      tokenContractId: string;
      amount: string;
      msg: string;
      deposit: string;
      gas: string;
    };
    expect(args.tokenContractId).toBe("metapoo-mpoo.testnet");
    expect(args.amount).toBe("3703703670370370367");
    expect(JSON.parse(args.msg)).toEqual({ min_credits: "3", expected_price: TOKEN_PRICE });
    expect(args.deposit).toBe("1");
    expect(BigInt(args.gas)).toBeGreaterThanOrEqual(100_000_000_000_000n);
    await vi.waitFor(() => {
      expect(host.querySelector("[data-buy=balance]")?.textContent).toBe("Credits: 15");
    });
    expect(settled).toHaveBeenCalledTimes(1);
    sheet.dispose();
  });

  it("clamps the token quantity to today's remaining and offers NEAR for the rest", async () => {
    chain({ sales: () => sales("5"), credits: () => "12" });
    const { host, sheet } = await mountOpen(services());
    const qty = host.querySelector<HTMLInputElement>("#buy-credits-qty")!;
    qty.value = "8";
    pickToken(host);
    expect(qty.value).toBe("5");
    const split = host.querySelector("[data-buy=split]")!;
    expect(split.hasAttribute("hidden")).toBe(false);
    expect(split.textContent).toContain("Only 5 tPOO credits left today");
    const toNear = host.querySelector<HTMLButtonElement>("[data-buy=split-near]")!;
    expect(toNear.textContent).toBe("Buy the other 3 with NEAR");
    toNear.click();
    expect(qty.value).toBe("3");
    expect(host.querySelector<HTMLInputElement>('input[value="near"]')!.checked).toBe(true);
    expect(host.querySelector("[data-buy=pay]")?.textContent).toBe("Pay 0.0075 NEAR");
    sheet.dispose();
  });

  it("a cap-reached refund leaves credits unchanged, explains it and offers NEAR", async () => {
    let remaining = "5";
    chain({ sales: () => sales(remaining), credits: () => "12" });
    sendToken.mockImplementation(async () => {
      remaining = "0"; // someone else bought the last credits first
      return {
        transaction: { hash: "tx-refund" },
        status: { SuccessValue: btoa('"0"') },
        receipts_outcome: [
          { outcome: { logs: ["purchase_rejected: MpooDailyCapReached"] } },
        ],
      };
    });
    const settled = vi.fn();
    const changed = vi.fn();
    const { host, sheet } = await mountOpen(connectedServices(), {
      onPurchaseSettled: settled,
      onCreditsChanged: changed,
    });
    pickToken(host);
    host.querySelector<HTMLButtonElement>("[data-buy=pay]")!.click();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-buy=token-option]")?.hasAttribute("hidden")).toBe(true);
    });
    const status = host.querySelector("[data-buy=status]")?.textContent ?? "";
    expect(status).toMatch(/sold out/);
    expect(status).toMatch(/sent back.*pay with NEAR/);
    expect(host.querySelector("[data-buy=balance]")?.textContent).toBe("Credits: 12");
    expect(changed.mock.calls.length).toBeGreaterThan(0);
    expect(changed.mock.calls.every(([balance]) => balance === 12n)).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('input[value="near"]')!.checked).toBe(true);
    expect(host.querySelector("[data-buy=pay]")?.textContent).toMatch(/NEAR$/);
    expect(host.querySelector("[data-buy=buy-near]")?.hasAttribute("hidden")).toBe(false);
    sheet.dispose();
  });
});
