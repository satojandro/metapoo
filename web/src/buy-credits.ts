/**
 * Prepaid credit purchase helpers for schema-4 paid boards.
 *
 * Pure quoting uses integer decimal-string arithmetic only — never Number
 * multiplication for yocto amounts. Wallet send helpers live in wallet.ts;
 * receipt orchestration lives in submit-buy-credits.ts.
 */

import { formatUnits } from "./paint-wallet";

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
  /** mainnet → "mPOO"; otherwise "test token". */
  network: string;
  /** FT decimals from `ft_metadata` (required for token quotes). */
  tokenDecimals?: number;
}): BuyQuote {
  const { config, quantity, asset, creditsBalance, network } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Invalid quantity");
  }
  const tokenLabel = network === "mainnet" ? "mPOO" : "test token";
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
      lineItems.push({
        label: "First-time setup (storage)",
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
      label: "First-time setup (storage)",
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
