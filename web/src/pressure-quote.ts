/**
 * Pressure quote adapter.
 * Live get_quote waits on Worker B's contract methods. Until then, paid UI
 * uses a deterministic mock derived from shared fixtures — labelled as demo.
 */

import type { QuoteRequest, QuoteView, PressureConfigV1 } from "@shared/protocol/board.ts";
import pressureConfigFixture from "@shared/fixtures/board/pressure-config.v1.json";
import quoteSuccessFixture from "@shared/fixtures/board/quote-success.json";

export const MOCK_QUOTE_DEMO_LABEL =
  "Demo / fixture quotes — not live economics";

export const FIXTURE_PRESSURE_CONFIG = pressureConfigFixture as PressureConfigV1;

const FIXTURE_QUOTE = (quoteSuccessFixture as { quote: QuoteView }).quote;

export interface GetQuoteOptions {
  /** When true, never call a live path (tests / unpaid schema). */
  useMock?: boolean;
  /** Override "now" for deterministic expiry (nanoseconds as decimal string). */
  nowNs?: string;
  /** Optional balance override for the mock ledger. */
  balance?: string;
}

export type QuoteSource = "mock" | "live";

export interface QuoteResult {
  quote: QuoteView;
  source: QuoteSource;
  demoLabel: string | null;
}

/**
 * Region id for pressure overlay (matches pressure-and-paint.md).
 * region columns = ceil(board_width / region_size).
 */
export function regionIdForCell(
  x: number,
  y: number,
  boardWidth: number,
  regionSize: number,
): number {
  const columns = Math.ceil(boardWidth / regionSize);
  return Math.floor(y / regionSize) * columns + Math.floor(x / regionSize);
}

function nowNsString(override?: string): string {
  if (override !== undefined) {
    return override;
  }
  // performance.now is ms; Date.now is ms. Convert to ns as decimal string.
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

/**
 * Deterministic mock quote for UI development.
 * Cost follows fixture base when cold; bumps slightly by region id for legend variety.
 */
export function buildMockQuote(
  request: QuoteRequest,
  options?: GetQuoteOptions,
): QuoteView {
  const config = FIXTURE_PRESSURE_CONFIG;
  const regionId = regionIdForCell(request.x, request.y, 128, config.regionSize);
  const base = BigInt(config.baseCost);
  // Mild regional variation for overlay legend (still within fixture max).
  const bump = BigInt(regionId % 5);
  const max = BigInt(config.maxCost);
  let cost = base + bump;
  if (cost > max) {
    cost = max;
  }
  const observedAtNs = nowNsString(options?.nowNs);
  const ttl = BigInt(config.quoteTtlNs);
  const expiresAtNs = (BigInt(observedAtNs) + ttl).toString();

  return {
    cost: cost.toString(),
    regionId,
    cooledHeat: bump === 0n ? "0" : (bump * 10n).toString(),
    pricingVersion: config.version,
    observedAtNs,
    expiresAtNs,
    balance: options?.balance ?? FIXTURE_QUOTE.balance,
    revision: FIXTURE_QUOTE.revision,
  };
}

/**
 * Fetch a placement quote. Live path is intentionally unavailable until B
 * exposes get_quote — callers must treat mock results as fixture data.
 */
export async function getQuote(
  request: QuoteRequest,
  options?: GetQuoteOptions,
): Promise<QuoteResult> {
  const useMock = options?.useMock !== false;
  if (useMock) {
    return {
      quote: buildMockQuote(request, options),
      source: "mock",
      demoLabel: MOCK_QUOTE_DEMO_LABEL,
    };
  }

  // Live contract methods are owned by Worker B and are not wired here.
  throw new Error(
    "Live get_quote is not available yet. Paid contract view methods are owned by Worker B.",
  );
}

export function isQuoteExpired(quote: Pick<QuoteView, "expiresAtNs">, nowNs: string): boolean {
  return BigInt(nowNs) > BigInt(quote.expiresAtNs);
}

export function quoteAgeNs(
  quote: Pick<QuoteView, "observedAtNs">,
  nowNs: string,
): bigint {
  const age = BigInt(nowNs) - BigInt(quote.observedAtNs);
  return age < 0n ? 0n : age;
}
