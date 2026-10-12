/**
 * Paid paint wire adapters typed to shared/protocol/board.
 * Maps UI colorIndex ↔ wire `color`, builds draw args, parses charged cost.
 * Does not claim a live paid contract — live methods wait on Worker B.
 */

import type {
  PaintActionOutcome,
  PaidDrawArgs,
  QuoteView,
} from "@shared/protocol/board.ts";

/** UI palette index and on-wire color are the same integer in R1. */
export function colorIndexToWireColor(colorIndex: number): number {
  return colorIndex;
}

export function wireColorToColorIndex(color: number): number {
  return color;
}

export interface BuildPaidDrawArgsInput {
  x: number;
  y: number;
  /** UI palette index; mapped to wire `color`. */
  colorIndex: number;
  maxCost: string;
  pricingVersion: string;
  expiresAtNs: string;
  actionNonce: string;
  /** Required for zero-deposit session draw; omit for ordinary wallet paint. */
  sessionId?: string;
}

/** Build PaidDrawArgs for session draw or wallet paint_with_wallet. */
export function buildPaidDrawArgs(input: BuildPaidDrawArgsInput): PaidDrawArgs {
  const args: PaidDrawArgs = {
    x: input.x,
    y: input.y,
    color: colorIndexToWireColor(input.colorIndex),
    maxCost: input.maxCost,
    pricingVersion: input.pricingVersion,
    expiresAtNs: input.expiresAtNs,
    actionNonce: input.actionNonce,
  };
  if (input.sessionId !== undefined && input.sessionId !== "") {
    args.sessionId = input.sessionId;
  }
  return args;
}

/**
 * Authorize at the quoted cost (or an explicit higher ceiling the user accepted).
 * Never silently raise — callers must pass the reviewed amount.
 */
export function maxCostFromQuote(quote: Pick<QuoteView, "cost">, authorizedMax?: string): string {
  if (authorizedMax !== undefined && authorizedMax !== "") {
    return authorizedMax;
  }
  return quote.cost;
}

/** Pull charged TOILET from a paint outcome; null when nothing was debited. */
export function parseChargedCost(
  outcome: Pick<PaintActionOutcome, "chargedCost" | "status"> | null | undefined,
): string | null {
  if (!outcome) {
    return null;
  }
  if (outcome.chargedCost === null || outcome.chargedCost === undefined) {
    return null;
  }
  const trimmed = String(outcome.chargedCost).trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed;
}

/** Compare decimal-string token amounts without floating point. */
export function compareToiletAmount(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isCostAboveMax(cost: string, maxCost: string): boolean {
  return compareToiletAmount(cost, maxCost) > 0;
}
