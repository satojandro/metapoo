import { describe, expect, it } from "vitest";
import {
  createDrawRequest,
  drawRequestMatchesSession,
} from "./draw-request";

describe("drawRequestMatchesSession", () => {
  const request = createDrawRequest({
    x: 1,
    y: 2,
    colorIndex: 3,
    accountId: "alice.testnet",
    networkId: "testnet",
  });

  it("matches only when live account and network equal the frozen request", () => {
    expect(
      drawRequestMatchesSession(request, "alice.testnet", "testnet"),
    ).toBe(true);
  });

  it("rejects disconnect, account switch, and network switch", () => {
    expect(drawRequestMatchesSession(request, null, "testnet")).toBe(false);
    expect(
      drawRequestMatchesSession(request, "bob.testnet", "testnet"),
    ).toBe(false);
    expect(
      drawRequestMatchesSession(request, "alice.testnet", "mainnet"),
    ).toBe(false);
    expect(drawRequestMatchesSession(request, "alice.testnet", null)).toBe(
      false,
    );
  });
});

describe("createDrawRequest paid fields", () => {
  it("freezes maxCost and expiry on queue items when provided", () => {
    const paid = createDrawRequest({
      x: 1,
      y: 2,
      colorIndex: 3,
      accountId: "alice.testnet",
      networkId: "testnet",
      maxCost: "10",
      expiresAtNs: "130000000000",
      pricingVersion: "pressure-v1-fixture",
      actionNonce: "1",
      sessionId: "session-1",
    });
    expect(paid.maxCost).toBe("10");
    expect(paid.expiresAtNs).toBe("130000000000");
    expect(paid.pricingVersion).toBe("pressure-v1-fixture");
    expect(paid.sessionId).toBe("session-1");
  });

  it("omits paid fields for free-board requests", () => {
    const free = createDrawRequest({
      x: 0,
      y: 0,
      colorIndex: 1,
      accountId: "alice.testnet",
      networkId: "testnet",
    });
    expect(free.maxCost).toBeUndefined();
    expect(free.expiresAtNs).toBeUndefined();
  });
});
