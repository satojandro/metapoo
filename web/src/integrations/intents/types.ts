import type { OperationContext } from "../types";

/** Provider amounts always remain strings in the smallest token unit. */
export interface IntentsToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string | null;
}

export interface FundingQuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  destinationAsset: "nep141:wrap.near";
  depositType: "ORIGIN_CHAIN";
  recipientType: "DESTINATION_CHAIN";
  refundType: "ORIGIN_CHAIN";
  amount: string;
  recipient: string;
  refundTo: string;
  deadline: string;
  depositMode: "SIMPLE" | "MEMO";
  /** Provider-echoed defaults; never replay these as user-supplied quote parameters. */
  confidentiality?: "public";
  quoteWaitingTimeMs?: 0;
  insured?: false;
  appFees?: { recipient: string; fee: number }[];
}

export interface FundingQuote {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: FundingQuoteRequest;
  quote: {
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
    timeEstimate: number;
    depositAddress?: string;
    depositMemo?: string;
    deadline?: string;
    timeWhenInactive?: string;
  };
  /** Keep the signed envelope intact for verification and support exports. */
  raw: Record<string, unknown>;
}

export const PROVIDER_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "INCOMPLETE_DEPOSIT",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
export interface FundingStatus {
  status: ProviderStatus | "UNKNOWN";
  providerStatus: string;
  updatedAt: string;
  quoteResponse: FundingQuote;
  destinationHashes: string[];
  originHashes: string[];
  refundHashes: string[];
  amountOut?: string;
}

export type FundingPhase =
  | "disabled"
  | "editing"
  | "loading_assets"
  | "previewing"
  | "review"
  | "committing"
  | "awaiting_deposit"
  | "deposit_detected"
  | "processing"
  | "incomplete_deposit"
  | "settled_verifying"
  | "needs_unwrap"
  | "funded"
  | "refunded"
  | "failed_needs_review"
  | "expired_unfunded"
  | "unavailable"
  | "identity_changed";

export interface FundingEvidence {
  state: "verified_native" | "verified_wrapped" | "pending";
  transactionHash?: string;
  receiptId?: string;
  amountYocto?: string;
  nativeBalanceYocto?: string;
  spendableBeforeGasYocto?: string;
  message?: string;
}

export interface FundingOperation {
  version: 1;
  id: string;
  context: OperationContext;
  token: IntentsToken;
  quote: FundingQuote;
  createdAtMs: number;
  updatedAtMs: number;
  phase: FundingPhase;
  status?: FundingStatus;
  evidence?: FundingEvidence;
}

export interface FundingSnapshot {
  phase: FundingPhase;
  message: string;
  assets: readonly IntentsToken[];
  preview?: FundingQuote;
  operation?: FundingOperation;
  /** Caller must revalidate before copy/QR too; expiry is not cancellation. */
  canSend: boolean;
}

export interface FundingReadiness {
  state: "absent" | "initializing" | "ready" | "unavailable";
  expectedKeyMatches?: boolean;
  spendableBeforeGasYocto?: string;
}

export interface FundingPolicy {
  enabled: boolean;
  transportVerified: boolean;
  deliveryMode: "native" | "wrapped_then_unwrap";
  nativeDeliveryEvidence: {
    reference: string;
    initializedNamed: boolean;
    initializedImplicit: boolean;
    uninitializedImplicit: boolean;
  };
  sourceAllowlist: readonly { assetId: string; blockchain: string }[];
  playReserveYocto: string;
  /** Origin-chain confirmation requirements, not a universal ten-minute timer. */
  quoteLifetimeMs?: number;
  sendSafetyMarginMs?: number;
}

export interface FundingClient {
  tokens(signal?: AbortSignal): Promise<IntentsToken[]>;
  quote(
    request: FundingQuoteRequest,
    signal?: AbortSignal,
  ): Promise<FundingQuote>;
  status(quote: FundingQuote, signal?: AbortSignal): Promise<FundingStatus>;
  verify(quote: FundingQuote): Promise<boolean>;
}

export interface FundingPreviewInput {
  assetId: string;
  amount: string;
  refundAddress: string;
  refundAddressConfirmed: boolean;
}
