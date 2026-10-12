/**
 * Stable uppercase protocol error codes.
 * Domain agents must reuse these identifiers; user-facing copy lives in
 * translations keyed by code, not in alternate string enums.
 */

export const PROTOCOL_ERROR_CODES = [
  // Board / paint
  "COORDINATE_OUT_OF_RANGE",
  "COLOR_OUT_OF_RANGE",
  "SCHEMA_MISMATCH",
  "BOARD_EPOCH_MISMATCH",
  "QUOTE_EXPIRED",
  "PRICING_VERSION_MISMATCH",
  "MAX_COST_EXCEEDED",
  "INSUFFICIENT_PAINT_BALANCE",
  "NOOP_SAME_COLOR",
  "ACTION_NONCE_STALE",
  "ACTION_NONCE_GAP",
  "SESSION_REQUIRED",
  "SESSION_UNKNOWN",
  "SESSION_EXPIRED",
  "SESSION_BUDGET_EXCEEDED",
  "SESSION_KEY_MISMATCH",
  "PAINT_PAUSED",
  "STORAGE_EXHAUSTED",
  "TOKEN_REJECTED",
  "PACK_AMOUNT_MISMATCH",
  "PURCHASE_DISABLED",
  // Bounties
  "BOUNTY_NOT_FOUND",
  "BOUNTY_WRONG_STATE",
  "BOUNTY_DEADLINE_PASSED",
  "BOUNTY_FUNDING_INVALID",
  "BOUNTY_NOT_SPONSOR",
  "SUBMISSION_NOT_FOUND",
  "CONSENT_DIGEST_MISMATCH",
  "CONSENT_INCOMPLETE",
  "SPLIT_INVALID",
  "SNAPSHOT_NOT_REGISTERED",
  "SNAPSHOT_CROP_MISMATCH",
  "CAPTURE_WINDOW_INVALID",
  "CLAIM_NOT_AVAILABLE",
  "CLAIM_PENDING",
  "CLAIM_ALREADY_PAID",
  // History / prints
  "HISTORY_GAP",
  "HISTORY_HALTED",
  "SNAPSHOT_UNAVAILABLE",
  "ATTESTATION_REQUIRED",
  "ATTESTER_UNAUTHORIZED",
  "PRINT_SERIES_EXHAUSTED",
  "PRINT_OPERATION_CONFLICT",
  "BOUNTY_ENTITLEMENT_MISSING",
  "BOUNTY_ENTITLEMENT_CONSUMED",
  // Operations / client
  "OPERATION_UNCERTAIN",
  "OPERATION_ALREADY_EXISTS",
  "NETWORK_MISMATCH",
  "WALLET_NOT_CONNECTED",
  "CONTRACT_NOT_CONFIGURED",
  "SERVICE_UNAVAILABLE",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface ProtocolError {
  code: ProtocolErrorCode;
  /** Short visitor-facing sentence; must not invent success. */
  message: string;
  /** Optional machine detail for logs; never a secret. */
  detail?: string;
}

export function isProtocolErrorCode(value: string): value is ProtocolErrorCode {
  return (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}
