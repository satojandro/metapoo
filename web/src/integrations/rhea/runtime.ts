import { resolveAccountReadiness } from "../account-readiness";
import { estimateGasCeiling } from "../gas-budget";
import type { DurableStorage } from "../operation-store";
import {
  sameIdentity,
  type ApprovedTransactionRequest,
  type ApprovedTransactionResult,
  type OperationContext,
} from "../types";
import { atomic, validateRheaConfig } from "./config";
import {
  continueMpooBuy,
  createRheaOperationStore,
  executeMpooBuy,
  resumeMpooBuy,
} from "./controller";
import type { RheaPanelDependencies } from "./panel";
import { planMpooBuy } from "./plan";
import { groupCheckpoints, quoteMpooBuy } from "./quote";
import {
  createRheaReadClient,
  integer,
  object,
  readRequiredStorage,
  readRouteEvidence,
} from "./read";
import { reconcileRheaCheckpoint, type RheaRpc } from "./receipt";
import type {
  RheaBudget,
  RheaConfig,
  RheaControllerDependencies,
  RheaExecutionPlan,
  RheaOperation,
} from "./types";

export interface RheaRuntimeDependencies {
  config: RheaConfig;
  rpcUrl: string;
  context(): OperationContext | null;
  subscribeContext?(listener: () => void): () => void;
  storage: DurableStorage;
  approve(
    request: ApprovedTransactionRequest,
  ): Promise<ApprovedTransactionResult>;
  onBalancesChanged(context: OperationContext): void;
  /** Clear an uncertain shared spending marker only after authoritative trace reconciliation. */
  onReconciled?(context: OperationContext): void | Promise<void>;
  expectedPublicKey?(): Promise<string | undefined>;
  batchRegistrations?: boolean;
  /** Release route evidence must justify these ceilings. No measured gas cost is invented. */
  gas?: { registrationGas: string; wrapGas: string; swapGas: string };
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createRheaRuntime(
  deps: RheaRuntimeDependencies,
): RheaPanelDependencies {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const client = createRheaReadClient(deps.rpcUrl, fetcher);
  const store = createRheaOperationStore(deps.storage);
  const lastKey = "metapoo:rhea:last-operation";
  const rpc: RheaRpc = async (method, params) => {
    const response = await fetcher(deps.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rhea-runtime",
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error("Chain reads unavailable");
    const envelope = object(await response.json());
    if (envelope.error) throw new Error("Chain read failed");
    if (!("result" in envelope)) throw new Error("Missing RPC result");
    return envelope.result;
  };
  const requireContext = (): OperationContext => {
    const context = deps.context();
    if (!context) throw new Error("Connect a wallet before buying mPOO");
    if (context.networkId !== deps.config.networkId)
      throw new Error("Wallet and route network do not match");
    return context;
  };
  async function nativeBudget(context: OperationContext) {
    const publicKey = await deps.expectedPublicKey?.();
    const readiness = await resolveAccountReadiness(
      context.accountId,
      context.networkId,
      rpc,
      publicKey,
    );
    if (readiness.state !== "ready")
      throw new Error(
        "The account needs native NEAR before registration or swapping",
      );
    const price = object(await rpc("gas_price", { block_id: null }));
    return {
      spendableNativeYocto: readiness.spendableBeforeGasYocto,
      gasPriceYocto: integer(price.gas_price),
    };
  }
  async function prepare(
    context: OperationContext,
    inputNearYocto: string,
    slippageBps: number,
    signal: AbortSignal,
    previous?: RheaOperation,
  ): Promise<RheaExecutionPlan> {
    validateRheaConfig(deps.config);
    if (!deps.gas)
      throw new Error("Verified RHEA gas ceilings are not configured");
    const route = deps.config.route!;
    const [storage, native] = await Promise.all([
      readRequiredStorage(route, context.accountId, client, signal),
      nativeBudget(context),
    ]);
    const groups = groupCheckpoints(route);
    const gasUnits =
      BigInt(deps.gas.registrationGas) *
        BigInt(storage.filter((x) => !x.registered).length) +
      BigInt(deps.gas.wrapGas) +
      BigInt(deps.gas.swapGas) * BigInt(groups.length);
    const budget: RheaBudget = {
      ...deps.gas,
      spendableNativeYocto: native.spendableNativeYocto,
      maximumGasYocto: estimateGasCeiling(
        gasUnits.toString(),
        native.gasPriceYocto,
      ),
      reserveYocto: deps.config.gasReserveYocto,
      batchRegistrations: deps.batchRegistrations,
    };
    const next = previous?.plan.checkpoints[previous.checkpoint];
    const settledInputs =
      next?.kind === "swap" &&
      previous?.lastOutputAtomic !== null &&
      previous?.lastOutputAtomic !== undefined
        ? { [next.index]: previous.lastOutputAtomic }
        : undefined;
    const quote = await quoteMpooBuy(
      { context, inputNearYocto, slippageBps, settledInputs },
      { config: deps.config, client, now },
      signal,
    );
    if (!sameIdentity(context, deps.context()))
      throw new Error("Wallet changed while quoting");
    // Already completed wrap/input is not a second native outlay on a continuation.
    const planBudget = previous
      ? {
          ...budget,
          spendableNativeYocto: (
            atomic(budget.spendableNativeYocto) + atomic(inputNearYocto)
          ).toString(),
        }
      : budget;
    return planMpooBuy(quote, planBudget, storage);
  }
  const controller: RheaControllerDependencies = {
    now,
    isCurrent: (context) => sameIdentity(context, deps.context()),
    save(op) {
      store.save(op);
      deps.storage.setItem(lastKey, op.operationId);
    },
    load: store.load,
    approve: deps.approve,
    onBalancesChanged: deps.onBalancesChanged,
    async preflight(plan, checkpoint) {
      validateRheaConfig(deps.config);
      const native = await nativeBudget(plan.quote.context);
      const evidence = await readRouteEvidence(plan.quote.route, client, now);
      if (
        evidence.buyBps !== plan.quote.evidence.buyBps ||
        !sameIdentity(plan.quote.context, deps.context())
      )
        throw new Error("Tax or wallet changed; review again");
      // Revalidate the executable minimum on the actual checkpoint immediately before approval.
      if (checkpoint.quote) {
        const first = checkpoint.quote.legs[0],
          last = checkpoint.quote.legs[checkpoint.quote.legs.length - 1];
        const result =
          first.venue === "dcl"
            ? object(
                (
                  await client.view(first.exchange, "quote", {
                    pool_ids: checkpoint.quote.legs.map((x) => x.poolId),
                    input_token: first.tokenIn,
                    output_token: last.tokenOut,
                    input_amount: checkpoint.quote.inputAtomic,
                  })
                ).value,
              ).amount
            : (
                await client.view(first.exchange, "get_return", {
                  pool_id: Number(first.poolId),
                  token_in: first.tokenIn,
                  token_out: first.tokenOut,
                  amount_in: checkpoint.quote.inputAtomic,
                })
              ).value;
        if (
          atomic(integer(result)) < atomic(checkpoint.quote.minimumGrossAtomic)
        )
          throw new Error(
            "The checkpoint no longer meets the approved minimum",
          );
      }
      const deposits = checkpoint.transactions
        .flatMap((x) => x.actions)
        .reduce((sum, action) => sum + atomic(action.params.deposit), 0n);
      const gasUnits = checkpoint.transactions
        .flatMap((x) => x.actions)
        .reduce((sum, action) => sum + atomic(action.params.gas), 0n);
      const gas = atomic(
        estimateGasCeiling(gasUnits.toString(), native.gasPriceYocto),
      );
      if (
        atomic(native.spendableNativeYocto) <
        deposits + gas + atomic(plan.reserveYocto)
      )
        throw new Error(
          "Native NEAR gas and play reserve are no longer sufficient",
        );
    },
    async reconcile(op) {
      // Redirect wallets may have returned hashes only to the shared durable gateway marker.
      const raw = deps.storage.getItem(
        `metapoo:capital:pending:${op.context.networkId}:${op.context.accountId}`,
      );
      if (raw) {
        try {
          const pending = object(JSON.parse(raw));
          if (object(pending.context).operationId === op.operationId) {
            const hashes =
              typeof pending.transactionHash === "string"
                ? [pending.transactionHash]
                : Array.isArray(pending.transactionHashes)
                  ? pending.transactionHashes.filter(
                      (x): x is string => typeof x === "string",
                    )
                  : [];
            for (const hash of hashes)
              if (!op.hashes.includes(hash)) op.hashes.push(hash);
          }
        } catch {
          /* Corrupt markers cannot establish success. */
        }
      }
      const result = await reconcileRheaCheckpoint(op, { rpc, client });
      if (result.state !== "unknown") await deps.onReconciled?.(op.context);
      return result;
    },
  };
  let availabilityReason: string | undefined;
  try {
    validateRheaConfig(deps.config);
    if (!deps.gas)
      throw new Error("Verified RHEA gas ceilings are not configured");
  } catch (error) {
    availabilityReason =
      error instanceof Error
        ? error.message
        : "Embedded mPOO swaps are unavailable";
  }
  return {
    getContext: deps.context,
    subscribeContext: deps.subscribeContext,
    availabilityReason,
    lastOperationId: () => deps.storage.getItem(lastKey),
    prepareQuote: (inputYocto, slippageBps, signal) =>
      prepare(requireContext(), inputYocto, slippageBps, signal),
    async approve(plan) {
      const existing = store.load(plan.quote.context.operationId);
      return existing
        ? continueMpooBuy(existing.operationId, plan, controller)
        : executeMpooBuy(plan, controller);
    },
    resume: (id) => resumeMpooBuy(id, controller),
    prepareContinuation: (operation, signal) => {
      const current = requireContext();
      if (
        current.accountId !== operation.context.accountId ||
        current.networkId !== operation.context.networkId
      )
        throw new Error(
          "Switch back to the swap's original account to continue",
        );
      return prepare(
        { ...current, operationId: operation.operationId },
        operation.plan.quote.inputNearYocto,
        operation.plan.quote.slippageBps,
        signal,
        operation,
      );
    },
  };
}
