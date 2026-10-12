/**
 * Art Bounty escrow wire types. Escrow liabilities are never paint revenue.
 */

import type { BoardIdentity } from "./board.ts";

export type BountyStatus =
  | "DRAFT"
  | "ACTIVE"
  | "REVIEW"
  | "AWARDED"
  | "EXPIRED"
  | "CANCELLED";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BountyTerms {
  boardId: string;
  crop: CropRect;
  briefUri: string;
  briefHash: string;
  awardAmount: string;
  termsVersion: string;
  fundByNs: string;
  submitByNs: string;
  reviewByNs: string;
}

export interface BountyRecord extends BountyTerms {
  id: string;
  networkId: string;
  escrowAccountId: string;
  sponsor: string;
  status: BountyStatus;
  createdAtNs: string;
  fundedAtNs: string | null;
  winningSubmissionId: string | null;
}

export interface PayoutRecipient {
  accountId: string;
  /** Basis points; all recipients must sum to exactly 10000. */
  shareBps: number;
}

export interface SubmissionProposal {
  id: string;
  bountyId: string;
  proposer: string;
  snapshotId: string;
  manifestHash: string;
  crop: CropRect;
  noteHash: string;
  /** Sorted by accountId for digest stability. */
  recipients: PayoutRecipient[];
  consentDigest: string;
  approvedAccounts: string[];
  state: "OPEN" | "FINALIZED" | "WITHDRAWN";
  createdAtNs: string;
}

export interface ConsentDigestInput {
  networkId: string;
  escrowAccountId: string;
  bountyId: string;
  proposalId: string;
  snapshotId: string;
  manifestHash: string;
  crop: CropRect;
  noteHash: string;
  recipients: PayoutRecipient[];
  termsVersion: string;
}

export type ClaimKind = "AWARD" | "REFUND";
export type ClaimStatus = "AVAILABLE" | "PENDING" | "PAID";

export interface ClaimRecord {
  id: string;
  bountyId: string;
  beneficiary: string;
  amount: string;
  kind: ClaimKind;
  status: ClaimStatus;
  attemptId: string | null;
}

export interface PrintEntitlementView {
  bountyId: string;
  sponsor: string;
  snapshotId: string;
  manifestHash: string;
  crop: CropRect;
  /** Globally scoped key: chain + escrow + bounty id binding. */
  entitlementKey: string;
}

export interface FundBountyFtMessageV1 {
  version: 1;
  action: "fund_bounty";
  bountyId: string;
}

export interface SnapshotReferenceRecord {
  snapshotId: string;
  manifestHash: string;
  board: BoardIdentity;
  width: number;
  height: number;
  finalizedBlockHash: string;
  finalizedBlockHeight: string;
  finalizedBlockTimestampNs: string;
  revision: string;
  cropBoundsValid: true;
}

/** Allocate floor(award * bps / 10000); dust to final sorted recipient. */
export function allocateAwardAmounts(
  awardAmount: bigint,
  recipients: readonly PayoutRecipient[],
): { accountId: string; amount: bigint }[] {
  if (recipients.length === 0) {
    throw new Error("SPLIT_INVALID: no recipients");
  }
  const sorted = [...recipients].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
  );
  const shareSum = sorted.reduce((sum, r) => sum + r.shareBps, 0);
  if (shareSum !== 10_000) {
    throw new Error("SPLIT_INVALID: share_bps must sum to 10000");
  }
  const accounts = new Set(sorted.map((r) => r.accountId));
  if (accounts.size !== sorted.length) {
    throw new Error("SPLIT_INVALID: duplicate recipients");
  }

  const allocated: { accountId: string; amount: bigint }[] = [];
  let remaining = awardAmount;
  for (let i = 0; i < sorted.length; i += 1) {
    const recipient = sorted[i]!;
    if (recipient.shareBps <= 0) {
      throw new Error("SPLIT_INVALID: non-positive share");
    }
    if (i === sorted.length - 1) {
      if (remaining <= 0n) {
        throw new Error("SPLIT_INVALID: zero allocation");
      }
      allocated.push({ accountId: recipient.accountId, amount: remaining });
      break;
    }
    const amount = (awardAmount * BigInt(recipient.shareBps)) / 10_000n;
    if (amount <= 0n) {
      throw new Error("SPLIT_INVALID: zero allocation");
    }
    allocated.push({ accountId: recipient.accountId, amount });
    remaining -= amount;
  }
  return allocated;
}
