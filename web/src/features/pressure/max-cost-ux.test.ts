import { describe, expect, it } from "vitest";
import { createDrawRequest } from "../../draw-request";
import {
  PRICE_CHANGED_MESSAGE,
  PRICE_CHANGED_TITLE,
  checkMaxCostAuthorization,
  queueStopMessage,
  revalidateQueuedPaint,
} from "./max-cost-ux";

describe("max-cost rejection UX helpers", () => {
  const nowNs = "100000000000";
  const expiresAtNs = "130000000000";

  it("accepts a quote at or below the authorized max", () => {
    expect(
      checkMaxCostAuthorization({
        quotedCost: "10",
        maxCost: "10",
        quoteExpiresAtNs: expiresAtNs,
        nowNs,
      }),
    ).toEqual({ ok: true });
    expect(
      checkMaxCostAuthorization({
        quotedCost: "9",
        maxCost: "10",
        quoteExpiresAtNs: expiresAtNs,
        nowNs,
      }),
    ).toEqual({ ok: true });
  });

  it("requires fresh intent when price rises above max (never silent raise)", () => {
    const result = checkMaxCostAuthorization({
      quotedCost: "12",
      maxCost: "10",
      quoteExpiresAtNs: expiresAtNs,
      nowNs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("price_above_max");
      expect(result.title).toBe(PRICE_CHANGED_TITLE);
      expect(result.message).toBe(PRICE_CHANGED_MESSAGE);
      expect(result.title).toMatch(/Price changed/);
    }
  });

  it("rejects expired quotes before comparing cost", () => {
    const result = checkMaxCostAuthorization({
      quotedCost: "10",
      maxCost: "10",
      quoteExpiresAtNs: "90000000000",
      nowNs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("quote_expired");
    }
  });

  it("rejects pricing version drift", () => {
    const result = checkMaxCostAuthorization({
      quotedCost: "10",
      maxCost: "10",
      quoteExpiresAtNs: expiresAtNs,
      nowNs,
      quotePricingVersion: "pressure-v2",
      authorizedPricingVersion: "pressure-v1-fixture",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version_mismatch");
    }
  });

  it("revalidateQueuedPaint passes free-board items without maxCost", () => {
    const request = createDrawRequest({
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      networkId: "testnet",
    });
    expect(
      revalidateQueuedPaint({
        request,
        quotedCost: "99",
        quoteExpiresAtNs: expiresAtNs,
        nowNs,
        paidMode: true,
      }),
    ).toEqual({ ok: true });
  });

  it("revalidateQueuedPaint stops paid queue items when cost rose", () => {
    const request = createDrawRequest({
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      networkId: "testnet",
      maxCost: "10",
      expiresAtNs,
      pricingVersion: "pressure-v1-fixture",
    });
    const result = revalidateQueuedPaint({
      request,
      quotedCost: "15",
      quoteExpiresAtNs: expiresAtNs,
      nowNs,
      quotePricingVersion: "pressure-v1-fixture",
      paidMode: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toBe(PRICE_CHANGED_TITLE);
    }
  });

  it("explains queue stop reasons for account/session/dispose", () => {
    expect(queueStopMessage("disposed")).toMatch(/Left the wall/);
    expect(queueStopMessage("account_changed")).toMatch(/account changed/i);
    expect(queueStopMessage("session_changed")).toMatch(/session changed/i);
    expect(queueStopMessage("price_above_max")).toBe(PRICE_CHANGED_MESSAGE);
  });
});
