/**
 * Local Art Bounty page types for fixture-backed UI (Wave 0).
 * Coordinator owns the eventual shared protocol freeze; these stay inside
 * `web/src/pages/bounties/**` until that lands.
 *
 * Amounts and nanosecond timestamps are decimal strings — never floats.
 */

/** Lifecycle vocabulary from the Art Bounties implementation contract. */
export type BountyStatus =
  | "DRAFT"
  | "ACTIVE"
  | "REVIEW"
  | "AWARDED"
  | "EXPIRED"
  | "CANCELLED";

export interface BountyCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BountySummary {
  id: string;
  title: string;
  /** Untrusted sponsor brief text — always escape before display. */
  briefText: string;
  sponsorAccountId: string;
  /** Named approver (sponsor in v1). */
  approverAccountId: string;
  boardId: string;
  crop: BountyCrop;
  /** MPOO award amount as a decimal string (smallest units). */
  awardAmount: string;
  tokenSymbol: string;
  status: BountyStatus;
  /**
   * True only when fixture/readback shows confirmed escrow.
   * Drafts and local saves must keep this false.
   */
  escrowConfirmed: boolean;
  fundedAtNs: string | null;
  fundByNs: string;
  submitByNs: string;
  reviewByNs: string;
  /** Optional template id for wall overlay deep links. */
  templateId: string | null;
}

export interface BountySubmissionStub {
  id: string;
  proposerAccountId: string;
  state: "PROPOSED" | "FINALIZED" | "REJECTED";
  snapshotId: string | null;
  recipientCount: number;
}

export interface BountyDetail extends BountySummary {
  termsVersion: string;
  briefHash: string;
  createdAtNs: string;
  winningSubmissionId: string | null;
  submissions: BountySubmissionStub[];
  /** NEAR storage prepaid estimate shown separately from the MPOO award. */
  nearStorageDeposit: string;
  /** Advisory gas budget label (NEAR), never mixed into the award amount. */
  nearGasBudget: string;
}

export interface BountyListFilters {
  /** When true (default browse), only escrow-confirmed funded opportunities. */
  fundedOnly: boolean;
  status: BountyStatus | "ALL";
  query: string;
}

export type BountyListResult =
  | { ok: true; items: BountySummary[] }
  | { ok: false; error: "SERVICE_UNAVAILABLE" | "EMPTY" | "NO_MATCHES" };

export type BountyDetailResult =
  | { ok: true; bounty: BountyDetail }
  | { ok: false; error: "NOT_FOUND" | "SERVICE_UNAVAILABLE" | "INDEX_LAG" };

/** Conceptual adapter — fixture implementation for parallel UI work. */
export interface BountyAdapter {
  listBounties(filters: BountyListFilters): Promise<BountyListResult>;
  getBounty(id: string): Promise<BountyDetailResult>;
}

export interface BountyPageServices {
  /** Current path; when omitted, reads `window.location.pathname`. */
  pathname?: string;
  /** Search string including `?`; when omitted, reads `window.location.search`. */
  search?: string;
  /** Navigate helper for CTAs; falls back to `location.assign`. */
  navigate?: (path: string) => void;
  /** Optional override; defaults to the co-located fixture adapter. */
  bounties?: BountyAdapter;
}

export type DisposeFn = () => void;
