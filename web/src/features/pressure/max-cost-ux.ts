/**
 * Max-cost rejection UX helpers (Journey C).
 * Price rises above the authorized max must never silently raise spending —
 * the user must review a fresh quote and place again.
 */

import { isCostAboveMax } from "../../paid-paint";
import { isQuoteExpired } from "../../pressure-quote";
import type { DrawRequest } from "../../draw-request";

export const PRICE_CHANGED_TITLE = "Price changed—review new cost";

export const PRICE_CHANGED_MESSAGE =
  "The placement cost is now higher than the maximum you authorized. Your selection is kept. Review the new TOILET cost and place again — spending tolerance is never raised silently.";

export type MaxCostCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: "price_above_max" | "quote_expired" | "version_mismatch" | "missing_authorization";
      title: string;
      message: string;
    };

/**
 * Compare a freshly fetched quote against the user's frozen authorization.
 * Call this before signing / dispatching a queued paid paint.
 */
export function checkMaxCostAuthorization(input: {
  quotedCost: string;
  maxCost: string | undefined;
  quoteExpiresAtNs: string;
  nowNs: string;
  quotePricingVersion?: string;
  authorizedPricingVersion?: string;
}): MaxCostCheckResult {
  if (input.maxCost === undefined || input.maxCost === "") {
    return {
      ok: false,
      reason: "missing_authorization",
      title: "Authorization required",
      message:
        "This paint has no maximum TOILET cost frozen. Review the quote and place again with an explicit limit.",
    };
  }

  if (isQuoteExpired({ expiresAtNs: input.quoteExpiresAtNs }, input.nowNs)) {
    return {
      ok: false,
      reason: "quote_expired",
      title: "Quote expired",
      message:
        "This price quote expired before paint could be submitted. Refresh the quote and place again.",
    };
  }

  if (
    input.authorizedPricingVersion !== undefined &&
    input.quotePricingVersion !== undefined &&
    input.authorizedPricingVersion !== input.quotePricingVersion
  ) {
    return {
      ok: false,
      reason: "version_mismatch",
      title: "Pricing configuration changed",
      message:
        "The board pricing version changed since you authorized this paint. Review the new cost before placing.",
    };
  }

  if (isCostAboveMax(input.quotedCost, input.maxCost)) {
    return {
      ok: false,
      reason: "price_above_max",
      title: PRICE_CHANGED_TITLE,
      message: PRICE_CHANGED_MESSAGE,
    };
  }

  return { ok: true };
}

/**
 * Revalidate a queued draw against a live quote before dispatch.
 * Free-board items (no maxCost) pass through unchanged.
 */
export function revalidateQueuedPaint(input: {
  request: DrawRequest;
  quotedCost: string;
  quoteExpiresAtNs: string;
  nowNs: string;
  quotePricingVersion?: string;
  paidMode: boolean;
}): MaxCostCheckResult {
  if (!input.paidMode || input.request.maxCost === undefined) {
    return { ok: true };
  }
  return checkMaxCostAuthorization({
    quotedCost: input.quotedCost,
    maxCost: input.request.maxCost,
    quoteExpiresAtNs: input.quoteExpiresAtNs,
    nowNs: input.nowNs,
    quotePricingVersion: input.quotePricingVersion,
    authorizedPricingVersion: input.request.pricingVersion,
  });
}

export type QueueStopReason =
  | "disposed"
  | "account_changed"
  | "network_changed"
  | "session_changed"
  | "price_above_max"
  | "quote_expired"
  | "balance_depleted"
  | "budget_exhausted";

export function queueStopMessage(reason: QueueStopReason): string {
  switch (reason) {
    case "disposed":
      return "Left the wall before these paints were sent.";
    case "account_changed":
      return "Wallet account changed — queued paints were cancelled.";
    case "network_changed":
      return "Network changed — queued paints were cancelled.";
    case "session_changed":
      return "Drawing session changed — queued paints were cancelled.";
    case "price_above_max":
      return PRICE_CHANGED_MESSAGE;
    case "quote_expired":
      return "A queued paint's quote expired. Review the new cost before placing again.";
    case "balance_depleted":
      return "Paint balance is too low for the next queued placement. Queued paints were stopped.";
    case "budget_exhausted":
      return "Session paint budget is exhausted. Queued paints were stopped.";
  }
}
