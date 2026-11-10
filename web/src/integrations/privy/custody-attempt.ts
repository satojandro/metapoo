import type { ReadinessRpc } from "../account-readiness";
import { parseTxOutcome } from "../../tx-outcome";
import { custodyKeyPermission, type PendingSelfCustodyKey } from "./self-custody";
import type { HostIdentity, SessionStorage } from "./session";

/**
 * The custody attempt marker.
 *
 * It is written before the wallet opens and exists for one reason: to stop a second key
 * change, or any payment, while one may already be in flight. It is NOT a record of intent —
 * the source of truth is always `view_access_key` on chain.
 *
 * A failed attempt must not outlive itself. A marker that only clears when the intended key
 * state appears is never cleared by an attempt that failed on chain, and every later payment
 * is then refused with advice ("refresh") that cannot possibly help. So the marker also
 * carries the transaction hash as soon as the wallet returns one, which is what makes a
 * terminal failure classifiable, and it can always be settled explicitly by a human.
 */
export interface CustodyAttempt extends HostIdentity {
  publicKey: string;
  kind: PendingSelfCustodyKey["kind"];
  createdAtMs: number;
  /** Recorded immediately after the wallet returns; the only way to classify a failure. */
  transactionHash?: string;
}

export const CUSTODY_ATTEMPT_PREFIX = "metapoo:custody:attempt:";

/**
 * The network is a literal union and the account is a free string, so every helper below
 * rejects a swapped pair at compile time instead of silently keying another account's marker.
 */
type NetworkId = HostIdentity["networkId"];

export function custodyAttemptKey(networkId: NetworkId, accountId: string): string {
  return `${CUSTODY_ATTEMPT_PREFIX}${networkId}:${accountId}`;
}

export function getCustodyAttempt(
  storage: SessionStorage,
  networkId: NetworkId,
  accountId: string,
): CustodyAttempt | null {
  try {
    const raw = storage.getItem(custodyAttemptKey(networkId, accountId));
    if (!raw || raw.length > 2048) return null;
    const value = JSON.parse(raw) as CustodyAttempt;
    if (!value || typeof value !== "object") return null;
    if (value.kind !== "add-full-access" && value.kind !== "remove-own-key") return null;
    if (typeof value.publicKey !== "string" || typeof value.createdAtMs !== "number") return null;
    if (value.transactionHash !== undefined && typeof value.transactionHash !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function setCustodyAttempt(
  storage: SessionStorage,
  networkId: NetworkId,
  accountId: string,
  value: CustodyAttempt | null,
): void {
  const key = custodyAttemptKey(networkId, accountId);
  if (value) storage.setItem(key, JSON.stringify(value));
  else storage.removeItem(key);
}

export type CustodyAttemptState = "none" | "applied" | "failed" | "unknown" | "discarded";

export interface CustodyReconcileResult {
  state: CustodyAttemptState;
  /** The attempt as it stood when this decision was made, for copy and for tests. */
  attempt: CustodyAttempt | null;
}

/** Did the change the attempt was aiming at land? */
function attemptApplied(attempt: CustodyAttempt, permission: unknown): boolean {
  return attempt.kind === "add-full-access"
    ? permission === "FullAccess"
    : permission === null;
}

/**
 * Settle an unresolved attempt, in this order:
 *
 * 1. the key list — a landed change clears the marker however the wallet behaved;
 * 2. the recorded transaction — a failure on chain clears it, because nothing changed;
 * 3. a human override (`discard`) — for an attempt whose outcome was lost.
 *
 * A read failure throws rather than guessing: absence of evidence must never clear the marker.
 * `discard` re-reads the key first, so it can never bury a change that actually landed.
 */
export async function reconcileCustodyAttempt(
  storage: SessionStorage,
  networkId: NetworkId,
  accountId: string,
  rpc: ReadinessRpc,
  options: { discard?: boolean } = {},
): Promise<CustodyReconcileResult> {
  const attempt = getCustodyAttempt(storage, networkId, accountId);
  if (!attempt) return { state: "none", attempt: null };

  const permission = await custodyKeyPermission(rpc, accountId, attempt.publicKey);
  if (attemptApplied(attempt, permission)) {
    setCustodyAttempt(storage, networkId, accountId, null);
    return { state: "applied", attempt };
  }

  if (attempt.transactionHash) {
    try {
      const outcome = parseTxOutcome(
        await rpc("tx", {
          transaction_hash: attempt.transactionHash,
          sender_account_id: accountId,
        }),
      );
      if (outcome.status === "failed") {
        setCustodyAttempt(storage, networkId, accountId, null);
        return { state: "failed", attempt };
      }
      // A success whose key state has not appeared yet is a finality lag, not a resolution.
      if (outcome.status === "success") return { state: "unknown", attempt };
    } catch {
      // The transaction could not be read back. Keep the marker; a human decides.
    }
  }

  if (options.discard) {
    setCustodyAttempt(storage, networkId, accountId, null);
    return { state: "discarded", attempt };
  }
  return { state: "unknown", attempt };
}
