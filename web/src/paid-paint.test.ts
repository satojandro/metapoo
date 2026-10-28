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
  it("stays off by default without flag or the retired pressure schema", () => {
    expect(isPaidPaintModeEnabled({ flagEnabled: false, board: null })).toBe(
      false,
    );
    expect(boardReportsPaidSchema({ schema_version: 2 })).toBe(false);
  });

  it("recognises only the retired pressure schema, never the credit board", () => {
    expect(boardReportsPaidSchema({ schemaVersion: 3 })).toBe(true);
    // The regression this pins: any schema bump used to switch Journey C on, so
    // pointing the page at the schema-4 credit board turned on a quote UI - with
    // fixture prices in it.
    expect(boardReportsPaidSchema({ schemaVersion: 4 })).toBe(false);
    expect(
      boardReportsPaidSchema({ pricing_version: "pressure-v1-fixture" }),
    ).toBe(false);
  });

  it("never renders fixture quotes, whatever the flags say", () => {
    // A fabricated price in a money UI is worse than no UI (D1).
    const cases = [
      { paidModeEnabled: true, boardReportsPaid: false, liveQuoteAvailable: false },
      { paidModeEnabled: true, boardReportsPaid: true, liveQuoteAvailable: true },
      { paidModeEnabled: false, boardReportsPaid: false, liveQuoteAvailable: false },
    ];
    for (const args of cases) {
      expect(shouldUseMockPressureQuotes(args)).toBe(false);
    }
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

/*
 * Removed 2026-10-28 (D1). This block asserted that a schema-3 board plus a quote
 * fixture produced a `paint_with_wallet` FunctionCall. Nothing implements
 * `paint_with_wallet`: `contracts/paid-board` exposes `draw`/`draw_many` against
 * prepaid credits, and schema 3 is retired. The shape it pinned was a speculative
 * interface, not a deployed contract. The Journey C modules themselves go with the
 * recency-UI task; this is the test half of that removal.
 */
