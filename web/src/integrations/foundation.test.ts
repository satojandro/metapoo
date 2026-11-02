import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyPair } from "@near-js/crypto";
import {
  implicitKeyMatches,
  resolveAccountReadiness,
} from "./account-readiness";
import { computeSpendableNative } from "./gas-budget";
import { createAcquisitionStore } from "./operation-store";
import {
  reconcilePendingCapitalAttempt,
  completeReceiptStatus,
  createApprovedTransactionGateway,
  validateAcquisitionTransaction,
} from "./approved-transactions";
import type {
  ApprovedNearTransaction,
  ApprovedTransactionRequest,
  OperationContext,
} from "./types";
const context: OperationContext = {
  operationId: "op-1",
  accountId: "alice.near",
  networkId: "mainnet",
  sessionEpoch: 1,
};
function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}
const tx: ApprovedNearTransaction = {
  receiverId: "wrap.near",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "near_withdraw",
        args: { amount: "10" },
        gas: "10",
        deposit: "1",
      },
    },
  ],
};
const req = (): ApprovedTransactionRequest => ({
  context,
  purpose: "funding-unwrap",
  transactions: [tx],
  approval: { summary: "Unwrap", maxNativeSpendYocto: "100" },
});
const success = {
  transaction: { hash: "hash" },
  status: { SuccessValue: "" },
  receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
};
const policy = {
  wrapAccount: "wrap.near",
  tokenAccounts: ["wrap.near"],
  exchangeAccounts: [],
  poolIds: [],
  storageMaximums: {},
};
describe("acquisition account and budget boundaries", () => {
  it("matches a fresh implicit address to the actual ed25519 provider key", () => {
    const key = KeyPair.fromRandom("ed25519").getPublicKey();
    const address = Array.from(key.data)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    expect(implicitKeyMatches(address, key.toString())).toBe(true);
    expect(implicitKeyMatches("0".repeat(64), key.toString())).toBe(false);
  });
  it("distinguishes absent account from a network failure", async () => {
    expect(
      (
        await resolveAccountReadiness("alice.near", "mainnet", async () => {
          throw { cause: { name: "UNKNOWN_ACCOUNT" } };
        })
      ).state,
    ).toBe("absent");
    expect(
      (
        await resolveAccountReadiness("alice.near", "mainnet", async () => {
          throw new Error("timeout");
        })
      ).state,
    ).toBe("unavailable");
  });
  it("does not subtract storage twice when it overlaps locked balance", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        amount: "100",
        locked: "20",
        storage_usage: 5,
        block_hash: "block",
      })
      .mockResolvedValueOnce({
        runtime_config: { storage_amount_per_byte: "3" },
      });
    const r = await resolveAccountReadiness("alice.near", "mainnet", rpc);
    expect(r.state === "ready" && r.spendableBeforeGasYocto).toBe("100");
  });
  it("keeps precision and reserves without treating allowance as locked money", () => {
    const b = computeSpendableNative({
      spendableBeforeGasYocto: "900719925474099300",
      payableDepositsYocto: "10",
      gasCeilingYocto: "20",
      playReserveYocto: "30",
    });
    expect(b.maxInputYocto).toBe("900719925474099240");
    expect(() =>
      computeSpendableNative({ ...b, gasCeilingYocto: "1e3" }),
    ).toThrow();
  });
  it("rejects corrupt recovery instead of starting a replacement payment", () => {
    const s = memory();
    s.setItem("metapoo:acquisition:v1:op-1", "{");
    expect(() => createAcquisitionStore(s).load("op-1")).toThrow(/corrupt/);
  });
});
describe("ordinary-wallet acquisition gateway", () => {
  function setup() {
    const storage = memory();
    let active: OperationContext | null = context;
    const deps = {
      context: () => active,
      storage,
      now: () => 10,
      validateTransaction: (
        t: ApprovedNearTransaction,
        r: ApprovedTransactionRequest,
      ) => validateAcquisitionTransaction(t, r, policy),
      readBudget: vi.fn(async () => ({
        spendableBeforeGasYocto: "1000",
        gasPriceYocto: "1",
        playReserveYocto: "5",
      })),
      send: vi.fn(async (): Promise<unknown> => success),
    };
    return {
      deps,
      storage,
      gateway: createApprovedTransactionGateway(deps),
      switchAccount: () => {
        active = { ...context, accountId: "bob.near" };
      },
    };
  }
  it("requires final receipts and catches child failures", () => {
    expect(
      completeReceiptStatus({
        transaction: { hash: "h" },
        status: { SuccessReceiptId: "r" },
      }),
    ).toBe("unknown");
    expect(
      completeReceiptStatus({
        ...success,
        receipts_outcome: [{ outcome: { status: { Failure: "refund" } } }],
      }),
    ).toBe("failed");
  });
  it("rejects arbitrary methods before opening the wallet", async () => {
    const { gateway, deps } = setup();
    const r = req();
    r.transactions = [
      {
        ...tx,
        actions: [
          {
            type: "FunctionCall",
            params: { ...tx.actions[0].params, methodName: "ft_transfer" },
          },
        ],
      },
    ];
    await expect(gateway(r)).rejects.toThrow(/mismatch|outside/);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it("checks identity again after preflight RPC", async () => {
    const s = setup();
    s.deps.readBudget.mockImplementation(async () => {
      s.switchAccount();
      return {
        spendableBeforeGasYocto: "1000",
        gasPriceYocto: "1",
        playReserveYocto: "5",
      };
    });
    await expect(s.gateway(req())).rejects.toThrow(/identity/);
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it("stops on unknown broadcast and blocks a new operation", async () => {
    const s = setup();
    s.deps.send.mockRejectedValue(new Error("RPC timeout"));
    expect((await s.gateway(req())).steps[0].status).toBe("unknown");
    await expect(
      s.gateway({ ...req(), context: { ...context, operationId: "op-2" } }),
    ).rejects.toThrow(/reconciliation/);
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });
  it("keeps the all-in ceiling across separately approved checkpoints", async () => {
    const s = setup();
    const r = req();
    r.approval.maxNativeSpendYocto = "30";
    expect((await s.gateway(r)).completedSteps).toBe(1);
    await expect(s.gateway(r)).rejects.toThrow(/ceiling/);
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });
  it("snapshots the reviewed plan before awaits", async () => {
    const s = setup();
    const r = req();
    s.deps.readBudget.mockImplementation(async () => {
      r.transactions = [];
      return {
        spendableBeforeGasYocto: "1000",
        gasPriceYocto: "1",
        playReserveYocto: "5",
      };
    });
    expect((await s.gateway(r)).completedSteps).toBe(1);
    expect(s.deps.send).toHaveBeenCalledWith(tx, context);
  });
  it("does not allow a later checkpoint to raise its original spending ceiling", async () => {
    const s = setup();
    const r = req();
    r.approval.maxNativeSpendYocto = "30";
    await s.gateway(r);
    r.approval.maxNativeSpendYocto = "1000";
    await expect(s.gateway(r)).rejects.toThrow(/ceiling/);
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });
  it("resolves a known original hash once without resending", async () => {
    const s = setup();
    s.deps.send.mockResolvedValue({
      transaction: { hash: "hash" },
      status: { SuccessReceiptId: "receipt" },
    });
    await s.gateway(req());
    const trace = {
      ...success,
      transaction: {
        hash: "hash",
        signer_id: context.accountId,
        receiver_id: "wrap.near",
        actions: [
          {
            FunctionCall: {
              method_name: "near_withdraw",
              gas: "10",
              deposit: "1",
              args: btoa(JSON.stringify({ amount: "10" })),
            },
          },
        ],
      },
    };
    const lookup = vi.fn(async () => trace);
    expect(
      await reconcilePendingCapitalAttempt(context, s.storage, lookup),
    ).toBe(true);
    expect(
      await reconcilePendingCapitalAttempt(context, s.storage, lookup),
    ).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(
      s.storage.getItem("metapoo:capital:spent:mainnet:alice.near:op-1"),
    ).toBe("21");
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });
  it("retains an attempt with mismatched trace or missing hash", async () => {
    const s = setup();
    s.deps.send.mockResolvedValue({
      transaction: { hash: "hash" },
      status: { SuccessReceiptId: "r" },
    });
    await s.gateway(req());
    expect(
      await reconcilePendingCapitalAttempt(context, s.storage, async () => ({
        ...success,
        transaction: { hash: "hash", signer_id: "other.near" },
      })),
    ).toBe(false);
    const raw = JSON.parse(
      s.storage.getItem("metapoo:capital:pending:mainnet:alice.near")!,
    );
    raw.transactionHash = null;
    s.storage.setItem(
      "metapoo:capital:pending:mainnet:alice.near",
      JSON.stringify(raw),
    );
    const lookup = vi.fn();
    expect(
      await reconcilePendingCapitalAttempt(context, s.storage, lookup),
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("batches independent registrations into one wallet approval", async () => {
    const s = setup();
    s.deps.validateTransaction = () => undefined;
    const sendBatch = vi.fn(async () => [success, success]);
    const gateway = createApprovedTransactionGateway({ ...s.deps, sendBatch });
    const registration = {
      receiverId: "token.near",
      actions: [
        {
          type: "FunctionCall" as const,
          params: {
            methodName: "storage_deposit",
            args: { account_id: "alice.near", registration_only: true },
            gas: "1",
            deposit: "1",
          },
        },
      ],
    };
    expect(
      (
        await gateway({
          ...req(),
          purpose: "mpoo-acquisition",
          transactions: [registration, registration],
        })
      ).completedSteps,
    ).toBe(2);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(s.deps.send).not.toHaveBeenCalled();
  });
  it("protects the gas reserve", async () => {
    const s = setup();
    s.deps.readBudget.mockResolvedValue({
      spendableBeforeGasYocto: "22",
      gasPriceYocto: "1",
      playReserveYocto: "5",
    });
    await expect(s.gateway(req())).rejects.toThrow(/reserve/);
    expect(s.deps.send).not.toHaveBeenCalled();
  });
});

// Node 22 CI has no browser Web Locks implementation; model its ifAvailable semantics explicitly.
beforeEach(() => {
  let held = false;
  vi.stubGlobal("navigator", {
    locks: {
      async request(
        _name: string,
        _options: unknown,
        run: (lock: object | null) => Promise<unknown>,
      ) {
        if (held) return run(null);
        held = true;
        try {
          return await run({ name: "metapoo:capital" });
        } finally {
          held = false;
        }
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
