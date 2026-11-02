// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  createRheaConfig,
  parseDisplayAmount,
  validateManifest,
  validateRheaConfig,
} from "./config";
import {
  createRheaReadClient,
  readRequiredStorage,
  readRouteEvidence,
} from "./read";
import { quoteMpooBuy } from "./quote";
import { planMpooBuy } from "./plan";
import {
  continueMpooBuy,
  createRheaOperationStore,
  executeMpooBuy,
  resumeMpooBuy,
} from "./controller";
import { mountRheaPanel } from "./panel";
import { reconcileRheaCheckpoint } from "./receipt";
import { createRheaRuntime } from "./runtime";
import type { ApprovedTransactionRequest, OperationContext } from "../types";
import type {
  RheaBudget,
  RheaConfig,
  RheaControllerDependencies,
  RheaExecutionPlan,
  RheaOperation,
  RheaReadClient,
  RheaRouteManifest,
} from "./types";

const context = {
  operationId: "fixture-operation",
  accountId: "alice.testnet",
  networkId: "testnet" as const,
  sessionEpoch: 1,
};
const amount = "1000000000000000000000000";
function route(group = true): RheaRouteManifest {
  return {
    version: 1,
    id: "fixture-route",
    evidenceId: "fixture-proof",
    fixture: true,
    networkId: "testnet",
    wrapToken: "wrap.testnet",
    mpooToken: "mpoo.fixture.testnet",
    decimals: {
      "wrap.testnet": 24,
      "intermediate.testnet": 18,
      "mpoo.fixture.testnet": 18,
    },
    codeHashes: {
      "wrap.testnet": "code",
      "intermediate.testnet": "code",
      "mpoo.fixture.testnet": "code",
      "dcl.testnet": "code",
    },
    legs: [
      {
        venue: "dcl",
        exchange: "dcl.testnet",
        poolId: "intermediate.testnet|wrap.testnet|2000",
        tokenIn: "wrap.testnet",
        tokenOut: "intermediate.testnet",
        feeBps: 20,
        atomicMultiPool: group,
      },
      {
        venue: "dcl",
        exchange: "dcl.testnet",
        poolId: "intermediate.testnet|mpoo.fixture.testnet|10000",
        tokenIn: "intermediate.testnet",
        tokenOut: "mpoo.fixture.testnet",
        feeBps: 100,
        atomicMultiPool: group,
      },
    ],
    netMinimumProof: {
      evidenceId: "fixture-immutable-tax-proof",
      mode: "immutable-transfer-tax",
      buyBps: 200,
      rounding: "floor-tax",
    },
  };
}
function config(group = true): RheaConfig {
  return {
    enabled: true,
    networkId: "testnet",
    maxInputYocto: "2000000000000000000000000",
    gasReserveYocto: "10000000000000000000000",
    maxPriceImpactBps: 100,
    route: route(group),
  };
}
const budget: RheaBudget = {
  spendableNativeYocto: "10000000000000000000000000",
  maximumGasYocto: "10000000000000000000000",
  reserveYocto: "10000000000000000000000",
  registrationGas: "30000000000000",
  wrapGas: "30000000000000",
  swapGas: "180000000000000",
  batchRegistrations: true,
};
function client(): RheaReadClient {
  return {
    async codeHash() {
      return { value: "code", blockHash: "block", blockHeight: 10 };
    },
    async view(id, method, args) {
      let value: unknown;
      if (method === "ft_metadata")
        value = { decimals: id === "wrap.testnet" ? 24 : 18 };
      else if (method === "get_pool") {
        const [token_x, token_y, fee] = String(args.pool_id).split("|");
        value = {
          token_x,
          token_y,
          fee: Number(fee),
          liquidity: "1000000000000000000000000000",
          state: "Running",
        };
      } else if (method === "get_tax")
        value = { tax: { buy_bps: 200, pairs: ["dcl.testnet"] } };
      else if (method === "quote")
        value = { amount: (BigInt(String(args.input_amount)) * 2n).toString() };
      else if (method === "storage_balance_of")
        value = { total: "1000", available: "0" };
      else if (method === "storage_balance_bounds")
        value = { min: "1000", max: null };
      else throw new Error("Unexpected method");
      return { value, blockHash: "block", blockHeight: 10 };
    },
  };
}
const registered = () =>
  Object.keys(route().decimals).map((tokenId) => ({
    tokenId,
    registered: true,
    minimumYocto: "0",
  }));
async function plan(group = true, missing = false) {
  const quote = await quoteMpooBuy(
    { context, inputNearYocto: amount, slippageBps: 100 },
    {
      config: config(group),
      client: client(),
      now: () => 1000,
      newId: () => "quote-1",
    },
  );
  return planMpooBuy(
    quote,
    budget,
    registered().map((x) => ({
      ...x,
      registered: !missing,
      minimumYocto: missing ? "1000" : "0",
    })),
  );
}
function controllerDeps() {
  const records = new Map<string, RheaOperation>();
  const deps: RheaControllerDependencies = {
    now: () => 2000,
    isCurrent: () => true,
    save: (op) => {
      records.set(op.operationId, structuredClone(op));
    },
    load: (id) => records.get(id) ?? null,
    preflight: vi.fn(async () => {}),
    approve: vi.fn(async (request: ApprovedTransactionRequest) => ({
      steps: request.transactions.map((_, index) => ({
        index,
        status: "confirmed" as const,
        transactionHash: `hash-${index}`,
      })),
      completedSteps: request.transactions.length,
    })),
    reconcile: vi.fn(async (op) => ({
      state: "received" as const,
      attributableOutputAtomic:
        op.plan.checkpoints[op.checkpoint].quote?.expectedNetAtomic ?? "0",
      nativeOutlayYocto: op.checkpoint === 0 ? amount : "1",
      message: "Confirmed receipts and attributable token output",
    })),
    onBalancesChanged: vi.fn(),
  };
  return { deps, records };
}

describe("RHEA exact amounts and route release gates", () => {
  it("preserves 24 decimals and rejects lossy or negative inputs", () => {
    expect(parseDisplayAmount("1.000000000000000000000001", 24)).toBe(
      "1000000000000000000000001",
    );
    for (const value of ["-1", "1e3", "0", "1.0000000000000000000000001"])
      expect(() => parseDisplayAmount(value, 24)).toThrow();
  });
  it("a feature flag cannot bypass missing route or net-tax proof", () => {
    const empty = createRheaConfig(
      {
        VITE_RHEA_MPOO_SWAP_ENABLED: "true",
        VITE_RHEA_MAX_INPUT_YOCTO: "100",
        VITE_RHEA_GAS_RESERVE_YOCTO: "10",
        VITE_RHEA_MAX_PRICE_IMPACT_BPS: "100",
      },
      "mainnet",
    );
    expect(() => validateRheaConfig(empty)).toThrow("route");
    const cfg = config();
    cfg.route!.netMinimumProof = null;
    expect(() => validateRheaConfig(cfg)).toThrow("minimum protection");
  });
  it("rejects mainnet fixture routes, wrong tokens and disconnected pools", () => {
    expect(() => validateManifest(route(), "mainnet")).toThrow();
    const wrong = route();
    wrong.legs[1].tokenIn = "unrelated.testnet";
    expect(() => validateManifest(wrong, "testnet")).toThrow("disconnected");
  });
  it("tax, metadata and code changes invalidate the reviewed route", async () => {
    const changed = client();
    changed.codeHash = async () => ({
      value: "new-code",
      blockHash: "block",
      blockHeight: 11,
    });
    await expect(readRouteEvidence(route(), changed)).rejects.toThrow(
      "code changed",
    );
    const cfg = config();
    cfg.route!.netMinimumProof!.buyBps = 100;
    await expect(readRouteEvidence(cfg.route!, client())).rejects.toThrow(
      "stale",
    );
  });
  it("does not turn RPC failures into empty balances or zero fees", async () => {
    const failing = createRheaReadClient(
      "https://rpc.testnet.near.org",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(
      failing.view("token.testnet", "ft_metadata", {}),
    ).rejects.toThrow("unavailable");
    const bad = client();
    bad.view = async () => {
      throw new Error("timeout");
    };
    await expect(
      readRequiredStorage(route(), context.accountId, bad),
    ).rejects.toThrow("timeout");
  });
});

describe("RHEA quote and transaction boundaries", () => {
  it("quotes net output once, never substitutes a gross minimum for the net floor", async () => {
    const result = await plan();
    expect(result.quote.expectedNetMpooAtomic).toBe(
      ((BigInt(amount) * 2n * 98n) / 100n).toString(),
    );
    expect(
      BigInt(result.quote.checkpoints[0].minimumGrossAtomic),
    ).toBeGreaterThan(BigInt(result.quote.minNetMpooAtomic));
  });
  it("owner batching puts wrap and all proven same-exchange hops in one approval", async () => {
    const result = await plan();
    expect(result.approvalCount).toBe(1);
    const transaction = result.checkpoints[0].transactions[0];
    expect(transaction.receiverId).toBe("wrap.testnet");
    expect(transaction.actions.map((x) => x.params.methodName)).toEqual([
      "near_deposit",
      "ft_transfer_call",
    ]);
    const message = JSON.parse(String(transaction.actions[1].params.args.msg));
    expect(message.Swap.pool_ids).toHaveLength(2);
    expect(transaction.actions[1].params.deposit).toBe("1");
  });
  it("unproven multi-pool semantics fall back to one checkpoint per hop", async () => {
    const result = await plan(false);
    expect(result.checkpoints).toHaveLength(2);
    expect(result.checkpoints[1].transactions[0].actions).toHaveLength(1);
    expect(
      result.checkpoints[1].transactions[0].actions[0].params.methodName,
    ).toBe("ft_transfer_call");
  });
  it("batches only independent missing registrations and retains gas/play reserve", async () => {
    const result = await plan(true, true);
    expect(result.approvalCount).toBe(2);
    expect(result.checkpoints[0].transactions).toHaveLength(3);
    for (const tx of result.checkpoints[0].transactions)
      expect(tx.actions[0].params.args.account_id).toBe(context.accountId);
    const quote = result.quote;
    expect(() =>
      planMpooBuy(
        quote,
        { ...budget, spendableNativeYocto: amount },
        registered(),
      ),
    ).toThrow("Not enough native");
  });
  it("expired quote construction and excessive combined gas cannot produce transactions", async () => {
    let now = 1000;
    await expect(
      quoteMpooBuy(
        { context, inputNearYocto: amount, slippageBps: 100 },
        { config: config(), client: client(), now: () => (now += 40000) },
      ),
    ).rejects.toThrow("expired");
    const result = await plan();
    expect(() =>
      planMpooBuy(
        result.quote,
        { ...budget, wrapGas: "200000000000000", swapGas: "200000000000000" },
        registered(),
      ),
    ).toThrow("gas exceeds");
  });
});

describe("RHEA approval, receipts and recovery", () => {
  it("a trusted pre-sign cancellation returns to review without waiting for a nonexistent hash", async () => {
    const { deps } = controllerDeps();
    const original = await plan();
    deps.approve = vi.fn(async () => ({
      steps: [
        { index: 0, status: "not_submitted" as const, transactionHash: null },
      ],
      completedSteps: 0,
    }));
    const cancelled = await executeMpooBuy(original, deps);
    expect(cancelled.phase).toBe("review");
    expect(cancelled.message).toContain("No transaction was sent");
    expect(cancelled.hashes).toEqual([]);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect((await resumeMpooBuy(context.operationId, deps)).phase).toBe(
      "review",
    );
    const fresh = structuredClone(original);
    fresh.quote.id = "quote-after-cancel";
    deps.approve = vi.fn(async () => ({
      steps: [
        {
          index: 0,
          status: "confirmed" as const,
          transactionHash: "new-approved-hash",
        },
      ],
      completedSteps: 1,
    }));
    expect(
      (await continueMpooBuy(context.operationId, fresh, deps)).phase,
    ).toBe("complete");
    expect(deps.approve).toHaveBeenCalledOnce();
  });
  it("keeps confirmed registrations when a later registration approval is explicitly cancelled", async () => {
    const { deps } = controllerDeps();
    const original = await plan(true, true);
    deps.approve = vi.fn(async () => ({
      steps: [
        {
          index: 0,
          status: "confirmed" as const,
          transactionHash: "confirmed-registration",
        },
        { index: 1, status: "not_submitted" as const, transactionHash: null },
      ],
      completedSteps: 1,
    }));
    deps.reconcile = vi.fn(async () => ({
      state: "received" as const,
      attributableOutputAtomic: "0",
      nativeOutlayYocto: "1100",
      message: "One registration confirmed",
    }));
    const result = await executeMpooBuy(original, deps);
    expect(result.phase).toBe("next_checkpoint_review");
    expect(result.completed).toBe(1);
    expect(result.hashes).toEqual(["confirmed-registration"]);
    expect(result.plan.maxNativeSpendYocto).toBe(original.maxNativeSpendYocto);
    expect(result.plan.checkpoints[0].transactions).toHaveLength(1);
    expect(result.plan.checkpoints[1].transactions).toHaveLength(2);
    expect(result.message).toContain("Confirmed registrations remain");
    expect(deps.reconcile).toHaveBeenCalledOnce();
    expect(deps.approve).toHaveBeenCalledOnce();
    await resumeMpooBuy(context.operationId, deps);
    expect(deps.approve).toHaveBeenCalledOnce();
  });
  it("an unknown attempt takes precedence over a later unsubmitted step", async () => {
    const { deps } = controllerDeps();
    deps.approve = vi.fn(async () => ({
      steps: [
        {
          index: 0,
          status: "unknown" as const,
          transactionHash: "possibly-broadcast",
        },
        { index: 1, status: "not_submitted" as const, transactionHash: null },
      ],
      completedSteps: 0,
    }));
    expect((await executeMpooBuy(await plan(true, true), deps)).phase).toBe(
      "unresolved",
    );
    expect(deps.reconcile).not.toHaveBeenCalled();
  });
  it("confirms attributable net output and does not purchase credits", async () => {
    const { deps } = controllerDeps();
    const result = await executeMpooBuy(await plan(), deps);
    expect(result.phase).toBe("complete");
    expect(result.message).toContain("credits are unchanged");
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(deps.onBalancesChanged).toHaveBeenCalledTimes(1);
    await expect(executeMpooBuy(await plan(), deps)).rejects.toThrow(
      "already has",
    );
  });
  it("unknown broadcast survives reload and never resubmits or starts a later checkpoint", async () => {
    const { deps } = controllerDeps();
    deps.approve = vi.fn(async () => ({
      steps: [{ index: 0, status: "unknown" as const, transactionHash: null }],
      completedSteps: 0,
    }));
    deps.reconcile = vi.fn(async () => ({
      state: "unknown" as const,
      attributableOutputAtomic: "0",
      nativeOutlayYocto: "0",
      message: "Still unresolved",
    }));
    const result = await executeMpooBuy(await plan(false), deps);
    expect(result.phase).toBe("unresolved");
    expect((await resumeMpooBuy(context.operationId, deps)).phase).toBe(
      "unresolved",
    );
    expect(deps.approve).toHaveBeenCalledTimes(1);
  });
  it("a resolved token refund is not a successful acquisition", async () => {
    const { deps } = controllerDeps();
    deps.reconcile = vi.fn(async () => ({
      state: "refunded" as const,
      attributableOutputAtomic: "0",
      nativeOutlayYocto: "100",
      message: "Swap refunded wNEAR to wallet",
    }));
    expect((await executeMpooBuy(await plan(), deps)).phase).toBe("refunded");
  });
  it("unattributed or below-floor output cannot manufacture a successful fill", async () => {
    const { deps } = controllerDeps();
    deps.reconcile = vi.fn(async () => ({
      state: "received" as const,
      attributableOutputAtomic: "1",
      nativeOutlayYocto: "100",
      message: "Unrelated transfer excluded",
    }));
    expect((await executeMpooBuy(await plan(), deps)).phase).toBe("partial");
  });
  it("wallet change during preflight stops before approval", async () => {
    const { deps } = controllerDeps();
    let current = true;
    deps.isCurrent = () => current;
    deps.preflight = vi.fn(async () => {
      current = false;
    });
    await expect(executeMpooBuy(await plan(), deps)).rejects.toThrow(
      "Wallet changed",
    );
    expect(deps.approve).not.toHaveBeenCalled();
  });
  it("each cross-checkpoint continuation needs a new quote and preserves cumulative cap", async () => {
    const { deps } = controllerDeps();
    const original = await plan(false);
    const result = await executeMpooBuy(original, deps);
    expect(result.phase).toBe("next_checkpoint_review");
    await expect(
      continueMpooBuy(result.operationId, original, deps),
    ).rejects.toThrow("ceiling");
    const changed = structuredClone(original);
    changed.quote.id = "new-quote";
    changed.maxNativeSpendYocto = (
      BigInt(original.maxNativeSpendYocto) + 1n
    ).toString();
    await expect(
      continueMpooBuy(result.operationId, changed, deps),
    ).rejects.toThrow("ceiling");
  });
  it("durable records reject corruption instead of blindly retrying", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const store = createRheaOperationStore(storage);
    const { deps } = controllerDeps();
    deps.save = store.save;
    deps.load = store.load;
    await executeMpooBuy(await plan(), deps);
    expect(store.load(context.operationId)?.phase).toBe("complete");
    storage.setItem(`metapoo:rhea:detail:v1:${context.operationId}`, "broken");
    expect(() => store.load(context.operationId)).toThrow("corrupt");
  });
});

describe("RHEA accessible panel", () => {
  it("checks newly selected saved swap B after previously displaying swap A", async () => {
    const { deps } = controllerDeps();
    const savedA = await executeMpooBuy(await plan(false), deps);
    const savedB = structuredClone(savedA);
    savedB.operationId = "saved-swap-B";
    savedB.context = {
      ...savedB.context,
      operationId: savedB.operationId,
      accountId: "bob.testnet",
    };
    savedB.message = "Swap B is still waiting for its original transaction.";
    let selectedId = savedA.operationId;
    const resume = vi.fn(async (id: string) =>
      id === savedB.operationId ? savedB : savedA,
    );
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = mountRheaPanel(host, {
      getContext: () => null,
      prepareQuote: vi.fn(),
      approve: vi.fn(),
      resume,
      lastOperationId: () => selectedId,
    });
    try {
      const recovery = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Check previous swap",
      )!;
      recovery.click();
      await vi.waitFor(() =>
        expect(host.textContent).toContain(
          "Swap for alice.testnet on testnet:",
        ),
      );
      selectedId = savedB.operationId;
      recovery.click();
      await vi.waitFor(() =>
        expect(host.textContent).toContain("Swap for bob.testnet on testnet:"),
      );
      expect(resume.mock.calls.map(([id]) => id)).toEqual([
        savedA.operationId,
        savedB.operationId,
      ]);
      expect(host.textContent).toContain(savedB.message);
    } finally {
      dispose();
      host.remove();
    }
  });
  it("unverified production routing leaves an honest fallback and cannot open approval", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const approve = vi.fn();
    const dispose = mountRheaPanel(host, {
      getContext: () => context,
      prepareQuote: vi.fn(),
      approve,
      resume: vi.fn(),
      availabilityReason: "Net minimum protection has not been verified.",
    });
    try {
      expect(host.textContent).toContain("Net minimum protection");
      expect(
        host.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(true);
      expect(host.querySelector("a")?.getAttribute("href")).toContain(
        "nearly.trade",
      );
      expect(approve).not.toHaveBeenCalled();
    } finally {
      dispose();
      host.remove();
    }
  });
  it("shows explicitly requested recovery while disconnected, and continues only on the original connected account", async () => {
    const { deps } = controllerDeps();
    const saved = await executeMpooBuy(await plan(false), deps);
    expect(saved.phase).toBe("next_checkpoint_review");
    let current: OperationContext | null = null;
    let notify = () => {};
    const unsubscribe = vi.fn();
    const prepareContinuation = vi.fn();
    const approve = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = mountRheaPanel(host, {
      getContext: () => current,
      subscribeContext: (listener) => {
        notify = listener;
        return unsubscribe;
      },
      prepareQuote: vi.fn(),
      approve,
      resume: vi.fn(async () => saved),
      lastOperationId: () => saved.operationId,
      prepareContinuation,
    });
    try {
      const recovery = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Check previous swap",
      )!;
      const next = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Review next checkpoint",
      )!;
      recovery.click();
      await vi.waitFor(() =>
        expect(host.textContent).toContain(
          "Swap for alice.testnet on testnet:",
        ),
      );
      expect(next.hidden).toBe(true);
      current = { ...context, accountId: "bob.testnet" };
      notify();
      expect(next.hidden).toBe(true);
      recovery.click();
      await vi.waitFor(() => expect(host.textContent).toContain(saved.message));
      expect(approve).not.toHaveBeenCalled();
      current = { ...context, sessionEpoch: context.sessionEpoch + 10 };
      notify();
      expect(next.hidden).toBe(false);
      saved.phase = "review";
      notify();
      expect(next.hidden).toBe(false);
      current = null;
      notify();
      expect(next.hidden).toBe(true);
      next.click();
      expect(prepareContinuation).not.toHaveBeenCalled();
    } finally {
      dispose();
      host.remove();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

function finalOutcome(
  transaction: RheaExecutionPlan["checkpoints"][number]["transactions"][number],
  used: string,
  outputAmount: string,
  refund = false,
) {
  const encode = (value: unknown) => btoa(JSON.stringify(value));
  const transfer = {
    standard: "nep141",
    version: "1.0.0",
    event: "ft_transfer",
    data: [
      {
        old_owner_id: "dcl.testnet",
        new_owner_id: context.accountId,
        amount: outputAmount,
      },
    ],
  };
  return {
    transaction: {
      hash: "trace-hash",
      signer_id: context.accountId,
      receiver_id: transaction.receiverId,
      actions: transaction.actions.map((action) => ({
        FunctionCall: {
          method_name: action.params.methodName,
          gas: Number(action.params.gas),
          deposit: action.params.deposit,
          args: encode(action.params.args),
        },
      })),
    },
    transaction_outcome: { outcome: { tokens_burnt: "10" } },
    status: { SuccessValue: encode(used) },
    receipts_outcome: [
      {
        outcome: {
          executor_id: refund ? "wrap.testnet" : "mpoo.fixture.testnet",
          tokens_burnt: "20",
          logs: [`EVENT_JSON:${JSON.stringify(transfer)}`],
          status: { SuccessValue: "" },
        },
      },
    ],
  };
}

describe("RHEA actual transaction-trace adapter", () => {
  it("requires the requested hash as well as matching actions, resolver and attributable token events", async () => {
    const p = await plan();
    const { deps } = controllerDeps();
    deps.approve = vi.fn(async () => ({
      steps: [
        { index: 0, status: "unknown" as const, transactionHash: "trace-hash" },
      ],
      completedSteps: 0,
    }));
    const op = await executeMpooBuy(p, deps);
    const output = p.quote.expectedNetMpooAtomic;
    const trace = finalOutcome(
      p.checkpoints[0].transactions[0],
      amount,
      output,
    );
    const readClient = client();
    const view = readClient.view;
    readClient.view = async (id, method, args) =>
      method === "ft_balance_of"
        ? { value: output, blockHash: "block", blockHeight: 11 }
        : view(id, method, args);
    expect(
      (
        await reconcileRheaCheckpoint(op, {
          rpc: async () => trace,
          client: readClient,
        })
      ).state,
    ).toBe("received");
    trace.transaction.hash = "earlier-identical-trade";
    expect(
      (
        await reconcileRheaCheckpoint(op, {
          rpc: async () => trace,
          client: readClient,
        })
      ).state,
    ).toBe("unknown");
    trace.transaction.hash = "trace-hash";
    trace.receipts_outcome[0].outcome.logs = [];
    expect(
      (
        await reconcileRheaCheckpoint(op, {
          rpc: async () => trace,
          client: readClient,
        })
      ).state,
    ).toBe("unknown");
    trace.transaction.receiver_id = "attacker.testnet";
    expect(
      (
        await reconcileRheaCheckpoint(op, {
          rpc: async () => trace,
          client: readClient,
        })
      ).message,
    ).toContain("does not match");
  });
  it("a zero-used-input resolver plus token refund never reports mPOO acquisition", async () => {
    const p = await plan();
    const { deps } = controllerDeps();
    deps.approve = vi.fn(async () => ({
      steps: [
        { index: 0, status: "unknown" as const, transactionHash: "trace-hash" },
      ],
      completedSteps: 0,
    }));
    const op = await executeMpooBuy(p, deps);
    const trace = finalOutcome(
      p.checkpoints[0].transactions[0],
      "0",
      amount,
      true,
    );
    expect(
      (
        await reconcileRheaCheckpoint(op, {
          rpc: async () => trace,
          client: client(),
        })
      ).state,
    ).toBe("refunded");
  });
  it("configured fixture runtime joins real wire reads, quote, wallet plan and receipt parser", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    let approved: ApprovedTransactionRequest | null = null;
    let availableNative = "10000000000000000000000000";
    let verifiedEventsAvailable = false;
    const readClient = client();
    const fetcher: typeof fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      if (request.method === "EXPERIMENTAL_protocol_config")
        result = { runtime_config: { storage_amount_per_byte: "1" } };
      else if (request.method === "gas_price")
        result = { gas_price: "100000000" };
      else if (request.method === "tx") {
        if (!approved) throw new Error("No approved transaction");
        result = finalOutcome(
          approved
            .transactions[0] as RheaExecutionPlan["checkpoints"][number]["transactions"][number],
          amount,
          ((BigInt(amount) * 196n) / 100n).toString(),
        );
        if (!verifiedEventsAvailable)
          (
            result as ReturnType<typeof finalOutcome>
          ).receipts_outcome[0].outcome.logs = [];
      } else if (request.params.request_type === "view_account")
        result = {
          code_hash: "code",
          amount: availableNative,
          locked: "0",
          storage_usage: 0,
          block_hash: "block",
          block_height: 10,
        };
      else {
        const { account_id, method_name, args_base64 } = request.params;
        const args = JSON.parse(atob(args_base64));
        const value =
          method_name === "ft_balance_of"
            ? ((BigInt(amount) * 196n) / 100n).toString()
            : (await readClient.view(account_id, method_name, args)).value;
        result = {
          result: Array.from(new TextEncoder().encode(JSON.stringify(value))),
          block_hash: "block",
          block_height: 10,
        };
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const onReconciled = vi.fn();
    const runtime = createRheaRuntime({
      config: config(),
      rpcUrl: "https://rpc.testnet.near.org",
      context: () => context,
      storage,
      fetcher,
      now: () => 1000,
      gas: {
        registrationGas: budget.registrationGas,
        wrapGas: budget.wrapGas,
        swapGas: budget.swapGas,
      },
      approve: async (request) => {
        approved = request;
        return {
          steps: [
            { index: 0, status: "confirmed", transactionHash: "trace-hash" },
          ],
          completedSteps: 1,
        };
      },
      onBalancesChanged: vi.fn(),
      onReconciled,
    });
    const candidate = await runtime.prepareQuote(
      amount,
      100,
      new AbortController().signal,
    );
    expect(candidate.approvalCount).toBe(1);
    expect((await runtime.approve(candidate)).phase).toBe("unresolved");
    expect(onReconciled).not.toHaveBeenCalled();
    // A cancelled/pre-swap review must not credit the original input as already wrapped.
    const notYetSwapped = createRheaOperationStore(storage).load(
      context.operationId,
    )!;
    notYetSwapped.phase = "review";
    availableNative = amount;
    await expect(
      runtime.prepareContinuation!(notYetSwapped, new AbortController().signal),
    ).rejects.toThrow("Not enough native");
    availableNative = "10000000000000000000000000";
    expect(runtime.lastOperationId?.()).toBe(context.operationId);
    verifiedEventsAvailable = true;
    expect((await runtime.resume(context.operationId)).phase).toBe("complete");
    expect(onReconciled).toHaveBeenCalledExactlyOnceWith(context);
  });
});
