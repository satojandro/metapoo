/**
 * Helpers for reading a NEAR `FinalExecutionOutcome` after the wallet returns.
 *
 * The wallet object shape can vary slightly by connector version, so we only
 * trust string hashes and well-known status keys.
 */

export type TxStatus = "success" | "failed" | "unknown";

export interface ParsedTxOutcome {
  status: TxStatus;
  transactionHash: string | null;
  failureMessage: string | null;
}

/**
 * Pull the transaction hash and success/failure from a wallet result.
 * Returns `unknown` when the shape is too odd to trust — the caller should
 * then confirm with a fresh `get_pixel` read instead of guessing.
 */
export function parseTxOutcome(outcome: unknown): ParsedTxOutcome {
  if (!outcome || typeof outcome !== "object") {
    return { status: "unknown", transactionHash: null, failureMessage: null };
  }

  const record = outcome as Record<string, unknown>;
  const transactionHash = readHash(record);
  const statusValue = record.status;

  if (statusValue && typeof statusValue === "object") {
    const status = statusValue as Record<string, unknown>;
    if ("Failure" in status) {
      return {
        status: "failed",
        transactionHash,
        failureMessage: summarizeFailure(status.Failure),
      };
    }
    if ("SuccessValue" in status || "SuccessReceiptId" in status) {
      return {
        status: "success",
        transactionHash,
        failureMessage: null,
      };
    }
  }

  // Some wallets only return { transaction: { hash } } without a full status.
  if (transactionHash) {
    return { status: "unknown", transactionHash, failureMessage: null };
  }

  return { status: "unknown", transactionHash: null, failureMessage: null };
}

function readHash(record: Record<string, unknown>): string | null {
  const transaction = record.transaction;
  if (transaction && typeof transaction === "object") {
    const hash = (transaction as { hash?: unknown }).hash;
    if (typeof hash === "string" && hash.length > 0) {
      return hash;
    }
  }
  const transactionOutcome = record.transaction_outcome;
  if (transactionOutcome && typeof transactionOutcome === "object") {
    const id = (transactionOutcome as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  if (typeof record.transaction_hash === "string") {
    return record.transaction_hash;
  }
  return null;
}

function summarizeFailure(failure: unknown): string {
  if (typeof failure === "string") {
    return failure;
  }
  try {
    return JSON.stringify(failure);
  } catch {
    return "The transaction failed on chain.";
  }
}

/** Detect a user closing / rejecting the wallet prompt (recoverable). */
export function isUserRejection(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("reject") ||
    message.includes("cancel") ||
    message.includes("denied") ||
    message.includes("closed")
  );
}
