import { describe, expect, it } from "vitest";
import type { PaintActionOutcome, QuoteView } from "@shared/protocol/board.ts";
import quoteSuccessFixture from "@shared/fixtures/board/quote-success.json";
import {
  buildPaidDrawArgs,
  buildPaidFunctionCall,
  colorIndexToWireColor,
  compareToiletAmount,
  isCostAboveMax,
  maxCostFromQuote,
  PAINT_WITH_WALLET_DEPOSIT,
  paidDrawArgsToWire,
  parseChargedCost,
  wireColorToColorIndex,
} from "./paid-paint";
import {
  boardReportsPaidSchema,
  isPaidPaintModeEnabled,
  shouldUseMockPressureQuotes,
} from "./paid-mode";
import {
  buildMockQuote,
  getQuote,
  isQuoteExpired,
  regionIdForCell,
  MOCK_QUOTE_DEMO_LABEL,
} from "./pressure-quote";
import { resolvePaidSubmitCall } from "./submit-draw";
import { validateContractMetadata } from "./contract-meta";
import type { ChainBoardView } from "./contract";

describe("paid paint adapter argument mapping", () => {
  it("maps colorIndex ↔ wire color as the same palette index", () => {
    expect(colorIndexToWireColor(2)).toBe(2);
    expect(wireColorToColorIndex(7)).toBe(7);
  });

  it("builds PaidDrawArgs with maxCost, expiry, nonce, and optional sessionId", () => {
    const withSession = buildPaidDrawArgs({
      x: 4,
      y: 5,
      colorIndex: 2,
      maxCost: "10",
      pricingVersion: "pressure-v1-fixture",
      expiresAtNs: "130000000000",
      actionNonce: "1",
      sessionId: "session-1",
    });
    expect(withSession).toEqual({
      x: 4,
      y: 5,
      color: 2,
      maxCost: "10",
      pricingVersion: "pressure-v1-fixture",
      expiresAtNs: "130000000000",
      actionNonce: "1",
      sessionId: "session-1",
    });

    const walletPaint = buildPaidDrawArgs({
      x: 0,
      y: 0,
      colorIndex: 3,
      maxCost: "12",
      pricingVersion: "pressure-v1-fixture",
      expiresAtNs: "130000000000",
      actionNonce: "2",
    });
    expect(walletPaint.sessionId).toBeUndefined();
    expect(walletPaint.color).toBe(3);
    expect(walletPaint.maxCost).toBe("12");
  });

  it("maps protocol camelCase to snake_case wire args the Rust contract expects", () => {
    const wire = paidDrawArgsToWire(
      buildPaidDrawArgs({
        x: 1,
        y: 2,
        colorIndex: 4,
        maxCost: "10",
        pricingVersion: "pressure-v1-fixture",
        expiresAtNs: "130000000000",
        actionNonce: "1",
        sessionId: "sess-9",
      }),
    );
    expect(wire).toEqual({
      x: 1,
      y: 2,
      color: 4,
      max_cost: "10",
      pricing_version: "pressure-v1-fixture",
      expires_at_ns: "130000000000",
      action_nonce: "1",
      session_id: "sess-9",
    });
  });

  it("parses charged cost from outcomes and ignores empty/null", () => {
    const accepted: PaintActionOutcome = {
      actionNonce: "1",
      status: "accepted",
      chargedCost: "11",
      revision: "3",
      operationId: "op-1",
      observedAtNs: "100",
    };
    expect(parseChargedCost(accepted)).toBe("11");
    expect(
      parseChargedCost({
        ...accepted,
        status: "expired_quote",
        chargedCost: null,
      }),
    ).toBeNull();
    expect(parseChargedCost(null)).toBeNull();
  });

  it("compares TOILET amounts as bigints", () => {
    expect(compareToiletAmount("9", "10")).toBe(-1);
    expect(compareToiletAmount("10", "10")).toBe(0);
    expect(isCostAboveMax("11", "10")).toBe(true);
    expect(isCostAboveMax("10", "10")).toBe(false);
  });

  it("defaults maxCostFromQuote to the quoted cost unless user set higher", () => {
    const quote = { cost: "10" } as Pick<QuoteView, "cost">;
    expect(maxCostFromQuote(quote)).toBe("10");
    expect(maxCostFromQuote(quote, "15")).toBe("15");
  });
});

describe("paid mode gate", () => {
  it("stays off by default without flag or paid schema", () => {
    expect(isPaidPaintModeEnabled({ flagEnabled: false, board: null })).toBe(
      false,
    );
    expect(boardReportsPaidSchema({ schema_version: 2 })).toBe(false);
  });

  it("enables from flag or paid schema hints", () => {
    expect(isPaidPaintModeEnabled({ flagEnabled: true })).toBe(true);
    expect(
      boardReportsPaidSchema({
        pricing_version: "pressure-v1-fixture",
      }),
    ).toBe(true);
    expect(boardReportsPaidSchema({ schemaVersion: 3 })).toBe(true);
  });

  it("uses mock quotes when paid UI is on but live quotes are unavailable", () => {
    expect(
      shouldUseMockPressureQuotes({
        paidModeEnabled: true,
        boardReportsPaid: false,
        liveQuoteAvailable: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMockPressureQuotes({
        paidModeEnabled: true,
        boardReportsPaid: true,
        liveQuoteAvailable: true,
      }),
    ).toBe(false);
  });
});

describe("pressure quote mock adapter", () => {
  it("computes region ids for 8×8 partitions on 128 board", () => {
    expect(regionIdForCell(0, 0, 128, 8)).toBe(0);
    expect(regionIdForCell(8, 0, 128, 8)).toBe(1);
    expect(regionIdForCell(0, 8, 128, 8)).toBe(16);
  });

  it("builds fixture quotes with demo label via getQuote", async () => {
    const result = await getQuote(
      { x: 0, y: 0, color: 2, accountId: "alice.testnet" },
      { useMock: true, nowNs: "100000000000" },
    );
    expect(result.source).toBe("mock");
    expect(result.demoLabel).toBe(MOCK_QUOTE_DEMO_LABEL);
    expect(result.quote.cost).toBe("10");
    expect(result.quote.expiresAtNs).toBe("130000000000");
    expect(isQuoteExpired(result.quote, "130000000001")).toBe(true);
  });

  it("varies mock cost by region while staying within fixture max", () => {
    const cold = buildMockQuote(
      { x: 0, y: 0, color: 1, accountId: "a" },
      { nowNs: "1" },
    );
    const warmer = buildMockQuote(
      { x: 16, y: 0, color: 1, accountId: "a" },
      { nowNs: "1" },
    );
    expect(BigInt(cold.cost)).toBeLessThanOrEqual(50n);
    expect(BigInt(warmer.cost)).toBeLessThanOrEqual(50n);
    expect(warmer.regionId).not.toBe(cold.regionId);
  });
});

/**
 * Critical F↔B shape test: schema-3 board view + quote fixture → FunctionCall
 * matching contracts/board `paint_with_wallet` / session `draw` signatures.
 */
describe("paid FunctionCall F↔B integration", () => {
  const schema3Board: ChainBoardView = {
    schema_version: 3,
    width: 128,
    height: 128,
    origin: "top-left",
    overwrite_rule: "open_wall",
    sponsorship_enabled: false,
    pricing_version: "pressure-v1-fixture",
    ledger_unit: "TOILET",
    pressure: { version: "pressure-v1-fixture", max_cost: "50" },
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
  };

  const fixtureQuote = (quoteSuccessFixture as { quote: QuoteView }).quote;

  it("connects schema-3 board + quote fixture to paint_with_wallet FunctionCall args", () => {
    const meta = validateContractMetadata(schema3Board);
    expect(meta.ok).toBe(true);

    const request = (quoteSuccessFixture as { request: { x: number; y: number; color: number } })
      .request;
    const call = buildPaidFunctionCall({
      x: request.x,
      y: request.y,
      colorIndex: request.color,
      maxCost: maxCostFromQuote(fixtureQuote),
      pricingVersion: fixtureQuote.pricingVersion,
      expiresAtNs: fixtureQuote.expiresAtNs,
      actionNonce: "1",
    });

    // Matches contracts/board/src/lib.rs paint_with_wallet(...)
    expect(call.methodName).toBe("paint_with_wallet");
    expect(call.deposit).toBe(PAINT_WITH_WALLET_DEPOSIT);
    expect(call.args).toEqual({
      x: 0,
      y: 0,
      color: 2,
      max_cost: "10",
      pricing_version: "pressure-v1-fixture",
      expires_at_ns: "130000000000",
      action_nonce: "1",
    });
    expect(call.args).not.toHaveProperty("session_id");
    expect(Object.keys(call.args).sort()).toEqual(
      [
        "action_nonce",
        "color",
        "expires_at_ns",
        "max_cost",
        "pricing_version",
        "x",
        "y",
      ].sort(),
    );

    const fromSubmit = resolvePaidSubmitCall({
      x: request.x,
      y: request.y,
      colorIndex: request.color,
      paid: {
        maxCost: fixtureQuote.cost,
        pricingVersion: fixtureQuote.pricingVersion,
        expiresAtNs: fixtureQuote.expiresAtNs,
        actionNonce: "1",
      },
    });
    expect(fromSubmit).toEqual(call);
  });

  it("builds session draw FunctionCall with session_id and zero deposit", () => {
    const call = buildPaidFunctionCall({
      x: 0,
      y: 0,
      colorIndex: 2,
      maxCost: fixtureQuote.cost,
      pricingVersion: fixtureQuote.pricingVersion,
      expiresAtNs: fixtureQuote.expiresAtNs,
      actionNonce: "1",
      sessionId: "alice:1",
    });

    // Matches contracts/board/src/lib.rs draw(..., session_id)
    expect(call.methodName).toBe("draw");
    expect(call.deposit).toBe("0");
    expect(call.args.session_id).toBe("alice:1");
    expect(call.args.max_cost).toBe("10");
    expect(call.args.pricing_version).toBe("pressure-v1-fixture");
    expect(call.args.expires_at_ns).toBe("130000000000");
    expect(call.args.action_nonce).toBe("1");
  });
});
