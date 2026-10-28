/**
 * Paid-paint mode gate.
 * Off by default so free-board gameplay is unchanged until explicitly enabled
 * via `VITE_PAID_PAINT=true` or a contract that reports paid pressure metadata.
 */

import { PAID_PAINT_FLAG } from "./config";

/** Free schema in shared/board.json today. Paid board adds pressure fields. */
export const FREE_BOARD_SCHEMA_VERSION = 2;

/**
 * Lightweight shape we can sniff from get_board (free schema 2 or paid schema 3).
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

/** Schema 3 was the pressure prototype. Nothing deployed reports it. */
const PRESSURE_SCHEMA_VERSION = 3;

/**
 * Whether `get_board` reports the retired pressure schema.
 *
 * Schema 4 must return false. Treating *any* schema bump as "paid pressure mode"
 * is what pointed the Journey C quote UI at a credit board — and the quotes it
 * then rendered were fabricated prices in a money screen.
 */
export function boardReportsPaidSchema(board: PaidSchemaHints | null | undefined): boolean {
  if (!board) {
    return false;
  }
  const schema =
    typeof board.schemaVersion === "number"
      ? board.schemaVersion
      : typeof board.schema_version === "number"
        ? board.schema_version
        : null;
  return schema === PRESSURE_SCHEMA_VERSION;
}

/**
 * Legacy Journey C switch. Flag-only now (a schema-4 board never turns it on), and
 * the whole path is slated for deletion — see the recency-UI task.
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
 * Journey C presentations are retired (D1). A fixture quote is a fabricated price,
 * and a fabricated price in a money UI is worse than no UI, so this is false
 * unconditionally until the pressure path is deleted outright.
 */
export function shouldUseMockPressureQuotes(_options: {
  paidModeEnabled: boolean;
  boardReportsPaid: boolean;
  liveQuoteAvailable?: boolean;
}): boolean {
  return false;
}
