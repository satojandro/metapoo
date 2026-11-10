import { describe, expect, it, vi } from "vitest";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import {
  createIntentsClient,
  parseQuote,
  parseStatus,
  parseTokens,
} from "./client";
import { assertQuoteMatches, canonicalQuoteRequest, providerFeeBps } from "./quote";
import { fixtureQuote } from "./fixtures";
import liveNonDryQuote from "./fixtures/live-nondry-quote-2026-11-10.json";
import liveStatus from "./fixtures/live-status-pending-2026-11-10.json";

describe("Intents REST boundary", () => {
  it("refuses malicious endpoints and malformed token metadata", () => {
    expect(() =>
      createIntentsClient({
        baseUrl: "https://attacker.example",
        origin: "https://game.example",
      }),
    ).toThrow();
    expect(() =>
      parseTokens([
        { assetId: "x", symbol: "USDC", blockchain: "base", decimals: -1 },
      ]),
    ).toThrow();
    expect(() =>
      parseQuote({ ...fixtureQuote().raw, signature: "" }),
    ).toThrow();
  });
  it("uses the vendor signature verifier by default and rejects fabricated signatures", async () => {
    const quote = fixtureQuote();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(quote.raw), { status: 200 }),
      );
    const client = createIntentsClient({ fetch });
    expect(await client.verify(quote)).toBe(false);
    await expect(client.quote(quote.quoteRequest)).rejects.toMatchObject({
      code: "signature",
    });
  });
  it("keeps partner credentials out of direct requests and preserves mandatory memo in status lookup", async () => {
    const quote = fixtureQuote({
      ...fixtureQuote().quoteRequest,
      dry: false,
      depositMode: "MEMO",
    });
    quote.raw.quote = { ...(quote.raw.quote as object), depositMemo: "memo-7" };
    quote.quote.depositMemo = "memo-7";
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "PROCESSING",
            updatedAt: quote.timestamp,
            quoteResponse: quote.raw,
            swapDetails: {},
          }),
          { status: 200 },
        ),
      );
    const client = createIntentsClient({ fetch, verifySignature: () => true });
    await client.status(quote);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("depositMemo=memo-7");
    expect(init.credentials).toBe("omit");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(init.headers).not.toHaveProperty("X-API-Key");
  });
  it("parses the live status echo that drops correlationId but keeps a valid signature", () => {
    // Public /v0/status capture, 10 Nov 2026. The vendor signs a canonical payload that
    // excludes correlationId, so the echo cannot carry it — requiring it made every poll
    // fail with "Unsupported provider status" seconds after the deposit address appeared.
    const status = parseStatus(structuredClone(liveStatus));
    expect(status.status).toBe("PENDING_DEPOSIT");
    expect(status.quoteResponse.correlationId).toBeUndefined();
    expect(
      verifyQuoteSignature(
        status.quoteResponse
          .raw as Parameters<typeof verifyQuoteSignature>[0],
      ),
    ).toBe(true);
    // The echo describes the same approved payment we captured at commit time.
    const saved = parseQuote(structuredClone(liveNonDryQuote));
    expect(status.quoteResponse.quote.depositAddress).toBe(
      saved.quote.depositAddress,
    );
    expect(providerFeeBps(status.quoteResponse)).toBe(20);
    expect(() =>
      assertQuoteMatches(
        status.quoteResponse,
        canonicalQuoteRequest(saved.quoteRequest, false),
      ),
    ).not.toThrow();
    // A quote envelope itself still has to carry a correlation id.
    const stripped: Record<string, unknown> = structuredClone(liveNonDryQuote);
    delete stripped.correlationId;
    expect(() => parseQuote(stripped)).toThrow();
  });
  it("retains rate-limit backoff and classifies future status as unknown", async () => {
    const client = createIntentsClient({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("busy", {
            status: 429,
            headers: { "Retry-After": "11" },
          }),
        ),
    });
    await expect(client.tokens()).rejects.toMatchObject({
      httpStatus: 429,
      retryAfterMs: 11000,
    });
    expect(
      parseStatus({
        status: "FUTURE_STATE",
        updatedAt: new Date().toISOString(),
        quoteResponse: fixtureQuote().raw,
      }).status,
    ).toBe("UNKNOWN");
  });
});
