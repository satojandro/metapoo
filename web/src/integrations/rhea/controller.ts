import {
  createAcquisitionStore,
  type DurableStorage,
} from "../operation-store";
import { atomic } from "./config";
import type {
  RheaControllerDependencies,
  RheaExecutionPlan,
  RheaOperation,
  RheaReconciliation,
} from "./types";

const DETAIL_PREFIX = "metapoo:rhea:detail:v1:";
const TERMINAL = new Set(["complete", "failed", "partial", "refunded"]);

function loaded(value: unknown, id: string): RheaOperation {
  const op = value as RheaOperation;
  const phases = [
    "review",
    "awaiting_approval",
    "submitted",
    "reconciling",
    "next_checkpoint_review",
    "complete",
    "partial",
    "refunded",
    "failed",
    "unresolved",
  ];
  if (
    !op ||
    op.version !== 1 ||
    op.operationId !== id ||
    op.context?.operationId !== id ||
    !phases.includes(op.phase) ||
    !op.plan?.quote ||
    !Array.isArray(op.plan.checkpoints) ||
    !Number.isSafeInteger(op.checkpoint) ||
    op.checkpoint < 0 ||
    op.checkpoint > op.plan.checkpoints.length ||
    !Array.isArray(op.hashes) ||
    op.hashes.some((x) => typeof x !== "string") ||
    !Number.isSafeInteger(op.completed) ||
    op.completed < 0 ||
    !Number.isFinite(op.updatedAtMs)
  )
    throw new Error(
      "Invalid swap recovery record; reconcile known transactions before retrying",
    );
  atomic(op.consumedNativeYocto);
  atomic(op.plan.maxNativeSpendYocto);
  if (op.lastOutputAtomic !== null) atomic(op.lastOutputAtomic);
  return op;
}

/** Feature details and the shared envelope contain public transaction data only. */
export function createRheaOperationStore(storage: DurableStorage) {
  const envelope = createAcquisitionStore(storage);
  return {
    save(op: RheaOperation): void {
      loaded(op, op.operationId);
      const raw = JSON.stringify(op);
      if (raw.length > 65536)
        throw new Error("Swap recovery record is too large");
      storage.setItem(DETAIL_PREFIX + op.operationId, raw);
      envelope.save({
        version: 1,
        context: op.context,
        feature: "rhea",
        createdAtMs: op.plan.quote.createdAtMs,
        updatedAtMs: op.updatedAtMs,
        phase: op.phase,
        providerRecordId: DETAIL_PREFIX + op.operationId,
        transactionHashes: op.hashes,
      });
    },
    load(operationId: string): RheaOperation | null {
      const raw = storage.getItem(DETAIL_PREFIX + operationId);
      if (!raw) return null;
      if (raw.length > 65536)
        throw new Error("Swap recovery record is too large");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          "Swap recovery record is corrupt; do not retry payment",
        );
      }
      return loaded(parsed, operationId);
    },
  };
}

function persist(
  op: RheaOperation,
  deps: RheaControllerDependencies,
): RheaOperation {
  op.updatedAtMs = deps.now();
  deps.save(structuredClone(op));
  return op;
}
function guard(
  plan: RheaExecutionPlan,
  deps: RheaControllerDependencies,
): void {
  if (!deps.isCurrent(plan.quote.context))
    throw new Error("Wallet changed; review this swap again");
  if (deps.now() >= plan.quote.expiresAtMs)
    throw new Error("Swap quote expired; request a new quote");
  if (!plan.quote.route.netMinimumProof)
    throw new Error("Net output protection is not verified");
}
function applyReconciliation(
  op: RheaOperation,
  result: RheaReconciliation,
  deps: RheaControllerDependencies,
): RheaOperation {
  const checkpoint = op.plan.checkpoints[op.checkpoint];
  if (!checkpoint) return op;
  if (result.state === "unknown") {
    op.phase = "unresolved";
    op.message = result.message;
    return persist(op, deps);
  }
  const spent =
    atomic(op.consumedNativeYocto) + atomic(result.nativeOutlayYocto);
  if (spent > atomic(op.plan.maxNativeSpendYocto)) {
    op.phase = "partial";
    op.message =
      "Native spending exceeded the approved ceiling; no further transaction will be sent.";
    return persist(op, deps);
  }
  // Advancing the checkpoint is the durable marker that prevents double accounting.
  op.consumedNativeYocto = spent.toString();
  if (result.state !== "received") {
    op.phase =
      result.state === "refunded"
        ? "refunded"
        : op.completed
          ? "partial"
          : "failed";
    op.message = result.message;
    persist(op, deps);
    if (deps.isCurrent(op.context)) deps.onBalancesChanged(op.context);
    return op;
  }
  const output = atomic(result.attributableOutputAtomic);
  if (
    checkpoint.kind === "swap" &&
    output < atomic(checkpoint.quote!.minimumNetAtomic, true)
  ) {
    op.phase = "partial";
    op.message =
      "Received output did not meet the approved net minimum. Keep the transaction references; do not repeat the swap.";
    return persist(op, deps);
  }
  op.completed++;
  op.checkpoint++;
  if (checkpoint.kind === "swap") op.lastOutputAtomic = output.toString();
  op.phase =
    op.checkpoint === op.plan.checkpoints.length
      ? "complete"
      : "next_checkpoint_review";
  op.message =
    op.phase === "complete"
      ? `${op.plan.quote.route.fixture ? "Test token" : "mPOO"} received in your wallet. Paint credits are unchanged.`
      : "This checkpoint is complete. Review a fresh quote before continuing.";
  persist(op, deps);
  if (deps.isCurrent(op.context)) deps.onBalancesChanged(op.context);
  return op;
}

async function executeCheckpoint(
  op: RheaOperation,
  deps: RheaControllerDependencies,
): Promise<RheaOperation> {
  const checkpoint = op.plan.checkpoints[op.checkpoint];
  if (!checkpoint) throw new Error("No remaining swap checkpoint");
  guard(op.plan, deps);
  // Claim before the first asynchronous preflight so a second Continue cannot race it.
  const previousPhase = op.phase;
  op.phase = "awaiting_approval";
  persist(op, deps);
  try {
    await deps.preflight(op.plan, checkpoint);
    guard(op.plan, deps);
    const current = loaded(deps.load(op.operationId), op.operationId);
    if (
      current.phase !== "awaiting_approval" ||
      current.checkpoint !== op.checkpoint ||
      current.plan.quote.id !== op.plan.quote.id
    )
      throw new Error("Swap checkpoint changed during preflight");
  } catch (error) {
    op.phase = previousPhase;
    op.message =
      error instanceof Error
        ? error.message
        : "Swap preflight failed; no approval was requested.";
    persist(op, deps);
    throw error;
  }
  op.phase = "awaiting_approval";
  op.message =
    checkpoint.kind === "registration"
      ? "Approve token balance registration."
      : "Approve the reviewed mPOO acquisition checkpoint.";
  persist(op, deps);
  try {
    // Locking, provider approval and attempt persistence belong to the shared gateway.
    const result = await deps.approve({
      context: op.context,
      purpose: "mpoo-acquisition",
      transactions: checkpoint.transactions,
      approval: {
        summary: op.message,
        maxNativeSpendYocto: op.plan.maxNativeSpendYocto,
        quoteId: op.plan.quote.id,
        expiresAtMs: op.plan.quote.expiresAtMs,
      },
    });
    op.hashes.push(
      ...result.steps.flatMap((x) =>
        x.transactionHash ? [x.transactionHash] : [],
      ),
    );
    if (
      result.steps.length !== checkpoint.transactions.length ||
      result.steps.some((x) => x.status === "unknown")
    ) {
      op.phase = "unresolved";
      op.message =
        "A transaction may have been sent. Check its original result before doing anything else.";
      return persist(op, deps);
    }
    op.phase = "reconciling";
    persist(op, deps);
    return applyReconciliation(op, await deps.reconcile(op), deps);
  } catch {
    // Once a provider is invoked, an absent hash must not cause speculative retry.
    op.phase = "unresolved";
    op.message =
      "Approval or network result is uncertain. Reconcile the original attempt; no replacement was sent.";
    return persist(op, deps);
  }
}

export async function executeMpooBuy(
  plan: RheaExecutionPlan,
  deps: RheaControllerDependencies,
): Promise<RheaOperation> {
  guard(plan, deps);
  const id = plan.quote.context.operationId;
  if (deps.load(id))
    throw new Error(
      "This swap already has a recovery record; resume it instead of submitting again",
    );
  const op: RheaOperation = {
    version: 1,
    operationId: id,
    context: { ...plan.quote.context },
    phase: "review",
    plan: structuredClone(plan),
    checkpoint: 0,
    consumedNativeYocto: "0",
    hashes: [],
    completed: 0,
    lastOutputAtomic: null,
    message: "Swap reviewed.",
    updatedAtMs: deps.now(),
  };
  persist(op, deps);
  return executeCheckpoint(op, deps);
}

/** Continuing requires a freshly reviewed full plan, never mutation inside the gateway. */
export async function continueMpooBuy(
  operationId: string,
  freshPlan: RheaExecutionPlan,
  deps: RheaControllerDependencies,
): Promise<RheaOperation> {
  const op = structuredClone(loaded(deps.load(operationId), operationId));
  if (op.phase !== "next_checkpoint_review" && op.phase !== "review")
    throw new Error("Reconcile this swap before approving another checkpoint");
  guard(freshPlan, deps);
  if (
    freshPlan.quote.id === op.plan.quote.id ||
    freshPlan.quote.context.operationId !== operationId ||
    op.context.accountId !== freshPlan.quote.context.accountId ||
    op.context.networkId !== freshPlan.quote.context.networkId ||
    freshPlan.quote.route.id !== op.plan.quote.route.id ||
    freshPlan.quote.inputNearYocto !== op.plan.quote.inputNearYocto ||
    atomic(freshPlan.maxNativeSpendYocto) > atomic(op.plan.maxNativeSpendYocto)
  )
    throw new Error(
      "A continuation cannot reset the original identity or spending ceiling",
    );
  const expected = op.plan.checkpoints[op.checkpoint];
  const replacementIndex = freshPlan.checkpoints.findIndex(
    (x) => x.kind === expected.kind && x.index === expected.index,
  );
  const replacement = freshPlan.checkpoints[replacementIndex];
  if (
    !replacement ||
    replacement.kind !== expected.kind ||
    replacement.index !== expected.index ||
    JSON.stringify(replacement.quote?.legs) !==
      JSON.stringify(expected.quote?.legs)
  )
    throw new Error(
      "Checkpoint layout changed; a new reviewed recovery plan is required",
    );
  if (
    expected.kind === "swap" &&
    op.lastOutputAtomic !== null &&
    replacement.quote!.inputAtomic !== op.lastOutputAtomic
  )
    throw new Error(
      "The next swap must use the attributable output of the previous checkpoint",
    );
  if (
    atomic(freshPlan.quote.minNetMpooAtomic) <
    atomic(op.plan.quote.minNetMpooAtomic)
  )
    throw new Error("A continuation cannot lower the approved final minimum");
  const remainingDeposits = freshPlan.checkpoints
    .slice(replacementIndex)
    .flatMap((x) => x.transactions)
    .flatMap((x) => x.actions)
    .reduce((sum, x) => sum + atomic(x.params.deposit), 0n);
  if (
    atomic(op.consumedNativeYocto) + remainingDeposits >
    atomic(op.plan.maxNativeSpendYocto)
  )
    throw new Error(
      "The remaining checkpoint exceeds the original native budget",
    );
  const originalCeiling = op.plan.maxNativeSpendYocto;
  const completedCheckpoints = op.plan.checkpoints.slice(0, op.checkpoint);
  op.plan = structuredClone(freshPlan);
  op.plan.checkpoints = [
    ...completedCheckpoints,
    ...structuredClone(freshPlan.checkpoints.slice(replacementIndex)),
  ];
  op.plan.maxNativeSpendYocto = originalCeiling;
  op.context = { ...freshPlan.quote.context };
  persist(op, deps);
  return executeCheckpoint(op, deps);
}

/** Reloads only read chain state; this API never opens the wallet. */
export async function resumeMpooBuy(
  operationId: string,
  deps: RheaControllerDependencies,
): Promise<RheaOperation> {
  const op = structuredClone(loaded(deps.load(operationId), operationId));
  if (
    TERMINAL.has(op.phase) ||
    op.phase === "next_checkpoint_review" ||
    op.phase === "review"
  )
    return op;
  return applyReconciliation(op, await deps.reconcile(op), deps);
}
