/**
 * Map escrow contract JSON (snake_case) ↔ bounty page types (camelCase).
 * Amounts and nanosecond fields stay decimal strings — never Number/float.
 */

import {
  BOUNTY_NEAR_GAS_HINT,
  BOUNTY_NEAR_STORAGE_HINT,
} from "./funding-gate";
import type {
  BountyClaimKind,
  BountyClaimStatus,
  BountyClaimStub,
  BountyCrop,
  BountyDetail,
  BountyPayoutRecipient,
  BountyStatus,
  BountySubmissionState,
  BountySubmissionStub,
  BountySummary,
} from "./types";

/** Raw `BountyView` from the escrow contract. */
export interface ContractBountyView {
  id: string;
  network_id: string;
  escrow_account_id: string;
  sponsor: string;
  board_id: string;
  crop: { x: number; y: number; width: number; height: number };
  brief_uri: string;
  brief_hash: string;
  award_amount: string;
  terms_version: string;
  created_at_ns: string;
  fund_by_ns: string;
  submit_by_ns: string;
  review_by_ns: string;
  status: string;
  funded_at_ns: string | null;
  winning_submission_id: string | null;
  escrow_held: string;
}

/** Raw `SubmissionView` from the escrow contract. */
export interface ContractSubmissionView {
  id: string;
  bounty_id: string;
  proposer: string;
  snapshot_id: string;
  manifest_hash: string;
  crop: { x: number; y: number; width: number; height: number };
  note_hash: string;
  recipients: Array<{ account_id: string; share_bps: number }>;
  consent_digest: string;
  approved_accounts: string[];
  state: string;
  created_at_ns: string;
}

/** Raw `ClaimView` from the escrow contract. */
export interface ContractClaimView {
  id: string;
  bounty_id: string;
  beneficiary: string;
  amount: string;
  kind: string;
  status: string;
  attempt_id: string | null;
}

export interface ContractListPage<T> {
  items: T[];
  from_index: number;
  limit: number;
  total: number;
  next_from_index: number | null;
}

const STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "ACTIVE",
  "REVIEW",
  "AWARDED",
  "EXPIRED",
  "CANCELLED",
]);

export function requireDecimalString(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`VIEW_MAP: ${field} must be a decimal digit string`);
  }
  return value;
}

export function mapCrop(raw: ContractBountyView["crop"]): BountyCrop {
  return {
    x: Number(raw.x),
    y: Number(raw.y),
    width: Number(raw.width),
    height: Number(raw.height),
  };
}

export function mapBountyStatus(raw: string): BountyStatus {
  const upper = raw.trim().toUpperCase();
  if (!STATUSES.has(upper)) {
    throw new Error(`VIEW_MAP: unknown bounty status ${raw}`);
  }
  return upper as BountyStatus;
}

export function mapSubmissionState(raw: string): BountySubmissionState {
  const upper = raw.trim().toUpperCase();
  if (upper === "OPEN" || upper === "PROPOSED") {
    return "OPEN";
  }
  if (upper === "FINALIZED") {
    return "FINALIZED";
  }
  if (upper === "WITHDRAWN" || upper === "REJECTED") {
    return "WITHDRAWN";
  }
  throw new Error(`VIEW_MAP: unknown submission state ${raw}`);
}

export function mapClaimKind(raw: string): BountyClaimKind {
  const upper = raw.trim().toUpperCase();
  if (upper === "AWARD" || upper === "REFUND") {
    return upper;
  }
  throw new Error(`VIEW_MAP: unknown claim kind ${raw}`);
}

export function mapClaimStatus(raw: string): BountyClaimStatus {
  const upper = raw.trim().toUpperCase();
  if (upper === "AVAILABLE" || upper === "PENDING" || upper === "PAID") {
    return upper;
  }
  throw new Error(`VIEW_MAP: unknown claim status ${raw}`);
}

function titleFromBrief(briefUri: string, id: string): string {
  const trimmed = briefUri.trim();
  if (!trimmed) {
    return `Bounty ${id}`;
  }
  // Prefer last path segment when URI-like; otherwise first line of text.
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const seg = url.pathname.split("/").filter(Boolean).pop();
      return seg ? decodeURIComponent(seg) : `Bounty ${id}`;
    }
  } catch {
    // fall through
  }
  const line = trimmed.split(/\r?\n/)[0] ?? trimmed;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/**
 * Escrow is confirmed when the contract reports a funded timestamp and
 * escrow_held > 0 (decimal string compare via BigInt).
 */
export function escrowConfirmedFromView(view: ContractBountyView): boolean {
  if (view.funded_at_ns == null) {
    return false;
  }
  const held = requireDecimalString(view.escrow_held, "escrow_held");
  return BigInt(held) > 0n;
}

export function mapContractBountyToSummary(
  view: ContractBountyView,
): BountySummary {
  const id = String(view.id);
  const awardAmount = requireDecimalString(view.award_amount, "award_amount");
  const status = mapBountyStatus(view.status);
  const fundedAtNs =
    view.funded_at_ns == null
      ? null
      : requireDecimalString(view.funded_at_ns, "funded_at_ns");
  const confirmed = escrowConfirmedFromView(view);

  return {
    id,
    title: titleFromBrief(view.brief_uri, id),
    briefText: view.brief_uri,
    sponsorAccountId: view.sponsor,
    approverAccountId: view.sponsor,
    boardId: view.board_id,
    crop: mapCrop(view.crop),
    awardAmount,
    tokenSymbol: "MPOO",
    status,
    escrowConfirmed: confirmed,
    fundedAtNs,
    fundByNs: requireDecimalString(view.fund_by_ns, "fund_by_ns"),
    submitByNs: requireDecimalString(view.submit_by_ns, "submit_by_ns"),
    reviewByNs: requireDecimalString(view.review_by_ns, "review_by_ns"),
    templateId: null,
  };
}

export function mapContractRecipients(
  raw: ContractSubmissionView["recipients"],
): BountyPayoutRecipient[] {
  return raw.map((r) => ({
    accountId: r.account_id,
    shareBps: Number(r.share_bps),
  }));
}

export function mapContractSubmission(
  view: ContractSubmissionView,
): BountySubmissionStub {
  const recipients = mapContractRecipients(view.recipients ?? []);
  return {
    id: String(view.id),
    proposerAccountId: view.proposer,
    state: mapSubmissionState(view.state),
    snapshotId: view.snapshot_id ? view.snapshot_id : null,
    recipientCount: recipients.length,
    recipients,
    consentDigest: view.consent_digest || null,
    approvedAccounts: [...(view.approved_accounts ?? [])],
  };
}

export function mapContractClaim(view: ContractClaimView): BountyClaimStub {
  return {
    id: String(view.id),
    bountyId: String(view.bounty_id),
    beneficiaryAccountId: view.beneficiary,
    amount: requireDecimalString(view.amount, "amount"),
    kind: mapClaimKind(view.kind),
    status: mapClaimStatus(view.status),
  };
}

export function mapContractBountyToDetail(
  view: ContractBountyView,
  submissions: ContractSubmissionView[] = [],
  claims: ContractClaimView[] = [],
): BountyDetail {
  const summary = mapContractBountyToSummary(view);
  return {
    ...summary,
    termsVersion: view.terms_version,
    briefHash: view.brief_hash,
    createdAtNs: requireDecimalString(view.created_at_ns, "created_at_ns"),
    winningSubmissionId: view.winning_submission_id,
    submissions: submissions.map(mapContractSubmission),
    claims: claims.map(mapContractClaim),
    nearStorageDeposit: BOUNTY_NEAR_STORAGE_HINT,
    nearGasBudget: BOUNTY_NEAR_GAS_HINT,
    escrowAccountId: view.escrow_account_id,
    escrowHeld: requireDecimalString(view.escrow_held, "escrow_held"),
  };
}
