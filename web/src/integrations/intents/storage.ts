import { createAcquisitionStore } from "../operation-store";
import type { DurableStorage } from "../operation-store";
import { object, parseQuote, parseStatus, parseTokens } from "./client";
import type { FundingOperation, FundingPhase } from "./types";

const PREFIX = "metapoo:intents:v1:";
const phases: readonly FundingPhase[] = [
  "disabled",
  "editing",
  "loading_assets",
  "previewing",
  "review",
  "committing",
  "awaiting_deposit",
  "deposit_detected",
  "processing",
  "incomplete_deposit",
  "settled_verifying",
  "needs_unwrap",
  "funded",
  "refunded",
  "failed_needs_review",
  "expired_unfunded",
  "unavailable",
  "identity_changed",
];

export function createIntentsStorage(storage: DurableStorage) {
  const ledger = createAcquisitionStore(storage);
  return {
    durable: storage,
    save(operation: FundingOperation): void {
      const raw = JSON.stringify(operation);
      if (raw.length > 200_000) throw new Error("Payment record is too large");
      // Save provider details before its public ledger pointer or payable rendering.
      storage.setItem(PREFIX + operation.id, raw);
      ledger.save({
        version: 1,
        context: operation.context,
        feature: "intents",
        createdAtMs: operation.createdAtMs,
        updatedAtMs: operation.updatedAtMs,
        phase: operation.phase,
        providerRecordId: operation.id,
        transactionHashes: [
          ...(operation.status?.destinationHashes ?? []),
          ...(operation.status?.originHashes ?? []),
        ],
      });
    },
    load(id: string): FundingOperation | null {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
        throw new Error("Invalid recovery id");
      const raw = storage.getItem(PREFIX + id);
      if (!raw) return null;
      if (raw.length > 200_000) throw new Error("Recovery record is too large");
      try {
        const row = object(JSON.parse(raw));
        const context = object(row.context);
        if (
          row.version !== 1 ||
          row.id !== id ||
          context.operationId !== id ||
          typeof context.accountId !== "string" ||
          !/^[a-z0-9._-]{2,64}$/.test(context.accountId) ||
          context.networkId !== "mainnet" ||
          !Number.isSafeInteger(context.sessionEpoch) ||
          !phases.includes(row.phase as FundingPhase) ||
          !Number.isFinite(row.createdAtMs) ||
          !Number.isFinite(row.updatedAtMs)
        )
          throw new Error("Invalid record");
        const operation = row as unknown as FundingOperation;
        operation.quote = parseQuote(object(row.quote).raw);
        operation.token = parseTokens([row.token])[0];
        if (row.status)
          operation.status = parseStatus({
            ...object(row.status),
            status: object(row.status).providerStatus,
            quoteResponse: object(object(row.status).quoteResponse).raw,
            swapDetails: {
              destinationChainTxHashes: object(row.status).destinationHashes,
              originChainTxHashes: object(row.status).originHashes,
              refundTxHashes: object(row.status).refundHashes,
              amountOut: object(row.status).amountOut,
            },
          });
        // Persisted evidence is informational until fresh RPC reconciliation succeeds.
        delete operation.evidence;
        if (operation.phase === "funded") operation.phase = "settled_verifying";
        return operation;
      } catch {
        throw new Error(
          "Payment recovery record is invalid; do not send again. Use your saved transaction details.",
        );
      }
    },
  };
}

export type IntentsStorage = ReturnType<typeof createIntentsStorage>;
