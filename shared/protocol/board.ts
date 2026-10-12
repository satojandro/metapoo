/**
 * Paid board / pressure / paint ledger wire types (R1 prototype).
 * Large integers and nanoseconds are decimal strings at API boundaries.
 * Existing `shared/types.ts` remains the free-schema compatibility layer.
 */

/** Chain + board identity for every paid board payload. */
export interface BoardIdentity {
  /** NEAR genesis / network identity string agreed at freeze. */
  chainId: string;
  /** Board contract account id. */
  boardAccountId: string;
  /** Board epoch; revisions are monotonic within an epoch. */
  boardEpoch: string;
}

export type PaintLedgerUnit = "TOILET";

export interface PressureConfigV1 {
  version: string;
  regionSize: number;
  baseCost: string;
  maxCost: string;
  heatCap: string;
  heatIncrement: string;
  decayPerSecond: string;
  surchargeNumerator: string;
  surchargeDenominator: string;
  effectiveAtSeconds: string;
  /** Advisory quote TTL in nanoseconds from observation. Fixture: 30s. */
  quoteTtlNs: string;
}

export interface PaidBoardMetadata extends BoardIdentity {
  schemaVersion: number;
  width: number;
  height: number;
  paletteVersion: string;
  /** Monotonic successful placement counter for this epoch; decimal string. */
  revision: string;
  pricingVersion: string;
  paintTokenAccountId: string;
  ledgerUnit: PaintLedgerUnit;
  pressure: PressureConfigV1;
  overwritePolicy: "open_wall";
  sponsorshipEnabled: false;
  writesPaused: boolean;
}

export interface QuoteRequest {
  x: number;
  y: number;
  /** Wire color index (maps from UI colorIndex). */
  color: number;
  accountId: string;
}

export interface QuoteView {
  cost: string;
  regionId: number;
  cooledHeat: string;
  pricingVersion: string;
  observedAtNs: string;
  expiresAtNs: string;
  balance: string;
  revision: string;
}

export interface PaidDrawArgs {
  x: number;
  y: number;
  color: number;
  maxCost: string;
  pricingVersion: string;
  expiresAtNs: string;
  /** Account-scoped sequential nonce; must equal last+1. */
  actionNonce: string;
  /** Required for zero-deposit session draw; omit for wallet paint. */
  sessionId?: string;
}

export interface AccountPaintView {
  accountId: string;
  balance: string;
  lastActionNonce: string;
  /** Bounded recent outcome for reconciliation after uncertain broadcast. */
  lastOutcome: PaintActionOutcome | null;
}

export type PaintActionStatus =
  | "accepted"
  | "rejected"
  | "noop_same_color"
  | "insufficient_balance"
  | "expired_quote"
  | "version_mismatch"
  | "nonce_rejected"
  | "session_rejected";

export interface PaintActionOutcome {
  actionNonce: string;
  status: PaintActionStatus;
  chargedCost: string | null;
  revision: string | null;
  operationId: string;
  observedAtNs: string;
}

export interface RegionPriceView {
  regionId: number;
  cooledHeat: string;
  cost: string;
  updatedAtSeconds: string;
}

export interface PaintPackOffer {
  packId: string;
  scheduleVersion: string;
  /** Exact FT amount required; wrong amounts refund. */
  amountMpoo: string;
  paintCreditToilet: string;
  label: string;
}

export interface FtPurchaseMessageV1 {
  version: 1;
  action: "buy_paint_pack";
  packId: string;
  scheduleVersion: string;
  purchaseRef: string;
}

export interface PaintSessionRegistration {
  publicKey: string;
  maxTotalCost: string;
  expiresAtNs: string;
  boardEpoch: string;
}

export interface PaintSessionView {
  sessionId: string;
  publicKey: string;
  remainingBudget: string;
  expiresAtNs: string;
  boardEpoch: string;
  revoked: boolean;
}

/** Successful placement event mpoo_board/2.0.0/draw fields. */
export interface BoardDrawEventV2 {
  standard: "mpoo_board";
  version: "2.0.0";
  event: "draw";
  data: {
    boardEpoch: string;
    revision: string;
    x: number;
    y: number;
    color: number;
    artist: string;
    writtenAtNs: string;
    paletteVersion: string;
    costToilet: string;
    pricingVersion: string;
    actionNonce: string;
  };
}
