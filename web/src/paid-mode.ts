/**
 * Paid-paint mode gate.
 * Off by default so free-board gameplay is unchanged until explicitly enabled
 * via `VITE_PAID_PAINT=true` or a contract that reports paid pressure metadata.
 */

import { PAID_PAINT_FLAG } from "./config";

/** Free schema in shared/board.json today. Paid board adds pressure fields. */
export const FREE_BOARD_SCHEMA_VERSION = 2;

/**
 * Lightweight shape we can sniff from get_board without claiming a live paid
 * contract API exists yet. B owns the real paid methods.
 */
export interface PaidSchemaHints {
  schemaVersion?: number;
  /** Snake_case wire alias from free/paid get_board. */
  schema_version?: number;
  /** Present on paid board metadata (protocol PaidBoardMetadata.pricingVersion). */
  pricingVersion?: string | null;
  /** Snake_case wire alias if the contract returns that form. */
  pricing_version?: string | null;
  pressure?: unknown;
}

export function boardReportsPaidSchema(board: PaidSchemaHints | null | undefined): boolean {
  if (!board) {
    return false;
  }
  const pricing =
    (typeof board.pricingVersion === "string" && board.pricingVersion.length > 0) ||
    (typeof board.pricing_version === "string" && board.pricing_version.length > 0);
  const hasPressure = board.pressure != null && typeof board.pressure === "object";
  const schema =
    typeof board.schemaVersion === "number"
      ? board.schemaVersion
      : typeof board.schema_version === "number"
        ? board.schema_version
        : null;
  const schemaBump = schema !== null && schema > FREE_BOARD_SCHEMA_VERSION;
  return pricing || hasPressure || schemaBump;
}

/**
 * Whether Journey C paid-paint UI (quotes, max-cost, pressure overlay) is active.
 * Free path remains when the flag is off and the board is unpaid schema.
 */
export function isPaidPaintModeEnabled(options?: {
  flagEnabled?: boolean;
  board?: PaidSchemaHints | null;
}): boolean {
  const flag = options?.flagEnabled ?? PAID_PAINT_FLAG;
  if (flag) {
    return true;
  }
  return boardReportsPaidSchema(options?.board ?? null);
}

/**
 * True when the UI should use fixture/mock quotes instead of a live contract view.
 * Live contract verification is owned by B and is not claimed here.
 */
export function shouldUseMockPressureQuotes(options: {
  paidModeEnabled: boolean;
  boardReportsPaid: boolean;
  liveQuoteAvailable?: boolean;
}): boolean {
  if (!options.paidModeEnabled) {
    return false;
  }
  if (options.liveQuoteAvailable === true && options.boardReportsPaid) {
    return false;
  }
  return true;
}
