/**
 * Local Art Bounty page types.
 * Amounts and nanosecond timestamps are decimal strings — never floats.
 * Live views map from contract snake_case via `view-map.ts`.
 */

/** Lifecycle vocabulary from the Art Bounties escrow contract. */
export type BountyStatus =
  | "DRAFT"
  | "ACTIVE"
  | "REVIEW"
  | "AWARDED"
  | "EXPIRED"
  | "CANCELLED";

/** Which data source backs the page. Fixture never claims live escrow. */
export type BountyAdapterMode = "fixture" | "live";

export interface BountyCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BountyPayoutRecipient {
  accountId: string;
  /** Basis points; contract requires sum 10000. */
  shareBps: number;
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

/** Submission proposal state from the escrow contract / protocol. */
export type BountySubmissionState = "OPEN" | "FINALIZED" | "WITHDRAWN";

export interface BountySubmissionStub {
  id: string;
  proposerAccountId: string;
  state: BountySubmissionState;
  snapshotId: string | null;
  recipientCount: number;
  /** Consent / split fields when the adapter has them (live or rich fixtures). */
  recipients: BountyPayoutRecipient[];
  consentDigest: string | null;
  approvedAccounts: string[];
}

export type BountyClaimKind = "AWARD" | "REFUND";
export type BountyClaimStatus = "AVAILABLE" | "PENDING" | "PAID";

export interface BountyClaimStub {
  id: string;
  bountyId: string;
  beneficiaryAccountId: string;
  /** Decimal string amount (smallest units). */
  amount: string;
  kind: BountyClaimKind;
  status: BountyClaimStatus;
}

export interface BountyDetail extends BountySummary {
  termsVersion: string;
  briefHash: string;
  createdAtNs: string;
  winningSubmissionId: string | null;
  submissions: BountySubmissionStub[];
  claims: BountyClaimStub[];
  /** NEAR storage prepaid estimate shown separately from the MPOO award. */
  nearStorageDeposit: string;
  /** Advisory gas budget label (NEAR), never mixed into the award amount. */
  nearGasBudget: string;
  /** Escrow contract account when known (live). */
  escrowAccountId: string | null;
  /** Decimal string escrow held (live); null in fixture when not modelled. */
  escrowHeld: string | null;
}

export interface BountyListFilters {
  /** When true (default browse), only escrow-confirmed funded opportunities. */
  fundedOnly: boolean;
  status: BountyStatus | "ALL";
  query: string;
  /** Resume live listing from this contract index (continuation after truncation). */
  fromIndex?: number;
}

export type BountyListResult =
  | {
      ok: true;
      items: BountySummary[];
      /**
       * True when the adapter stopped before exhausting `next_from_index`
       * (safety page cap). Callers must not treat the list as complete.
       */
      truncated?: boolean;
      /** Next contract index when truncated; null when fully drained. */
      nextFromIndex?: number | null;
    }
  | { ok: false; error: "SERVICE_UNAVAILABLE" | "EMPTY" | "NO_MATCHES"; message?: string };

export type BountyDetailResult =
  | {
      ok: true;
      bounty: BountyDetail;
      /** True when submissions and/or claims were truncated by the page cap. */
      truncated?: boolean;
    }
  | {
      ok: false;
      error: "NOT_FOUND" | "SERVICE_UNAVAILABLE" | "INDEX_LAG" | "CONTRACT_UNSET";
      message?: string;
    };

/** Whether the UI may offer a live funding CTA (still requires explicit confirm). */
export interface BountyFundingGate {
  /** True only when `VITE_BOUNTY_FUNDING_ENABLED=true`. Default false. */
  enabled: boolean;
  /** Short UI copy explaining the gate or confirmation requirement. */
  reason: string;
  /** Confirmation text shown before any fund action when enabled. */
  confirmationCopy: string;
}

/**
 * Adapter for browse / detail / create.
 * Fixture is default. Live uses view calls only until funding is gated on.
 */
export interface BountyAdapter {
  readonly mode: BountyAdapterMode;
  listBounties(filters: BountyListFilters): Promise<BountyListResult>;
  getBounty(id: string): Promise<BountyDetailResult>;
  /** Funding CTA policy — never silently enables live transfers. */
  getFundingGate(): BountyFundingGate;
}

export interface BountyPageServices {
  /** Current path; when omitted, reads `window.location.pathname`. */
  pathname?: string;
  /** Search string including `?`; when omitted, reads `window.location.search`. */
  search?: string;
  /** Navigate helper for CTAs; falls back to `location.assign`. */
  navigate?: (path: string) => void;
  /** Optional override; defaults to env-selected adapter (fixture unless contract set). */
  bounties?: BountyAdapter;
}

export type DisposeFn = () => void;
