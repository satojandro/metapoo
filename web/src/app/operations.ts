/**
 * Shared operation recovery store.
 *
 * Survives page navigation: leaving /wall must not drop a broadcast paint
 * (or other) operation. Wallet secrets are never stored here — only intent
 * metadata, network/account, and hashes when available.
 */

export type OperationKind = "paint" | "bounty_fund" | "print_mint" | "other";

/** Matches the vocabulary in frontend-journeys.md §7. */
export type OperationPhase =
  | "draft"
  | "awaiting_signature"
  | "submitted"
  | "confirmation_delayed"
  | "confirmed"
  | "overwritten"
  | "failed"
  | "cancelled_before_submission";

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  phase: OperationPhase;
  accountId: string | null;
  networkId: string | null;
  transactionId: string | null;
  title: string;
  detail: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Opaque domain payload (coordinates, bounty id, etc.). */
  meta?: Record<string, string | number | boolean | null>;
}

export type OperationListener = (ops: readonly OperationRecord[]) => void;

export interface OperationsStore {
  list(): readonly OperationRecord[];
  get(id: string): OperationRecord | undefined;
  upsert( partial: Omit<OperationRecord, "createdAtMs" | "updatedAtMs"> & {
    createdAtMs?: number;
  }): OperationRecord;
  /** Broadcast / in-flight ops that should not be discarded on route leave. */
  listRecoverable(): readonly OperationRecord[];
  subscribe(listener: OperationListener): () => void;
}

const RECOVERABLE_PHASES: ReadonlySet<OperationPhase> = new Set([
  "awaiting_signature",
  "submitted",
  "confirmation_delayed",
]);

export function createOperationsStore(): OperationsStore {
  const byId = new Map<string, OperationRecord>();
  const listeners = new Set<OperationListener>();

  function emit(): void {
    const snapshot = Object.freeze([...byId.values()]);
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    list() {
      return Object.freeze([...byId.values()]);
    },

    get(id) {
      return byId.get(id);
    },

    upsert(partial) {
      const now = Date.now();
      const existing = byId.get(partial.id);
      const next: OperationRecord = {
        ...partial,
        createdAtMs: existing?.createdAtMs ?? partial.createdAtMs ?? now,
        updatedAtMs: now,
      };
      byId.set(next.id, next);
      emit();
      return next;
    },

    listRecoverable() {
      return Object.freeze(
        [...byId.values()].filter((op) => RECOVERABLE_PHASES.has(op.phase)),
      );
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(Object.freeze([...byId.values()]));
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Stable id for a paint intent (account + cell + time bucket optional). */
export function paintOperationId(input: {
  accountId: string;
  x: number;
  y: number;
  colorIndex: number;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? `${Date.now()}`;
  return `paint:${input.accountId}:${input.x},${input.y}:${input.colorIndex}:${nonce}`;
}
