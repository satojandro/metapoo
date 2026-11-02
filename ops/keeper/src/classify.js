// Outcome classification for one distribute_* call.
//
// The contract rejects a call made before `distribution_interval_ns` has passed with an
// error whose text contains this code. That is the normal "someone already distributed this
// hour" case, so the keeper treats it as success. If REV-D names the error differently,
// change it here and nowhere else.
export const TOO_SOON_CODE = 'DistributionTooSoon';

export const OUTCOME = Object.freeze({
  DISTRIBUTED: 'distributed',
  TOO_SOON: 'too_soon',
  FAILED: 'failed',
});

const MAX_DETAIL = 500;

function safeStringify(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text) {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

export function txHashOf(result) {
  return result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null;
}

// Receipts that failed even though the transaction as a whole succeeded. The contract's
// callbacks restore amounts when an outgoing transfer fails, so this is informational: the
// next distribution retries. Logged so a persistent failure (e.g. unregistered storage on
// the mPOO contract) is visible.
function failedReceiptCount(result) {
  const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
  return receipts.filter((r) => r?.outcome?.status && 'Failure' in r.outcome.status).length;
}

// Classify a transaction response (RPC `tx` result shape: { status, transaction, ... }).
export function classifyResult(result) {
  const txHash = txHashOf(result);
  const status = result?.status;

  if (status && typeof status === 'object') {
    if ('SuccessValue' in status || 'SuccessReceiptId' in status) {
      const failedReceipts = failedReceiptCount(result);
      return {
        outcome: OUTCOME.DISTRIBUTED,
        txHash,
        ...(failedReceipts > 0 ? { failedReceipts } : {}),
      };
    }
    if ('Failure' in status) {
      const detail = safeStringify(status.Failure);
      return {
        outcome: detail.includes(TOO_SOON_CODE) ? OUTCOME.TOO_SOON : OUTCOME.FAILED,
        txHash,
        detail: truncate(detail),
      };
    }
  }

  return {
    outcome: OUTCOME.FAILED,
    txHash,
    detail: truncate(`unrecognised transaction status: ${safeStringify(status)}`),
  };
}

// Classify an exception thrown while signing, sending or waiting for a transaction.
export function classifyError(error) {
  const parts = [error?.name, error?.message, error?.type];
  if (error?.context) parts.push(safeStringify(error.context));
  if (error?.cause) parts.push(safeStringify(error.cause?.message ?? error.cause));
  const detail = parts.filter(Boolean).join(': ') || safeStringify(error) || String(error);
  const txHash = error?.txHash ?? error?.transactionHash ?? null;
  return {
    outcome: detail.includes(TOO_SOON_CODE) ? OUTCOME.TOO_SOON : OUTCOME.FAILED,
    txHash,
    detail: truncate(detail),
  };
}

// Exit non-zero only when every call failed for a reason other than "too soon".
export function exitCodeFor(results) {
  if (results.length === 0) return 1;
  return results.every((r) => r.outcome === OUTCOME.FAILED) ? 1 : 0;
}
