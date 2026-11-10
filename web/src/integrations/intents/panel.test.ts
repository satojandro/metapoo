// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountIntentsFundingPanel } from "./panel";
import { createIntentsFundingController } from "./funding";
import { createIntentsStorage } from "./storage";
import {
  FIXTURE_CONTEXT,
  FIXTURE_REFUND,
  FIXTURE_TIME,
  FIXTURE_TOKEN,
  fixtureQuote,
  fixtureStatus,
} from "./fixtures";
import type { FundingClient, FundingPolicy, FundingStatus } from "./types";
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,fixture") },
}));

const cleanups: (() => void)[] = [];
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
beforeEach(() => {
  // happy-dom has no Web Locks implementation; fixture only, never a runtime bypass.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        run: (lock: object) => unknown,
      ) => run({ name: "fixture-capital-lock" }),
    },
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.replaceChildren();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
});

function app(enabled = true, testMode = false, tokens = [FIXTURE_TOKEN]) {
  let now = FIXTURE_TIME;
  let context = { ...FIXTURE_CONTEXT };
  let providerStatus: FundingStatus["status"] = "PROCESSING";
  const data = new Map<string, string>();
  const client: FundingClient = {
    tokens: async () => tokens,
    verify: async () => true,
    quote: async (request) => fixtureQuote(request),
    status: async (quote) => fixtureStatus(quote, providerStatus),
  };
  const policy: FundingPolicy = {
    enabled,
    transportVerified: true,
    deliveryMode: "native",
    nativeDeliveryEvidence: {
      reference: "fixture",
      initializedNamed: true,
      initializedImplicit: false,
      uninitializedImplicit: false,
    },
    sourceAllowlist: tokens.map((t) => ({ assetId: t.assetId, blockchain: t.blockchain })),
    playReserveYocto: "1000",
  };
  const controller = createIntentsFundingController({
    client,
    poll: false,
    policy,
    now: () => now,
    storage: createIntentsStorage({
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
    }),
    currentContext: () => context,
    readReadiness: async () => ({ state: "ready", expectedKeyMatches: true }),
    reconcileDestination: async () => ({ state: "pending" }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const newContext = vi.fn(() => {
    context = { ...context, operationId: "next-payment" };
    return context;
  });
  cleanups.push(
    mountIntentsFundingPanel(host, controller, {
      getContext: () => context,
      newContext,
      testMode,
    }),
  );
  return {
    host,
    controller,
    newContext,
    setTime: (value: number) => {
      now = value;
    },
    setStatus: (value: FundingStatus["status"]) => {
      providerStatus = value;
    },
  };
}

describe("Intents inline panel", () => {
  it("says the route is unproven when the owner runs test mode, and says nothing otherwise", () => {
    expect(app(true, true).host.textContent).toContain("TEST MODE");
    expect(app(true, true).host.textContent).toContain("not verified yet");
    expect(app(true, false).host.textContent).not.toContain("TEST MODE");
  });
  it("picks an asset first, then a network, with USDT0 listed under USDT", async () => {
    const token = (symbol: string, blockchain: string, assetId: string) => ({
      ...FIXTURE_TOKEN, symbol, blockchain, assetId,
    });
    const { host } = app(true, false, [
      token("USDT0", "arb", "usdt-arb"),
      token("USDC", "sol", "usdc-sol"),
      token("USDT", "eth", "usdt-eth"),
      token("USDC", "eth", "usdc-eth"),
      token("ETH", "base", "eth-base"),
    ]);
    const pick = (label: string) =>
      host.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`)!;
    const texts = (label: string) =>
      Array.from(pick(label).options).map((o) => o.textContent);
    await vi.waitFor(() => expect(texts("Asset")).toEqual(["USDC", "USDT", "ETH"]));
    expect(texts("Source network")).toEqual(["Ethereum", "Solana"]);
    pick("Asset").value = "USDT";
    pick("Asset").dispatchEvent(new Event("change"));
    expect(texts("Source network")).toEqual(["Ethereum", "Arbitrum (USDT0)"]);
    pick("Source network").value = "usdt-arb";
    pick("Source network").dispatchEvent(new Event("change"));
    expect(host.querySelector(".mp-intents-amount-symbol")?.textContent).toBe("USDT0");
    expect(host.textContent).toContain("I control this address on Arbitrum");
  });
  it("retains read-only recovery when new funding is disabled", () => {
    const { host } = app(false);
    expect(host.textContent).toContain("not enabled");
    expect(host.textContent).toContain("Track saved payment");
    expect(host.querySelector("[role=status]")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(host.querySelector("[role=dialog]")).toBeNull();
  });
  it("shows source network, explicit memo warning and address-only QR only after persistence", async () => {
    const { host, controller } = app();
    await vi.waitFor(() =>
      expect(
        host.querySelectorAll("select[aria-label='Source network'] option"),
      ).toHaveLength(1),
    );
    const preview = await controller.preview(
      {
        assetId: FIXTURE_TOKEN.assetId,
        amount: "1",
        refundAddress: FIXTURE_REFUND,
        refundAddressConfirmed: true,
      },
      FIXTURE_CONTEXT,
    );
    expect(host.textContent).not.toContain("0x333333");
    await controller.commit(preview.preview!.correlationId, FIXTURE_CONTEXT);
    await vi.waitFor(() => expect(host.querySelector("img")).not.toBeNull());
    expect(host.textContent).toContain("on Base");
    expect(host.textContent).toContain("QR contains the address only");
    expect(host.textContent).toContain("Recovery ID: fixture-operation");
    expect(host.querySelector("img")?.alt).toContain("amount and memo");
  });
  it("does not copy expired payment details and removes the payable QR", async () => {
    const { host, controller, setTime } = app();
    await controller.loadAssets();
    const preview = await controller.preview(
      {
        assetId: FIXTURE_TOKEN.assetId,
        amount: "1",
        refundAddress: FIXTURE_REFUND,
        refundAddressConfirmed: true,
      },
      FIXTURE_CONTEXT,
    );
    await controller.commit(preview.preview!.correlationId, FIXTURE_CONTEXT);
    const copy = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy payment details",
    )!;
    const clipboard = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    setTime(FIXTURE_TIME + 30 * 60_000);
    copy.click();
    expect(clipboard).not.toHaveBeenCalled();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Sending instructions are hidden");
  });
  it("allocates a fresh operation only on explicit new funding after a terminal payment", async () => {
    const { host, controller, newContext, setStatus } = app();
    await controller.loadAssets();
    const preview = await controller.preview(
      {
        assetId: FIXTURE_TOKEN.assetId,
        amount: "1",
        refundAddress: FIXTURE_REFUND,
        refundAddressConfirmed: true,
      },
      FIXTURE_CONTEXT,
    );
    await controller.commit(preview.preview!.correlationId, FIXTURE_CONTEXT);
    const newButton = () =>
      Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === "Start another funding payment",
      )!;
    expect(newButton().hidden).toBe(true);
    expect(newContext).not.toHaveBeenCalled();
    setStatus("REFUNDED");
    await controller.refresh(FIXTURE_CONTEXT.operationId);
    expect(newButton().hidden).toBe(false);
    newButton().click();
    expect(newContext).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(controller.getState().phase).toBe("editing"));
    expect(controller.getState().operation).toBeUndefined();
    expect((host.querySelector("input") as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});
