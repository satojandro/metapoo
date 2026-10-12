import type { BountyStatus, BountySummary } from "./types";

export type FundingDisplay =
  | { kind: "funded"; label: "Funded" }
  | { kind: "unfunded_draft"; label: "Unfunded draft" }
  | { kind: "cancelled"; label: "Cancelled (unfunded)" };

/**
 * "Funded" requires confirmed escrow — never a draft record or local save.
 * Escrow confirmation alone is not enough if status is still DRAFT/CANCELLED.
 */
export function fundingDisplay(bounty: Pick<
  BountySummary,
  "status" | "escrowConfirmed" | "fundedAtNs"
>): FundingDisplay {
  if (bounty.status === "CANCELLED") {
    return { kind: "cancelled", label: "Cancelled (unfunded)" };
  }
  if (
    bounty.status === "DRAFT" ||
    !bounty.escrowConfirmed ||
    bounty.fundedAtNs === null
  ) {
    return { kind: "unfunded_draft", label: "Unfunded draft" };
  }
  return { kind: "funded", label: "Funded" };
}

/** Browse default: only opportunities with confirmed escrow that are not drafts. */
export function isFundedOpportunity(bounty: BountySummary): boolean {
  return fundingDisplay(bounty).kind === "funded";
}

export function isOpenForPainting(status: BountyStatus): boolean {
  return status === "ACTIVE" || status === "REVIEW";
}
