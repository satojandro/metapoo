import { completeReceiptStatus } from "../approved-transactions";
import { atomic } from "./config";
import { integer, object } from "./read";
import type {
  RheaOperation,
  RheaReadClient,
  RheaReconciliation,
  RheaTransaction,
} from "./types";

export type RheaRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
function decode(value: string): unknown {
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
    ),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function matchesTransaction(
  outcome: Record<string, unknown>,
  expected: RheaTransaction,
  signerId: string,
): boolean {
  const transaction = object(outcome.transaction);
  if (
    transaction.signer_id !== signerId ||
    transaction.receiver_id !== expected.receiverId ||
    !Array.isArray(transaction.actions) ||
    transaction.actions.length !== expected.actions.length
  )
    return false;
  return transaction.actions.every((action, index) => {
    const wire = object(object(action).FunctionCall);
    const planned = expected.actions[index].params;
    if (
      wire.method_name !== planned.methodName ||
      wire.deposit !== planned.deposit ||
      String(wire.gas) !== planned.gas ||
      typeof wire.args !== "string"
    )
      return false;
    return canonical(decode(wire.args)) === canonical(planned.args);
  });
}

/** Trust attributable token-contract events in this transaction tree, never a balance delta alone. */
function transferAmount(
  outcomes: Record<string, unknown>[],
  token: string,
  exchange: string,
  accountId: string,
  net = false,
): bigint {
  let amount = 0n;
  for (const result of outcomes) {
    for (const receipt of result.receipts_outcome as unknown[]) {
      const outcome = object(object(receipt).outcome);
      if (outcome.executor_id !== token || !Array.isArray(outcome.logs))
        continue;
      for (const log of outcome.logs) {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
        const event = object(JSON.parse(log.slice(11)));
        if (
          event.standard !== "nep141" ||
          event.event !== "ft_transfer" ||
          !Array.isArray(event.data)
        )
          continue;
        for (const entry of event.data) {
          const transfer = object(entry);
          if (
            transfer.old_owner_id === exchange &&
            transfer.new_owner_id === accountId
          )
            amount += atomic(integer(transfer.amount));
          // A venue-scoped tax may debit the recipient in the same receipt tree.
          if (
            net &&
            transfer.old_owner_id === accountId &&
            transfer.new_owner_id !== accountId
          )
            amount -= atomic(integer(transfer.amount));
        }
      }
    }
  }
  return amount;
}

export async function reconcileRheaCheckpoint(
  operation: RheaOperation,
  deps: { rpc: RheaRpc; client: RheaReadClient },
): Promise<RheaReconciliation> {
  const unknown = (message: string): RheaReconciliation => ({
    state: "unknown",
    attributableOutputAtomic: "0",
    nativeOutlayYocto: "0",
    message,
  });
  const checkpoint = operation.plan.checkpoints[operation.checkpoint];
  if (!checkpoint || operation.hashes.length < checkpoint.transactions.length)
    return unknown(
      "Transaction references are incomplete. Keep the original attempt for recovery.",
    );
  const hashes = operation.hashes.slice(-checkpoint.transactions.length);
  try {
    const outcomes = await Promise.all(
      hashes.map((transactionHash) =>
        deps
          .rpc("tx", {
            tx_hash: transactionHash,
            sender_account_id: operation.context.accountId,
            wait_until: "FINAL",
          })
          .then(object),
      ),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (
        !matchesTransaction(
          outcome,
          checkpoint.transactions[index],
          operation.context.accountId,
        )
      )
        return unknown(
          "A transaction reference does not match the approved swap checkpoint.",
        );
      if (completeReceiptStatus(outcome) === "unknown")
        return unknown("Waiting for all transaction and receipt outcomes.");
    }
    let nativeOutlay = checkpoint.transactions
      .flatMap((x) => x.actions)
      .reduce((sum, action) => sum + atomic(action.params.deposit), 0n);
    for (const outcome of outcomes) {
      const txOutcome = object(object(outcome.transaction_outcome).outcome);
      nativeOutlay += atomic(integer(txOutcome.tokens_burnt));
      for (const receipt of outcome.receipts_outcome as unknown[])
        nativeOutlay += atomic(
          integer(object(object(receipt).outcome).tokens_burnt),
        );
    }
    if (outcomes.some((outcome) => completeReceiptStatus(outcome) === "failed"))
      return {
        state: "failed",
        attributableOutputAtomic: "0",
        nativeOutlayYocto: nativeOutlay.toString(),
        message:
          "A transaction receipt failed. Earlier wrapping or registrations may remain; no trade was repeated.",
      };
    if (checkpoint.kind === "registration") {
      for (const tx of checkpoint.transactions) {
        const balance = (
          await deps.client.view(tx.receiverId, "storage_balance_of", {
            account_id: operation.context.accountId,
          })
        ).value;
        if (!balance || atomic(integer(object(balance).total)) === 0n)
          return unknown(
            "Registration receipts completed but token registration is not verified.",
          );
      }
      return {
        state: "received",
        attributableOutputAtomic: "0",
        nativeOutlayYocto: nativeOutlay.toString(),
        message: "Token registrations confirmed.",
      };
    }
    const quote = checkpoint.quote!;
    const first = quote.legs[0],
      last = quote.legs[quote.legs.length - 1];
    // NEP-141 ft_transfer_call resolves to the amount actually used by the receiver.
    const used = outcomes
      .map((outcome) => {
        const encoded = object(outcome.status).SuccessValue;
        if (typeof encoded !== "string")
          throw new Error("Missing transfer resolver result");
        return atomic(integer(decode(encoded)));
      })
      .reduce((sum, value) => sum + value, 0n);
    const delivered = transferAmount(
      outcomes,
      last.tokenOut,
      last.exchange,
      operation.context.accountId,
      true,
    );
    if (used === 0n) {
      const inputBack = transferAmount(
        outcomes,
        first.tokenIn,
        first.exchange,
        operation.context.accountId,
      );
      if (inputBack < atomic(quote.inputAtomic))
        return unknown(
          "The swap reported unused input; its returned token amount is not yet verified.",
        );
      return {
        state: "refunded",
        attributableOutputAtomic: "0",
        nativeOutlayYocto: nativeOutlay.toString(),
        message: `Swap input returned as ${first.tokenIn}. Wrapping and paid gas are not reversed; review an unwrap separately.`,
      };
    }
    if (used !== atomic(quote.inputAtomic))
      return {
        state: "failed",
        attributableOutputAtomic: delivered.toString(),
        nativeOutlayYocto: nativeOutlay.toString(),
        message:
          "The venue used only part of the input. Reconcile intermediate assets before another quote.",
      };
    if (delivered <= 0n)
      return unknown(
        "No attributable net output-token transfer event was verified; a wallet balance alone is insufficient.",
      );
    const balance = atomic(
      integer(
        (
          await deps.client.view(last.tokenOut, "ft_balance_of", {
            account_id: operation.context.accountId,
          })
        ).value,
      ),
    );
    if (balance < delivered)
      return unknown(
        "Received-token events and the fresh wallet balance need reconciliation.",
      );
    return {
      state: "received",
      attributableOutputAtomic: delivered.toString(),
      nativeOutlayYocto: nativeOutlay.toString(),
      message:
        "All receipts, transfer resolver and wallet output were verified.",
    };
  } catch {
    return unknown(
      "Could not verify the original transaction and received tokens. No replacement was submitted.",
    );
  }
}
