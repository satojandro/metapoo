// Reading transaction responses. The keeper never trusts a transaction's top-level status to
// mean "the swap happened": ft_transfer_call succeeds at the top level even when the receiver
// refunds everything. Value moved is measured from balances before and after (buyback.js);
// this module only extracts the hash, a failure detail and the logs.

export const OUTCOME = Object.freeze({
  RETURNED: 'returned',
  SWAPPED: 'swapped',
  UNWRAPPED: 'unwrapped',
  SKIPPED: 'skipped',
  SIZED: 'sized',
  NOTHING: 'nothing_to_do',
  FAILED: 'failed',
  OK: 'ok',
});

// The board logs this when mPOO arrives from an account other than buyback_account, and refunds it.
export const REVENUE_REJECTED = 'revenue_rejected';

const MAX_DETAIL = 500;

function safeStringify(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(text) {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

export function txHashOf(result) {
  return result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null;
}

// Every receipt's failure, joined; null when none failed.
function failures(result) {
  const parts = [];
  const status = result?.status;
  if (status && typeof status === 'object' && 'Failure' in status) parts.push(safeStringify(status.Failure));
  const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
  for (const r of receipts) {
    const s = r?.outcome?.status;
    if (s && typeof s === 'object' && 'Failure' in s) parts.push(safeStringify(s.Failure));
  }
  return parts.length ? truncate(parts.join(' | ')) : null;
}

export function logsOf(result) {
  const receipts = Array.isArray(result?.receipts_outcome) ? result.receipts_outcome : [];
  return receipts.flatMap((r) => (Array.isArray(r?.outcome?.logs) ? r.outcome.logs : []));
}

// { txHash, failure } for a response; failure is a short text or null.
export function readResult(result) {
  const status = result?.status;
  const known = status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status || 'Failure' in status);
  return {
    txHash: txHashOf(result),
    failure: known ? failures(result) : truncate(`unrecognised transaction status: ${safeStringify(status)}`),
  };
}

// Detail for an exception thrown while signing, sending or waiting.
export function errorDetail(error) {
  const parts = [error?.name, error?.message, error?.type];
  if (error?.context) parts.push(safeStringify(error.context));
  if (error?.cause) parts.push(safeStringify(error.cause?.message ?? error.cause));
  return truncate(parts.filter(Boolean).join(': ') || safeStringify(error) || String(error));
}
