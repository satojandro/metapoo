import { describe, expect, it } from "vitest";
import { prepareDraw } from "./draw-policy";

const base = {
  connected: true,
  accountId: "learner.testnet",
  sessionNetworkId: "testnet" as const,
  boardNetworkId: "testnet" as const,
};

describe("prepareDraw", () => {
  it("asks for a pixel before it complains about color", () => {
    const result = prepareDraw({ ...base, x: null, y: null, color: null });
    expect(result.code).toBe("PixelNotChosen");
    expect(result.transactionHash).toBeNull();
  });

  it("rejects a square outside the board", () => {
    expect(prepareDraw({ ...base, x: 128, y: 0, color: 0 }).code).toBe(
      "CoordinateOutOfRange",
    );
  });

  it("asks for a color after a real square is chosen", () => {
    expect(prepareDraw({ ...base, x: 4, y: 5, color: null }).code).toBe(
      "ColorNotChosen",
    );
  });

  it("rejects a palette index the board does not list", () => {
    expect(prepareDraw({ ...base, x: 4, y: 5, color: 8 }).code).toBe(
      "ColorOutOfRange",
    );
  });

  it("does not send a transaction for a complete, legal selection", () => {
    const result = prepareDraw({ ...base, x: 0, y: 0, color: 0 });
    expect(result.outcome).toBe("blocked");
    expect(result.code).toBe("OverwriteRuleNotChosen");
    expect(result.transactionHash).toBeNull();
    expect(result.explorerUrl).toBeNull();
    expect(result.message).toMatch(/no transaction was sent/i);
  });
});
