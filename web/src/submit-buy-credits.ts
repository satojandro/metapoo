/**
 * Prepaid credit purchase orchestration.
 *
 * Confirmation is receipt-driven, then `get_credits` is re-read. A wallet
 * approval alone never increments the displayed balance. Unknown broadcasts
 * are not auto-retried.
 */

import { explorerUrl } from "@shared/board-rules.ts";
import type { NetworkId } from "@shared/types.ts";
import {
  BUY_CREDITS_GAS,
  buildBuyCreditsNearArgs,
  buildFtTransferCallArgs,
  FT_TRANSFER_CALL_DEPOSIT,
  FT_TRANSFER_CALL_GAS,
  type BuyQuote,
  type PayAsset,
} from "./buy-credits";
import { CONTRACT_ID } from "./config";
import {
  hasRecognizedTxSuccess,
  isUserRejection,
  parseTxOutcome,
} from "./tx-outcome";
import {
  signAndSendBuyCreditsNear,
  signAndSendBuyCreditsToken,
} from "./wallet";

export type BuyProgress =
  | { phase: "wallet_prompt"; detail: string }
  | { phase: "submitted"; transactionId: string; explorer: string | null }
  | { phase: "reconciling"; transactionId: string; explorer: string | null };

export type BuyFailureCode =
  | "user_rejected"
  | "wrong_network"
  | "insufficient_funds"
  | "price_changed"
  | "not_registered"
  | "already_registered"
  | "invalid_amount"
  | "below_minimum"
  | "float_full"
  | "token_transfer_failed"
  | "paused"
  | "stale_read"
  | "unknown_broadcast"
  | "failed";

export type SubmitBuyResult =
  | {
      status: "confirmed";
      title: string;
      message: string;
      transactionId: string;
      explorerUrl: string | null;
      creditsAfter: bigint;
    }
  | {
      status: "confirmation_delayed";
      title: string;
      message: string;
      transactionId: string | null;
      explorerUrl: string | null;
      creditsAfter: bigint | null;
    }
  | {
      status: "failed";
      code: BuyFailureCode;
      title: string;
      message: string;
      transactionId: string | null;
      explorerUrl: string | null;
      /** Always the pre-purchase balance — never an optimistic bump. */
      creditsAfter: bigint | null;
    };

export interface SubmitBuyInput {
  quote: BuyQuote;
  accountId: string;
  networkId: NetworkId;
  pageNetwork: NetworkId;
  tokenContractId: string;
  /** Credits observed before the wallet prompt (`null` = unregistered). */
  creditsBefore: bigint | null;
  readCredits: (accountId: string) => Promise<bigint | null>;
  onProgress?: (progress: BuyProgress) => void;
}

/**
 * Map a refusal to the contract's own code.
 *
 * The board returns one code per cause: AccountNotRegistered, InvalidPurchaseAmount,
 * BelowMinimumCredits, FloatCapExceeded, CreditOverflow, PriceChanged,
 * AlreadyRegistered. They arrive inside Rust's assertion preamble, so match on the
 * code substring rather than the start of the message.
 */
function classifyFailure(message: string): { code: BuyFailureCode; title: string } {
  const lower = message.toLowerCase();
  if (lower.includes("accountnotregistered")) {
    return { code: "not_registered", title: "Registration required" };
  }
  if (lower.includes("alreadyregistered")) {
    return { code: "already_registered", title: "Already registered" };
  }
  if (lower.includes("pricechanged")) {
    return { code: "price_changed", title: "Price changed" };
  }
  if (lower.includes("floatcapexceeded")) {
    return { code: "float_full", title: "Prepaid paint sold out" };
  }
  if (lower.includes("invalidpurchaseamount")) {
    return { code: "invalid_amount", title: "Amount must be an exact multiple of the price" };
  }
  if (lower.includes("belowminimumcredits")) {
    return { code: "below_minimum", title: "Fewer credits than the minimum you asked for" };
  }
  if (lower.includes("paused")) {
    return { code: "paused", title: "Purchases paused" };
  }
  if (lower.includes("insufficient") || lower.includes("lack of funds")) {
    return { code: "insufficient_funds", title: "Not enough funds" };
  }
  if (lower.includes("ft_") || lower.includes("transfer")) {
    return { code: "token_transfer_failed", title: "Token transfer failed" };
  }
  return { code: "failed", title: "Purchase failed" };
}

export async function submitBuyCredits(input: SubmitBuyInput): Promise<SubmitBuyResult> {
  const creditsBefore = input.creditsBefore;

  if (input.networkId !== input.pageNetwork) {
    return {
      status: "failed",
      code: "wrong_network",
      title: "Wrong network",
      message: `This app is using ${input.pageNetwork}. Switch your wallet network and try again.`,
      transactionId: null,
      explorerUrl: null,
      creditsAfter: creditsBefore,
    };
  }

  if (!CONTRACT_ID) {
    return {
      status: "failed",
      code: "failed",
      title: "Paid painting not available",
      message: "No board contract is configured on this page.",
      transactionId: null,
      explorerUrl: null,
      creditsAfter: creditsBefore,
    };
  }

  input.onProgress?.({
    phase: "wallet_prompt",
    detail: "Approve the purchase in your wallet.",
  });

  let outcome: unknown;
  try {
    outcome = await sendPurchase(input.quote, input.tokenContractId);
  } catch (error) {
    if (isUserRejection(error)) {
      return {
        status: "failed",
        code: "user_rejected",
        title: "Purchase cancelled",
        message: "No credits were bought. Your balance is unchanged.",
        transactionId: null,
        explorerUrl: null,
        creditsAfter: creditsBefore,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyFailure(message);
    return {
      status: "failed",
      code: classified.code,
      title: classified.title,
      message: `${message} Your credit balance was not changed.`,
      transactionId: null,
      explorerUrl: null,
      creditsAfter: creditsBefore,
    };
  }

  const parsed = parseTxOutcome(outcome);
  const explorer =
    parsed.transactionHash && input.networkId !== "mock"
      ? explorerUrl(input.networkId, parsed.transactionHash)
      : null;

  if (parsed.status === "failed") {
    const detail = parsed.failureMessage ?? "The purchase failed on chain.";
    const classified = classifyFailure(detail);
    return {
      status: "failed",
      code: classified.code,
      title: classified.title,
      message: `${detail} Your credit balance was not changed.`,
      transactionId: parsed.transactionHash,
      explorerUrl: explorer,
      creditsAfter: creditsBefore,
    };
  }

  if (!hasRecognizedTxSuccess(parsed) || !parsed.transactionHash) {
    return {
      status: "confirmation_delayed",
      title: "Purchase status unclear",
      message:
        "A wallet response came back without a clear success receipt. Credits were not updated here. Refresh balances — do not buy again until you know whether it landed.",
      transactionId: parsed.transactionHash,
      explorerUrl: explorer,
      creditsAfter: creditsBefore,
    };
  }

  input.onProgress?.({
    phase: "submitted",
    transactionId: parsed.transactionHash,
    explorer,
  });
  input.onProgress?.({
    phase: "reconciling",
    transactionId: parsed.transactionHash,
    explorer,
  });

  let creditsAfter: bigint | null;
  try {
    creditsAfter = await input.readCredits(input.accountId);
  } catch {
    return {
      status: "confirmation_delayed",
      title: "Purchase sent — balance unread",
      message:
        "The transaction looked successful, but credits could not be re-read yet. Refresh balances. Do not auto-retry.",
      transactionId: parsed.transactionHash,
      explorerUrl: explorer,
      creditsAfter: creditsBefore,
    };
  }

  if (creditsAfter === null) {
    return {
      status: "failed",
      code: "stale_read",
      title: "Credits still unregistered",
      message:
        "The purchase returned success, but get_credits is still null. Refresh and check the explorer link before trying again.",
      transactionId: parsed.transactionHash,
      explorerUrl: explorer,
      creditsAfter: null,
    };
  }

  const expectedMin =
    (creditsBefore ?? 0n) + BigInt(input.quote.quantity);
  if (creditsAfter < expectedMin) {
    return {
      status: "confirmation_delayed",
      title: "Purchase sent — credits not yet visible",
      message: `Expected at least ${expectedMin} credits after buying ${input.quote.quantity}. Read ${creditsAfter}. Refresh before buying again.`,
      transactionId: parsed.transactionHash,
      explorerUrl: explorer,
      creditsAfter,
    };
  }

  return {
    status: "confirmed",
    title: "Credits loaded",
    message: `You now have ${creditsAfter} credit${creditsAfter === 1n ? "" : "s"}.`,
    transactionId: parsed.transactionHash,
    explorerUrl: explorer,
    creditsAfter,
  };
}

async function sendPurchase(quote: BuyQuote, tokenContractId: string): Promise<unknown> {
  const asset: PayAsset = quote.asset;
  if (asset === "near") {
    const args = buildBuyCreditsNearArgs(quote);
    return signAndSendBuyCreditsNear({
      contractId: CONTRACT_ID,
      registrationDeposit: quote.registrationDeposit,
      registrationGas: BUY_CREDITS_GAS,
      minCredits: args.min_credits,
      expectedPrice: args.expected_price,
      purchaseDeposit: quote.purchaseAmount,
      purchaseGas: BUY_CREDITS_GAS,
    });
  }
  const ft = buildFtTransferCallArgs({
    boardContractId: CONTRACT_ID,
    quote,
  });
  return signAndSendBuyCreditsToken({
    tokenContractId,
    boardContractId: CONTRACT_ID,
    registrationDeposit: quote.registrationDeposit,
    registrationGas: BUY_CREDITS_GAS,
    amount: ft.amount,
    msg: ft.msg,
    gas: FT_TRANSFER_CALL_GAS,
    deposit: FT_TRANSFER_CALL_DEPOSIT,
  });
}
