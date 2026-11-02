import { describe, expect, it } from "vitest";
import {
  assertQuoteMatches,
  parseTokenAmount,
  makeQuoteRequest,
  validateRefundAddress,
  canonicalQuoteRequest,
  providerFeeBps,
  REVIEWED_PLATFORM_FEE_RECIPIENT,
} from "./quote";
import { parseQuote } from "./client";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import liveDryQuote from "./fixtures/live-dryquote-2026-11-03.json";
import {
  FIXTURE_CONTEXT,
  FIXTURE_REFUND,
  FIXTURE_TIME,
  FIXTURE_TOKEN,
  fixtureQuote,
} from "./fixtures";

describe("Intents exact payments", () => {
  it("preserves 24-decimal amounts beyond JS safe integers", () => {
    expect(
      parseTokenAmount("12345678901234567890.123456789012345678901234", 24),
    ).toBe("12345678901234567890123456789012345678901234");
    for (const bad of ["-1", "+1", "1e6", "0", "01", "1.0000001", "NaN"])
      expect(() => parseTokenAmount(bad, 6)).toThrow();
  });
  it("binds recipient, refund network and asset instead of accepting provider routing", () => {
    const quote = fixtureQuote();
    const request = { ...quote.quoteRequest };
    quote.quoteRequest = { ...request, recipient: "attacker.near" };
    expect(() => assertQuoteMatches(quote, request)).toThrow("recipient");
    quote.quoteRequest = {
      ...request,
      customRecipientMsg: "purchase",
    } as typeof request;
    expect(() => assertQuoteMatches(quote, request)).toThrow("unrequested");
  });
  it("does not permit playable addresses in preview or a missing required memo", () => {
    const quote = fixtureQuote();
    quote.quote.depositAddress = "0xBAD";
    expect(() => assertQuoteMatches(quote, quote.quoteRequest)).toThrow(
      "Preview",
    );
    const request = makeQuoteRequest(
      FIXTURE_TOKEN,
      "1000000",
      FIXTURE_CONTEXT.accountId,
      FIXTURE_REFUND,
      FIXTURE_TIME,
    );
    request.dry = false;
    request.depositMode = "MEMO";
    expect(() => assertQuoteMatches(fixtureQuote(request), request)).toThrow(
      "memo",
    );
  });
  it("rejects an address from the wrong source chain", () => {
    expect(() => validateRefundAddress("base", "alice.near")).toThrow();
    expect(() => validateRefundAddress("btc", FIXTURE_REFUND)).toThrow();
  });
  it("verifies the real captured browser dry quote and accepts only its bounded provider defaults", () => {
    // Public, unchanged response captured by the parent from localhost; no deposit address exists.
    expect(
      verifyQuoteSignature(
        liveDryQuote as Parameters<typeof verifyQuoteSignature>[0],
      ),
    ).toBe(true);
    const quote = parseQuote(structuredClone(liveDryQuote));
    const requested = canonicalQuoteRequest(quote.quoteRequest, true);
    expect(() => assertQuoteMatches(quote, requested)).not.toThrow();
    expect(providerFeeBps(quote)).toBe(20);
    expect(requested).not.toHaveProperty("appFees");
    expect(requested).not.toHaveProperty("insured");
  });
  it("rejects changed fees, unknown recipients and programmable withdrawal extensions", () => {
    const requested = canonicalQuoteRequest(
      parseQuote(liveDryQuote).quoteRequest,
      true,
    );
    for (const extra of [
      { appFees: [{ recipient: "attacker.near", fee: 20 }] },
      { appFees: [{ recipient: REVIEWED_PLATFORM_FEE_RECIPIENT, fee: 26 }] },
      { appFees: [{ recipient: REVIEWED_PLATFORM_FEE_RECIPIENT, fee: -1 }] },
      {
        appFees: [
          { recipient: REVIEWED_PLATFORM_FEE_RECIPIENT, fee: 20 },
          { recipient: REVIEWED_PLATFORM_FEE_RECIPIENT, fee: 20 },
        ],
      },
      { confidentiality: "basic" },
      { insured: true },
      { quoteWaitingTimeMs: 1000 },
      { customRecipientMsg: "purchase" },
    ]) {
      const raw = structuredClone(liveDryQuote);
      Object.assign(raw.quoteRequest, extra);
      expect(() => assertQuoteMatches(parseQuote(raw), requested)).toThrow();
    }
  });
  it("compares normalized historical fee arrays by values rather than object identity", () => {
    const original = parseQuote(structuredClone(liveDryQuote));
    const echoed = parseQuote(structuredClone(liveDryQuote));
    echoed.quoteRequest.appFees = [
      { fee: 20, recipient: REVIEWED_PLATFORM_FEE_RECIPIENT },
    ];
    expect(original.quoteRequest.appFees).not.toBe(echoed.quoteRequest.appFees);
    expect(() =>
      assertQuoteMatches(echoed, original.quoteRequest),
    ).not.toThrow();
  });
});
