import { describe, expect, it } from "vitest";
import {
  bandForCost,
  formatSelectedQuoteSummary,
  renderLegendHtml,
} from "./overlay";
import type { QuoteView } from "@shared/protocol/board.ts";

describe("pressure overlay legend", () => {
  it("pairs numeric bands with non-color pattern indicators", () => {
    expect(bandForCost("10").pattern).toBe("···");
    expect(bandForCost("15").pattern).toBe("///");
    expect(bandForCost("25").pattern).toBe("###");
    expect(bandForCost("40").pattern).toBe("■■■");
  });

  it("renders a legend that includes TOILET ranges and patterns", () => {
    const html = renderLegendHtml();
    expect(html).toMatch(/Quiet/);
    expect(html).toMatch(/TOILET/);
    expect(html).toMatch(/···/);
    expect(html).toMatch(/activity raises local cost/i);
  });

  it("formats selected quote summary with cost, balance, and demo label", () => {
    const quote: QuoteView = {
      cost: "10",
      regionId: 0,
      cooledHeat: "0",
      pricingVersion: "pressure-v1-fixture",
      observedAtNs: "100000000000",
      expiresAtNs: "130000000000",
      balance: "100",
      revision: "0",
    };
    const text = formatSelectedQuoteSummary(quote, {
      nowNs: "100000000000",
      demoLabel: "Demo / fixture quotes — not live economics",
    });
    expect(text).toMatch(/10 TOILET/);
    expect(text).toMatch(/Balance 100 TOILET/);
    expect(text).toMatch(/Demo \/ fixture/);
    expect(text).toMatch(/Network gas is separate/);
  });
});
