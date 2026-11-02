import { object } from "./client";
import { integer } from "./quote";
import type {
  FundingEvidence,
  FundingOperation,
  FundingReadiness,
  FundingStatus,
} from "./types";

function succeeded(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    !Object.hasOwn(record, "Failure") &&
    (Object.hasOwn(record, "SuccessValue") ||
      Object.hasOwn(record, "SuccessReceiptId"))
  );
}

/** A raw balance delta is not attribution. Require executed native Transfer receipt actions. */
export function attributedNativeTransfer(
  trace: unknown,
  hash: string,
  recipient: string,
  minimum: string,
): { receiptId: string; amountYocto: string } | null {
  try {
    const row = object(trace);
    if (
      object(row.transaction).hash !== hash ||
      !succeeded(row.status) ||
      !Array.isArray(row.receipts) ||
      !Array.isArray(row.receipts_outcome)
    )
      return null;
    const outcomes = row.receipts_outcome.map(object);
    if (
      !outcomes.length ||
      outcomes.some((o) => !succeeded(object(o.outcome).status))
    )
      return null;
    let sum = 0n;
    const ids: string[] = [];
    for (const value of row.receipts) {
      const receipt = object(value);
      if (
        receipt.receiver_id !== recipient ||
        typeof receipt.receipt_id !== "string"
      )
        continue;
      const outcome = outcomes.find((o) => o.id === receipt.receipt_id);
      if (!outcome || object(outcome.outcome).executor_id !== recipient)
        continue;
      const action = object(object(receipt.receipt).Action);
      if (!Array.isArray(action.actions)) continue;
      for (const value of action.actions) {
        const transfer = object(value).Transfer;
        if (transfer) {
          sum += BigInt(integer(object(transfer).deposit));
          ids.push(receipt.receipt_id);
        }
      }
    }
    return sum >= BigInt(integer(minimum)) && ids.length
      ? { receiptId: ids.join(","), amountYocto: sum.toString() }
      : null;
  } catch {
    return null;
  }
}

export interface DestinationReader {
  /** Return full executed receipt actions, e.g. EXPERIMENTAL_tx_status/indexer trace; absence stays pending. */
  readTransaction(hash: string, recipient: string): Promise<unknown>;
  readReadiness(operation: FundingOperation): Promise<FundingReadiness>;
}

export function createDestinationReconciler(reader: DestinationReader) {
  return async (
    operation: FundingOperation,
    status: FundingStatus,
  ): Promise<FundingEvidence> => {
    if (status.status !== "SUCCESS") return { state: "pending" };
    if (
      status.quoteResponse.quoteRequest.recipient !==
      operation.context.accountId
    )
      throw new Error("Settlement recipient mismatch");
    const minimum = status.amountOut ?? operation.quote.quote.minAmountOut;
    if (BigInt(integer(minimum)) < BigInt(operation.quote.quote.minAmountOut))
      throw new Error("Settlement is below the approved minimum");
    for (const hash of status.destinationHashes) {
      const trace = await reader.readTransaction(
        hash,
        operation.context.accountId,
      );
      const transfer = attributedNativeTransfer(
        trace,
        hash,
        operation.context.accountId,
        minimum,
      );
      if (!transfer) continue;
      const readiness = await reader.readReadiness(operation);
      const implicit = /^[0-9a-f]{64}$/.test(operation.context.accountId);
      if (
        readiness.state !== "ready" ||
        (implicit && readiness.expectedKeyMatches !== true) ||
        !readiness.spendableBeforeGasYocto
      ) {
        return {
          state: "pending",
          message: "Payment found; checking account readiness",
        };
      }
      return {
        state: "verified_native",
        transactionHash: hash,
        ...transfer,
        spendableBeforeGasYocto: integer(readiness.spendableBeforeGasYocto),
      };
    }
    return {
      state: "pending",
      message: "Conversion complete; checking native NEAR delivery",
    };
  };
}
