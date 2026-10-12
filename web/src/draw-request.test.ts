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
