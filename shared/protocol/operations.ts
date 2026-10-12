/**
 * Client-persisted financial/operation recovery vocabulary.
 * Domain lifecycle (bounty awarded, paint overwritten) is separate from
 * transport status below.
 */

import type { ProtocolErrorCode } from "./errors.ts";

export type OperationTransportStatus =
  | "draft"
  | "awaiting_signature"
  | "submitted"
  | "confirmation_delayed"
  | "confirmed"
  | "failed"
  | "cancelled_before_submission";

export type OperationKind =
  | "paint"
  | "buy_paint"
  | "register_session"
  | "revoke_session"
  | "fund_bounty"
  | "approve_submission"
  | "submit_submission"
  | "accept_submission"
  | "expire_bounty"
  | "claim"
  | "mint_print"
  | "mint_bounty_print";

export interface PersistedOperation {
  /** Stable id scoped to (network, account, kind) chosen before signing. */
  operationId: string;
  kind: OperationKind;
  networkId: string;
  accountId: string;
  status: OperationTransportStatus;
  /** Transaction hash when known; never treat hash alone as success. */
  transactionHash: string | null;
  createdAtNs: string;
  updatedAtNs: string;
  /** Immutable args digest / payload reference for conflict detection. */
  argsDigest: string;
  lastErrorCode: ProtocolErrorCode | null;
  /** Authoritative domain read-back after confirmation, when applicable. */
  confirmedEntityId: string | null;
}

export interface OperationLookupResult {
  operation: PersistedOperation | null;
  /** True when chain/index says success even if local record was lost. */
  authoritativeFound: boolean;
}
