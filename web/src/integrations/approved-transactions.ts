import { SEND_NATIVE_GAS, SEND_GAS_FLOOR_YOCTO } from "./send/plan";
import { parseTxOutcome } from "../tx-outcome";
import {
  assertAtomic,
  sameIdentity,
  type ApprovedNearTransaction,
  type ApprovedTransactionRequest,
  type ApprovedTransactionResult,
  type OperationContext,
} from "./types";
import { withCapitalLock, type DurableStorage } from "./operation-store";
import { estimateGasCeiling } from "./gas-budget";

export interface AcquisitionPolicy {
  wrapAccount: string;
  tokenAccounts: readonly string[];
  exchangeAccounts: readonly string[];
  poolIds: readonly string[];
  storageMaximums: Readonly<Record<string, string>>;
}
/** Only the application boundary may certify that the signing provider was never invoked. */
export class ApprovalNotSubmittedError extends Error {}
export interface GatewayDependencies {
  isUnsubmittedRejection?(error: unknown): boolean;
  context(): OperationContext | null;
  storage: DurableStorage;
  now(): number;
  validateTransaction(
    tx: ApprovedNearTransaction,
    request: ApprovedTransactionRequest,
  ): void;
  readBudget(context: OperationContext): Promise<{
    spendableBeforeGasYocto: string;
    gasPriceYocto: string;
    playReserveYocto: string;
  }>;
  send(
    tx: ApprovedNearTransaction,
    context: OperationContext,
  ): Promise<unknown>;
  sendBatch?(
    txs: readonly ApprovedNearTransaction[],
    context: OperationContext,
  ): Promise<unknown[]>;
}
/** Independently constrain generated actions: provider/quote JSON is never a spending authority. */
export function validateAcquisitionTransaction(
  tx: ApprovedNearTransaction,
  request: ApprovedTransactionRequest,
  policy: AcquisitionPolicy,
): void {
  if (request.purpose === "send") throw new Error("Send is outside acquisition permissions");
  if (!tx.actions.length || tx.actions.length > 2)
    throw new Error("Unsupported acquisition action count");
  if (
    request.purpose === "funding-unwrap" &&
    (tx.receiverId !== policy.wrapAccount || tx.actions.length !== 1)
  )
    throw new Error("Unwrap must target wrapped NEAR");
  for (const action of tx.actions) {
    if (action.type !== "FunctionCall")
      throw new Error("Only reviewed function calls are permitted");
    const p = action.params;
    if (assertAtomic(p.gas) <= 0n || BigInt(p.gas) > 300_000_000_000_000n)
      throw new Error("Invalid gas budget");
    const deposit = assertAtomic(p.deposit);
    if (
      request.purpose === "funding-unwrap" &&
      p.methodName !== "near_withdraw"
    )
      throw new Error("Unwrap method mismatch");
    switch (p.methodName) {
      case "near_deposit":
        if (
          request.purpose !== "mpoo-acquisition" ||
          tx.receiverId !== policy.wrapAccount ||
          deposit <= 0n ||
          Object.keys(p.args).length
        )
          throw new Error("Invalid wrap");
        break;
      case "near_withdraw":
        if (
          tx.receiverId !== policy.wrapAccount ||
          deposit !== 1n ||
          assertAtomic(String(p.args.amount)) <= 0n ||
          Object.keys(p.args).some((k) => k !== "amount")
        )
          throw new Error("Invalid unwrap");
        break;
      case "storage_deposit": {
        const max = policy.storageMaximums[tx.receiverId];
        if (
          request.purpose !== "mpoo-acquisition" ||
          !policy.tokenAccounts.includes(tx.receiverId) ||
          !max ||
          deposit > assertAtomic(max) ||
          deposit <= 0n ||
          p.args.account_id !== request.context.accountId ||
          p.args.registration_only !== true ||
          Object.keys(p.args).some(
            (k) => !["account_id", "registration_only"].includes(k),
          )
        )
          throw new Error("Unreviewed storage registration");
        break;
      }
      case "ft_transfer_call": {
        if (
          request.purpose !== "mpoo-acquisition" ||
          !policy.tokenAccounts.includes(tx.receiverId) ||
          deposit !== 1n ||
          !policy.exchangeAccounts.includes(String(p.args.receiver_id)) ||
          assertAtomic(String(p.args.amount)) <= 0n ||
          typeof p.args.msg !== "string"
        )
          throw new Error("Unreviewed swap transfer");
        const msg = JSON.parse(p.args.msg) as {
          Swap?: {
            pool_ids?: unknown;
            output_token?: unknown;
            min_output_amount?: unknown;
          };
          force?: unknown;
          actions?: unknown[];
        };
        const swap = msg.Swap;
        if (swap) {
          if (
            Object.keys(msg).length !== 1 ||
            !Array.isArray(swap.pool_ids) ||
            !swap.pool_ids.length ||
            swap.pool_ids.length > 4 ||
            !swap.pool_ids.every(
              (id) => typeof id === "string" && policy.poolIds.includes(id),
            ) ||
            !policy.tokenAccounts.includes(String(swap.output_token)) ||
            assertAtomic(String(swap.min_output_amount)) <= 0n
          )
            throw new Error("Unreviewed swap route/minimum");
        } else {
          // Classic routes are one reviewed pool per checkpoint, never generic router instructions.
          if (
            Object.keys(msg).some((k) => !["force", "actions"].includes(k)) ||
            msg.force !== 0 ||
            !Array.isArray(msg.actions) ||
            msg.actions.length !== 1
          )
            throw new Error("Unreviewed classic swap");
          const leg = msg.actions[0] as Record<string, unknown>;
          if (
            !Number.isSafeInteger(leg.pool_id) ||
            (leg.pool_id as number) < 0 ||
            !policy.poolIds.includes(String(leg.pool_id)) ||
            leg.token_in !== tx.receiverId ||
            !policy.tokenAccounts.includes(String(leg.token_out)) ||
            leg.amount_in !== p.args.amount ||
            assertAtomic(String(leg.min_amount_out)) <= 0n ||
            Object.keys(leg).some(
              (k) =>
                ![
                  "pool_id",
                  "token_in",
                  "token_out",
                  "amount_in",
                  "min_amount_out",
                ].includes(k),
            )
          )
            throw new Error("Unreviewed classic swap minimum");
        }
        break;
      }
      default:
        throw new Error("Method outside acquisition permissions");
    }
  }
  if (
    tx.actions.length === 2 &&
    (tx.receiverId !== policy.wrapAccount ||
      tx.actions[0].params.methodName !== "near_deposit" ||
      tx.actions[1].params.methodName !== "ft_transfer_call")
  )
    throw new Error("Only wrap-and-swap batching is allowed");
}
export function completeReceiptStatus(
  outcome: unknown,
): "confirmed" | "failed" | "unknown" {
  const parsed = parseTxOutcome(outcome);
  if (parsed.status === "failed") return "failed";
  const r = outcome as {
    status?: Record<string, unknown>;
    receipts_outcome?: { outcome?: { status?: Record<string, unknown> } }[];
  };
  if (!r || !Array.isArray(r.receipts_outcome) || !r.receipts_outcome.length)
    return "unknown";
  if (
    r.receipts_outcome.some(
      (receipt) =>
        receipt.outcome?.status && "Failure" in receipt.outcome.status,
    )
  )
    return "failed";
  if (
    !parsed.transactionHash ||
    !r.status ||
    !("SuccessValue" in r.status) ||
    r.receipts_outcome.some(
      (receipt) =>
        !receipt.outcome?.status ||
        !(
          "SuccessValue" in receipt.outcome.status ||
          "SuccessReceiptId" in receipt.outcome.status
        ),
    )
  )
    return "unknown";
  return "confirmed";
}
const pendingKey = (c: OperationContext) =>
  `metapoo:capital:pending:${c.networkId}:${c.accountId}`;
const spendKey = (c: OperationContext) =>
  `metapoo:capital:spent:${c.networkId}:${c.accountId}:${c.operationId}`;
const limitKey = (c: OperationContext) =>
  `metapoo:capital:limit:${c.networkId}:${c.accountId}:${c.operationId}`;
/** No caller-provided signing function or drawing secret crosses this boundary. */
export function createApprovedTransactionGateway(deps: GatewayDependencies) {
  return async (
    original: ApprovedTransactionRequest,
  ): Promise<ApprovedTransactionResult> => {
    // Snapshot before awaits so the panel cannot replace the approved transaction while RPC is pending.
    const request = JSON.parse(
      JSON.stringify(original),
    ) as ApprovedTransactionRequest;
    const assertCurrent = () => {
      if (!sameIdentity(request.context, deps.context()))
        throw new Error("Wallet identity changed; review again");
      if (
        request.approval.expiresAtMs !== undefined &&
        deps.now() >= request.approval.expiresAtMs
      )
        throw new Error("Quote expired; review again");
    };
    assertCurrent();
    if (
      !request.transactions.length ||
      request.transactions.length > 12 ||
      !request.approval.summary.trim()
    )
      throw new Error("Missing transaction approval");
    if (request.purpose === "send" && request.transactions.length !== 1) throw new Error("Send must be exactly one transaction");
    request.transactions.forEach((tx) => deps.validateTransaction(tx, request));
    const limit = assertAtomic(request.approval.maxNativeSpendYocto);
    return withCapitalLock(deps.storage, async () => {
      assertCurrent();
      if (deps.storage.getItem(pendingKey(request.context)))
        throw new Error(
          "A previous transaction needs reconciliation before spending again",
        );
      const used = assertAtomic(
        deps.storage.getItem(spendKey(request.context)) ?? "0",
      );
      let consumed = used;
      const originalLimit = deps.storage.getItem(limitKey(request.context));
      if (originalLimit !== null && limit > assertAtomic(originalLimit))
        throw new Error(
          "Operation ceiling cannot increase on a later checkpoint",
        );
      const recordLimit = () => {
        if (originalLimit === null)
          deps.storage.setItem(limitKey(request.context), limit.toString());
      };
      const notSubmitted = (error: unknown) =>
        error instanceof ApprovalNotSubmittedError ||
        deps.isUnsubmittedRejection?.(error) === true;
      const result: ApprovedTransactionResult = {
        steps: [],
        completedSteps: 0,
      };
      if (
        request.transactions.length > 1 &&
        request.transactions.some(
          (tx) =>
            tx.actions.length !== 1 ||
            tx.actions[0].params.methodName !== "storage_deposit",
        )
      ) {
        throw new Error(
          "Only independent registrations may share a checkpoint",
        );
      }
      if (request.transactions.length > 1 && deps.sendBatch) {
        if (
          request.transactions.some(
            (tx) =>
              tx.actions.length !== 1 ||
              tx.actions[0].params.methodName !== "storage_deposit",
          )
        ) {
          throw new Error(
            "Only independent registrations may share a batch approval",
          );
        }
        const budget = await deps.readBudget(request.context);
        assertCurrent();
        const ceiling = request.transactions.reduce(
          (sum, tx) =>
            sum +
            tx.actions.reduce(
              (n, a) =>
                n +
                assertAtomic(a.params.deposit) +
                BigInt(estimateGasCeiling(a.type === "Transfer" ? SEND_NATIVE_GAS : a.params.gas, budget.gasPriceYocto)),
              0n,
            ),
          0n,
        );
        if (
          consumed + ceiling > limit ||
          assertAtomic(budget.spendableBeforeGasYocto) <
            ceiling + assertAtomic(request.purpose === "send" ? SEND_GAS_FLOOR_YOCTO : budget.playReserveYocto)
        )
          throw new Error(
            "Insufficient gas reserve or approved spending ceiling",
          );
        recordLimit();
        deps.storage.setItem(
          pendingKey(request.context),
          JSON.stringify({
            version: 1,
            context: request.context,
            transactions: request.transactions,
            ceiling: ceiling.toString(),
            transactionHashes: [],
            status: "unknown",
          }),
        );
        try {
          const outcomes = await deps.sendBatch(
            request.transactions,
            request.context,
          );
          const steps = request.transactions.map((_, index) => ({
            index,
            status: completeReceiptStatus(outcomes[index]),
            transactionHash: parseTxOutcome(outcomes[index]).transactionHash,
          }));
          deps.storage.setItem(
            pendingKey(request.context),
            JSON.stringify({
              version: 1,
              context: request.context,
              transactions: request.transactions,
              ceiling: ceiling.toString(),
              transactionHashes: steps.map((s) => s.transactionHash),
              status: steps.some((s) => s.status === "unknown")
                ? "unknown"
                : "resolved",
            }),
          );
          if (
            !sameIdentity(request.context, deps.context()) ||
            steps.some((s) => s.status === "unknown")
          )
            return {
              steps,
              completedSteps: steps.filter((s) => s.status === "confirmed")
                .length,
            };
          deps.storage.setItem(
            spendKey(request.context),
            (consumed + ceiling).toString(),
          );
          deps.storage.removeItem(pendingKey(request.context));
          return {
            steps,
            completedSteps: steps.filter((s) => s.status === "confirmed")
              .length,
          };
        } catch (error) {
          if (notSubmitted(error)) {
            deps.storage.removeItem(pendingKey(request.context));
            return {
              steps: request.transactions.map((_, index) => ({
                index,
                status: "not_submitted" as const,
                transactionHash: null,
                detail:
                  "Approval cancelled before signing; no transaction submitted.",
              })),
              completedSteps: 0,
            };
          }
          return {
            steps: [
              {
                index: 0,
                status: "unknown",
                transactionHash: null,
                detail:
                  error instanceof Error
                    ? error.message
                    : "Batch approval unresolved",
              },
            ],
            completedSteps: 0,
          };
        }
      }
      for (const [index, tx] of request.transactions.entries()) {
        const budget = await deps.readBudget(request.context);
        assertCurrent();
        const gasUnits = tx.actions.reduce(
          (n, a) => n + assertAtomic(a.type === "Transfer" ? SEND_NATIVE_GAS : a.params.gas),
          0n,
        );
        if (gasUnits > 300_000_000_000_000n)
          throw new Error("Transaction gas exceeds protocol limit");
        const deposits = tx.actions.reduce(
          (n, a) => n + assertAtomic(a.params.deposit),
          0n,
        );
        const ceiling =
          deposits +
          BigInt(estimateGasCeiling(gasUnits.toString(), budget.gasPriceYocto));
        if (
          consumed + ceiling > limit ||
          assertAtomic(budget.spendableBeforeGasYocto) <
            ceiling + assertAtomic(request.purpose === "send" ? SEND_GAS_FLOOR_YOCTO : budget.playReserveYocto)
        )
          throw new Error(
            "Insufficient gas reserve or approved spending ceiling",
          );
        // Persist BEFORE the provider call, including calls that can redirect/reload this document.
        recordLimit();
        deps.storage.setItem(
          pendingKey(request.context),
          JSON.stringify({
            version: 1,
            context: request.context,
            index,
            transaction: tx,
            ceiling: ceiling.toString(),
            transactionHash: null,
            status: "unknown",
          }),
        );
        try {
          const outcome = await deps.send(tx, request.context);
          const parsed = parseTxOutcome(outcome),
            status = completeReceiptStatus(outcome);
          const pending = JSON.parse(
            deps.storage.getItem(pendingKey(request.context))!,
          );
          pending.transactionHash = parsed.transactionHash;
          pending.status = status;
          deps.storage.setItem(
            pendingKey(request.context),
            JSON.stringify(pending),
          );
          result.steps.push({
            index,
            status,
            transactionHash: parsed.transactionHash,
          });
          // Never move a changed account's result into its current UI or continue its next transaction.
          assertCurrent();
          if (status === "unknown") break;
          consumed += ceiling; // Conservative accounting also bounds paid gas on failures.
          deps.storage.setItem(spendKey(request.context), consumed.toString());
          deps.storage.removeItem(pendingKey(request.context));
          if (status === "failed") break;
          result.completedSteps++;
        } catch (error) {
          if (
            notSubmitted(error) &&
            !result.steps.some((step) => step.index === index)
          ) {
            deps.storage.removeItem(pendingKey(request.context));
            result.steps.push({
              index,
              status: "not_submitted",
              transactionHash: null,
              detail:
                "Approval cancelled before signing; no transaction submitted.",
            });
            break;
          }
          if (!result.steps.some((step) => step.index === index))
            result.steps.push({
              index,
              status: "unknown",
              transactionHash: null,
              detail:
                error instanceof Error
                  ? error.message
                  : "Wallet result unresolved",
            });
          break; // No resend, next stage, or fallback wallet after a possible broadcast.
        }
      }
      return result;
    });
  };
}

/** Resolve only hashes returned by the original provider; never clear a lock from a balance delta. */
export async function reconcilePendingCapitalAttempt(
  context: OperationContext,
  storage: DurableStorage,
  lookup: (hash: string, accountId: string) => Promise<unknown>,
): Promise<boolean> {
  return withCapitalLock(storage, async () => {
    const key = pendingKey(context),
      raw = storage.getItem(key);
    if (!raw) return true;
    if (raw.length > 131072)
      throw new Error("Invalid pending transaction record");
    const pending = JSON.parse(raw) as {
      version: number;
      context: OperationContext;
      transaction?: ApprovedNearTransaction;
      transactions?: ApprovedNearTransaction[];
      transactionHash?: string | null;
      transactionHashes?: (string | null)[];
      ceiling: string;
    };
    if (
      pending.version !== 1 ||
      pending.context.accountId !== context.accountId ||
      pending.context.networkId !== context.networkId
    )
      throw new Error("Pending transaction identity mismatch");
    const transactions =
      pending.transactions ??
      (pending.transaction ? [pending.transaction] : []);
    const hashes = pending.transactionHashes ?? [
      pending.transactionHash ?? null,
    ];
    if (
      !transactions.length ||
      hashes.length !== transactions.length ||
      hashes.some((hash) => typeof hash !== "string" || !hash)
    )
      return false;
    const canonical = (value: unknown): string => JSON.stringify(sort(value));
    function sort(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(sort);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, sort(v)]),
        );
      return value;
    }
    for (const [index, hash] of hashes.entries()) {
      const trace = (await lookup(hash!, context.accountId)) as {
        transaction?: {
          hash?: string;
          signer_id?: string;
          receiver_id?: string;
          actions?: unknown[];
        };
      };
      const tx = trace.transaction,
        planned = transactions[index];
      if (
        !tx ||
        tx.hash !== hash ||
        tx.signer_id !== context.accountId ||
        tx.receiver_id !== planned.receiverId ||
        !Array.isArray(tx.actions) ||
        tx.actions.length !== planned.actions.length
      )
        return false;
      for (const [i, action] of tx.actions.entries()) {
        const call = (
          action as {
            FunctionCall?: {
              method_name: string;
              args: string;
              gas: string;
              deposit: string;
            };
          }
        ).FunctionCall;
        const plannedAction = planned.actions[i];
        if (plannedAction.type === "Transfer") {
          const transfer = (action as {Transfer?: {deposit?: string}}).Transfer;
          if (!transfer || transfer.deposit !== plannedAction.params.deposit || Object.keys(action as object).length !== 1) return false;
          continue;
        }
        const approved = plannedAction.params;
        if (
          !call ||
          call.method_name !== approved.methodName ||
          String(call.gas) !== approved.gas ||
          call.deposit !== approved.deposit
        )
          return false;
        let args: unknown;
        try {
          args = JSON.parse(
            new TextDecoder().decode(
              Uint8Array.from(atob(call.args), (c) => c.charCodeAt(0)),
            ),
          );
        } catch {
          return false;
        }
        if (canonical(args) !== canonical(approved.args)) return false;
      }
      if (completeReceiptStatus(trace) === "unknown") return false;
    }
    // Concurrent tab may have written a different attempt while RPC was outstanding.
    if (storage.getItem(key) !== raw) return false;
    const spent = assertAtomic(
      storage.getItem(spendKey(pending.context)) ?? "0",
    );
    storage.setItem(
      spendKey(pending.context),
      (spent + assertAtomic(pending.ceiling)).toString(),
    );
    storage.removeItem(key);
    return true;
  });
}
