/**
 * Paid paint wire adapters typed to shared/protocol/board.
 * Maps UI colorIndex ↔ wire `color`, builds draw args, and shapes the NEAR
 * FunctionCall the board contract expects (snake_case args).
 *
 * Live get_quote / get_account nonce / register_paint_session may still be
 * mocked when RPC helpers are unavailable — FunctionCall payloads stay
 * contract-shaped either way.
 */

import type {
  PaintActionOutcome,
  PaidDrawArgs,
  QuoteView,
} from "@shared/protocol/board.ts";

/** Exactly 1 yoctoNEAR — required by `paint_with_wallet` on the paid board. */
export const PAINT_WITH_WALLET_DEPOSIT = "1";

/** Session `draw` attaches zero deposit. */
export const PAID_SESSION_DRAW_DEPOSIT = "0";

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

/**
 * Snake_case args matching `draw` / `paint_with_wallet` in contracts/board.
 * NEAR JSON deserialization uses these names, not protocol camelCase.
 */
export interface PaidWireDrawArgs {
  x: number;
  y: number;
  color: number;
  max_cost: string;
  pricing_version: string;
  expires_at_ns: string;
  action_nonce: string;
  /** Present only for session `draw`. */
  session_id?: string;
}

export type PaidPaintMethodName = "paint_with_wallet" | "draw";

/** Pure FunctionCall shape for wallet / local signers and F↔B tests. */
export interface PaidFunctionCall {
  methodName: PaidPaintMethodName;
  args: PaidWireDrawArgs;
  /** YoctoNEAR decimal string: "1" wallet, "0" session. */
  deposit: string;
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

/** Map protocol camelCase PaidDrawArgs → snake_case contract wire args. */
export function paidDrawArgsToWire(args: PaidDrawArgs): PaidWireDrawArgs {
  const wire: PaidWireDrawArgs = {
    x: args.x,
    y: args.y,
    color: args.color,
    max_cost: args.maxCost,
    pricing_version: args.pricingVersion,
    expires_at_ns: args.expiresAtNs,
    action_nonce: args.actionNonce,
  };
  if (args.sessionId !== undefined && args.sessionId !== "") {
    wire.session_id = args.sessionId;
  }
  return wire;
}

/**
 * Build the FunctionCall the paid board contract expects.
 * - With sessionId → method `draw`, deposit 0, includes session_id
 * - Without sessionId → method `paint_with_wallet`, deposit 1 yocto
 */
export function buildPaidFunctionCall(input: BuildPaidDrawArgsInput): PaidFunctionCall {
  const protocol = buildPaidDrawArgs(input);
  const args = paidDrawArgsToWire(protocol);
  const hasSession =
    input.sessionId !== undefined && input.sessionId !== "";
  if (hasSession) {
    return {
      methodName: "draw",
      args,
      deposit: PAID_SESSION_DRAW_DEPOSIT,
    };
  }
  // Wallet path must not send session_id.
  return {
    methodName: "paint_with_wallet",
    args: {
      x: args.x,
      y: args.y,
      color: args.color,
      max_cost: args.max_cost,
      pricing_version: args.pricing_version,
      expires_at_ns: args.expires_at_ns,
      action_nonce: args.action_nonce,
    },
    deposit: PAINT_WITH_WALLET_DEPOSIT,
  };
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
