/**
 * Prepaid credit purchase helpers for schema-4 paid boards.
 *
 * Pure quoting uses integer decimal-string arithmetic only — never Number
 * multiplication for yocto amounts. Wallet send helpers live in wallet.ts;
 * receipt orchestration lives in submit-buy-credits.ts.
 */

import { formatUnits } from "./paint-wallet";
export { TOKEN_PAYMENTS_ENABLED } from "./payment-flags";

/** Exact registration deposit required by `register_credit_account` (0.01 NEAR). */
export const REGISTRATION_YOCTO = "10000000000000000000000";

/** Prepaid gas for board register / buy_credits_near (30 Tgas). */
export const BUY_CREDITS_GAS = "30000000000000";

/**
 * Prepaid gas for `ft_transfer_call` (100 Tgas): token forward + board
 * `ft_on_transfer` + resolver. The token itself requires ≥30 Tgas alone.
 */
export const FT_TRANSFER_CALL_GAS = "100000000000000";

/** NEP-141 requires exactly 1 yoctoNEAR on `ft_transfer_call`. */
export const FT_TRANSFER_CALL_DEPOSIT = "1";

export type PayAsset = "near" | "token";

export interface PaymentConfigView {
  mpooToken: string;
  nearPerCredit: string;
  mpooPerCredit: string;
  registrationFee: string;
}

export interface BuyLineItem {
  label: string;
  amountLabel: string;
}

export interface BuyQuote {
  quantity: number;
  asset: PayAsset;
  /** Decimal string passed as min_credits. */
  minCredits: string;
  /** On-chain price the purchase locks to (NEAR or token units per credit). */
  expectedPrice: string;
  /**
   * Attached NEAR deposit for the purchase FunctionCall (quantity × near price),
   * or the FT `amount` for mPOO / test-token purchases.
   */
  purchaseAmount: string;
  /** Separate registration deposit, or null when already registered. */
  registrationDeposit: string | null;
  /** NEAR attached across board actions in one wallet tx (register + buy). */
  totalNearAttached: string;
  lineItems: BuyLineItem[];
  tokenLabel: string;
}

function requireUnits(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    throw new Error(`Invalid ${label}`);
  }
  return amount;
}

/** Exact product of a positive decimal-string unit price and a positive integer quantity. */
export function multiplyUnits(unitPrice: string, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Invalid quantity");
  }
  return (requireUnits(unitPrice, "unit price") * BigInt(quantity)).toString();
}

export function parsePaymentConfig(raw: Record<string, unknown>): PaymentConfigView {
  const mpooToken = raw.mpoo_token;
  if (typeof mpooToken !== "string" || !/^[a-z0-9._-]{2,64}$/.test(mpooToken)) {
    throw new Error("Invalid token");
  }
  const nearPerCredit = String(raw.near_per_credit);
  const mpooPerCredit = String(raw.mpoo_per_credit);
  requireUnits(nearPerCredit, "near_per_credit");
  requireUnits(mpooPerCredit, "mpoo_per_credit");
  const registrationFee =
    raw.registration_fee === undefined || raw.registration_fee === null
      ? REGISTRATION_YOCTO
      : String(raw.registration_fee);
  requireUnits(registrationFee, "registration_fee");
  return {
    mpooToken,
    nearPerCredit,
    mpooPerCredit,
    registrationFee,
  };
}

/**
 * Build an exact purchase quote.
 * `creditsBalance === null` means the account is not registered yet.
 */
export function quoteBuyCredits(input: {
  config: PaymentConfigView;
  quantity: number;
  asset: PayAsset;
  creditsBalance: bigint | null;
  /** mainnet → "mPOO"; otherwise "test token" (unless `tokenSymbol` is given). */
  network: string;
  /** Token symbol from verified `ft_metadata`; preferred over the network fallback. */
  tokenSymbol?: string;
  /** FT decimals from `ft_metadata` (required for token quotes). */
  tokenDecimals?: number;
}): BuyQuote {
  const { config, quantity, asset, creditsBalance, network } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Invalid quantity");
  }
  const tokenLabel = input.tokenSymbol || (network === "mainnet" ? "mPOO" : "test token");
  const needsRegistration = creditsBalance === null;
  const registrationDeposit = needsRegistration ? config.registrationFee : null;
  const minCredits = String(quantity);

  if (asset === "near") {
    const expectedPrice = config.nearPerCredit;
    const purchaseAmount = multiplyUnits(expectedPrice, quantity);
    const totalNearAttached = registrationDeposit
      ? (BigInt(registrationDeposit) + BigInt(purchaseAmount)).toString()
      : purchaseAmount;
    const lineItems: BuyLineItem[] = [
      {
        label: `${quantity} credit${quantity === 1 ? "" : "s"}`,
        amountLabel: `${formatUnits(purchaseAmount, 24)} NEAR`,
      },
    ];
    if (registrationDeposit) {
      // "One-time account setup", not the contract's "First-time setup (storage)": the
      // player is opening an account on the board, not buying storage (review D).
      lineItems.push({
        label: "One-time account setup",
        amountLabel: `${formatUnits(registrationDeposit, 24)} NEAR`,
      });
    }
    return {
      quantity,
      asset,
      minCredits,
      expectedPrice,
      purchaseAmount,
      registrationDeposit,
      totalNearAttached,
      lineItems,
      tokenLabel,
    };
  }

  const decimals = input.tokenDecimals;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("Invalid token decimals");
  }
  const expectedPrice = config.mpooPerCredit;
  const purchaseAmount = multiplyUnits(expectedPrice, quantity);
  const totalNearAttached = registrationDeposit ?? "0";
  const lineItems: BuyLineItem[] = [
    {
      label: `${quantity} credit${quantity === 1 ? "" : "s"}`,
      amountLabel: `${formatUnits(purchaseAmount, decimals)} ${tokenLabel}`,
    },
  ];
  if (registrationDeposit) {
    lineItems.push({
      label: "One-time account setup",
      amountLabel: `${formatUnits(registrationDeposit, 24)} NEAR`,
    });
  }
  return {
    quantity,
    asset,
    minCredits,
    expectedPrice,
    purchaseAmount,
    registrationDeposit,
    totalNearAttached,
    lineItems,
    tokenLabel,
  };
}

/** Args for `buy_credits_near`. */
export function buildBuyCreditsNearArgs(quote: BuyQuote): {
  min_credits: string;
  expected_price: string;
} {
  if (quote.asset !== "near") {
    throw new Error("NEAR quote required");
  }
  return {
    min_credits: quote.minCredits,
    expected_price: quote.expectedPrice,
  };
}

/** Args for token `ft_transfer_call` (msg is JSON for the board). */
export function buildFtTransferCallArgs(input: {
  boardContractId: string;
  quote: BuyQuote;
}): {
  receiver_id: string;
  amount: string;
  msg: string;
} {
  if (input.quote.asset !== "token") {
    throw new Error("Token quote required");
  }
  return {
    receiver_id: input.boardContractId,
    amount: input.quote.purchaseAmount,
    msg: JSON.stringify({
      min_credits: input.quote.minCredits,
      expected_price: input.quote.expectedPrice,
    }),
  };
}

/** True when the displayed balance must not move after a failed / rejected buy. */
export function creditsUnchangedAfterFailure(
  before: bigint | null,
  after: bigint | null,
): boolean {
  return before === after;
}

/**
 * `get_mpoo_sales_today()` (REV-B). Absent on older boards, which means the
 * token path stays closed.
 */
export interface MpooSalesToday {
  dayIndex: bigint;
  soldToday: bigint;
  cap: bigint;
  remaining: bigint;
  /** Nanoseconds since the epoch when the UTC-day counter resets. */
  resetsAtNs: bigint;
}

function requireNonNegative(value: unknown, label: string): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    throw new Error(`Invalid ${label}`);
  }
  return BigInt(text);
}

export function parseMpooSalesToday(raw: unknown): MpooSalesToday {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid mPOO sales view");
  }
  const r = raw as Record<string, unknown>;
  return {
    dayIndex: requireNonNegative(r.day_index, "day_index"),
    soldToday: requireNonNegative(r.sold_today, "sold_today"),
    cap: requireNonNegative(r.cap, "cap"),
    remaining: requireNonNegative(r.remaining, "remaining"),
    resetsAtNs: requireNonNegative(r.resets_at_ns, "resets_at_ns"),
  };
}

/**
 * The token checkout is open only when the board reports today's sales and
 * there is room under a non-zero cap. `null` = the view is missing (old board).
 */
export function mpooCheckoutOpen(sales: MpooSalesToday | null | undefined): boolean {
  return !!sales && sales.cap > 0n && sales.remaining > 0n;
}

/**
 * Split a requested quantity between the token (up to today's remaining
 * credits) and NEAR (the rest). Never returns a token quantity above remaining.
 */
export function splitTokenQuantity(
  requested: number,
  remaining: bigint,
): { token: number; near: number } {
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("Invalid quantity");
  }
  if (remaining <= 0n) {
    return { token: 0, near: requested };
  }
  if (BigInt(requested) <= remaining) {
    return { token: requested, near: 0 };
  }
  const token = Number(remaining);
  return { token, near: requested - token };
}

/**
 * A token purchase the board refuses still succeeds as a transaction:
 * `ft_on_transfer` logs `purchase_rejected: <code>` and the token contract
 * returns the tokens. Read the code from the receipt logs, and fall back to
 * the resolver's return value (amount used) when it is "0".
 */
export function findTokenRefund(outcome: unknown): { refunded: boolean; code: string | null } {
  if (!outcome || typeof outcome !== "object") {
    return { refunded: false, code: null };
  }
  const record = outcome as Record<string, unknown>;
  let code: string | null = null;
  const receipts = Array.isArray(record.receipts_outcome) ? record.receipts_outcome : [];
  for (const receipt of receipts) {
    const logs = (receipt as { outcome?: { logs?: unknown } } | null)?.outcome?.logs;
    if (!Array.isArray(logs)) continue;
    for (const log of logs) {
      if (typeof log !== "string") continue;
      const match = /purchase_rejected:\s*([A-Za-z]+)/.exec(log);
      if (match) code = match[1];
    }
  }
  if (code) {
    return { refunded: true, code };
  }
  const status = record.status as Record<string, unknown> | undefined;
  const value = status && typeof status === "object" ? status.SuccessValue : undefined;
  if (typeof value === "string" && value.length > 0) {
    try {
      const used: unknown = JSON.parse(atob(value));
      if (used === "0" || used === 0) {
        return { refunded: true, code: null };
      }
    } catch {
      /* not a resolver amount */
    }
  }
  return { refunded: false, code: null };
}

/** Plain words for a refunded token purchase. */
export function describeTokenRefund(code: string | null, symbol: string): string {
  switch (code) {
    case "MpooDailyCapReached":
      return `Today's ${symbol} credits sold out before your purchase landed. Your ${symbol} was sent back. You can pay with NEAR instead.`;
    case "MpooSalesClosed":
      return `${symbol} sales are closed right now. Your ${symbol} was sent back. You can pay with NEAR instead.`;
    case "PriceChanged":
      return `The ${symbol} price changed before your purchase landed. Your ${symbol} was sent back. Check the new price and try again, or pay with NEAR.`;
    default:
      return `The board did not accept this ${symbol} payment, so your ${symbol} was sent back. You can pay with NEAR instead.`;
  }
}
