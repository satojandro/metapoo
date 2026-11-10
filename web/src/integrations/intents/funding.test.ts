import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntentsFundingController } from "./funding";
import { createIntentsStorage } from "./storage";
import {
  FIXTURE_CONTEXT,
  FIXTURE_REFUND,
  FIXTURE_TIME,
  FIXTURE_TOKEN,
  fixtureQuote,
  fixtureStatus,
} from "./fixtures";
import type {
  FundingClient,
  FundingEvidence,
  FundingPolicy,
  FundingReadiness,
  FundingStatus,
} from "./types";
import type { OperationContext } from "../types";
import { parseQuote, parseStatus } from "./client";
import { REVIEWED_PLATFORM_FEE_RECIPIENT } from "./quote";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});
function setup(policyPatch: Partial<FundingPolicy> = {}) {
  let context: OperationContext | null = { ...FIXTURE_CONTEXT };
  let readiness: FundingReadiness = {
    state: "ready",
    expectedKeyMatches: true,
    spendableBeforeGasYocto: "1000000",
  };
  let providerStatus: FundingStatus["status"] = "PROCESSING";
  let evidence: FundingEvidence = { state: "pending" };
  let time = FIXTURE_TIME;
  const durable = new MemoryStorage();
  const storage = createIntentsStorage(durable);
  const client: FundingClient = {
    tokens: vi.fn(async () => [FIXTURE_TOKEN]),
    verify: vi.fn(async () => true),
    quote: vi.fn(async (request) => fixtureQuote(request)),
    status: vi.fn(async (quote) => fixtureStatus(quote, providerStatus)),
  };
  const policy: FundingPolicy = {
    enabled: true,
    transportVerified: true,
    deliveryMode: "native",
    nativeDeliveryEvidence: {
      reference: "fixture-only-proof",
      initializedNamed: true,
      initializedImplicit: true,
      uninitializedImplicit: false,
    },
    sourceAllowlist: [{ assetId: FIXTURE_TOKEN.assetId, blockchain: "base" }],
    playReserveYocto: "1000",
    ...policyPatch,
  };
  const onBalancesChanged = vi.fn();
  const controller = createIntentsFundingController({
    client,
    storage,
    policy,
    poll: false,
    currentContext: () => context,
    readReadiness: async () => readiness,
    reconcileDestination: async () => evidence,
    onBalancesChanged,
    now: () => time,
  });
  cleanups.push(controller.dispose);
  const input = {
    assetId: FIXTURE_TOKEN.assetId,
    amount: "1",
    refundAddress: FIXTURE_REFUND,
    refundAddressConfirmed: true,
  };
  const prepare = async () => {
    await controller.loadAssets();
    return controller.preview(input, context!);
  };
  const commit = async () => {
    const state = await prepare();
    return controller.commit(state.preview!.correlationId, context!);
  };
  return {
    controller,
    client,
    storage,
    durable,
    policy,
    input,
    prepare,
    commit,
    onBalancesChanged,
    setContext(value: OperationContext | null) {
      context = value;
    },
    setReadiness(value: FundingReadiness) {
      readiness = value;
    },
    setStatus(value: FundingStatus["status"]) {
      providerStatus = value;
    },
    setEvidence(value: FundingEvidence) {
      evidence = value;
    },
    setTime(value: number) {
      time = value;
    },
  };
}

describe("Intents funding authority and recovery", () => {
  it("blocks payable addresses without native delivery evidence or browser transport proof", async () => {
    const app = setup({ transportVerified: false });
    expect((await app.commit()).canSend).toBe(false);
    expect(app.client.quote).toHaveBeenCalledTimes(1); // Preview only, never a committed address.
    const other = setup({
      nativeDeliveryEvidence: {
        reference: "",
        initializedNamed: true,
        initializedImplicit: true,
        uninitializedImplicit: true,
      },
    });
    expect((await other.commit()).message).toContain("not been verified");
  });
  it("lets the owner run the route in test mode without recording any evidence", async () => {
    const app = setup({
      nativeDeliveryEvidence: {
        reference: "",
        initializedNamed: false,
        initializedImplicit: false,
        uninitializedImplicit: false,
      },
      unverifiedTestDelivery: true,
    });
    const snapshot = await app.commit();
    expect(snapshot.canSend).toBe(true);
    // Test mode is a switch, never a claim: the evidence block is still empty afterwards.
    expect(app.policy.nativeDeliveryEvidence.reference).toBe("");
    expect(app.policy.nativeDeliveryEvidence.initializedNamed).toBe(false);
  });
  it("re-reads a stale asset registry for the player instead of refusing the quote", async () => {
    // Before: a player who took over a minute to fill the form got "Refresh supported assets
    // before requesting a quote" and had to find a button for it.
    const app = setup();
    await app.controller.loadAssets();
    app.setTime(FIXTURE_TIME + 5 * 60_000);
    const snapshot = await app.controller.preview(app.input, FIXTURE_CONTEXT);
    expect(snapshot.phase).toBe("review");
    expect(app.client.tokens).toHaveBeenCalledTimes(2);
  });
  it("keeps tracking when the status echo carries no correlationId", async () => {
    // Live provider shape (10 Nov 2026): /v0/status returns the signed quote without
    // correlationId and with explicit null referral/virtualChain* fields. Polling this
    // used to replace the deposit instructions with "Unsupported provider status".
    const app = setup();
    const committed = await app.commit();
    const operationId = committed.operation!.id;
    const echo = () => {
      const raw = structuredClone(committed.operation!.quote.raw);
      delete raw.correlationId;
      Object.assign(raw.quoteRequest as Record<string, unknown>, {
        referral: null,
        virtualChainRecipient: null,
        virtualChainRefundRecipient: null,
      });
      return raw;
    };
    const providerStatus = (quoteResponse: unknown) =>
      parseStatus({
        status: "PENDING_DEPOSIT",
        updatedAt: new Date(FIXTURE_TIME + 1000).toISOString(),
        correlationId: "provider-envelope-id",
        swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
        quoteResponse,
      });
    vi.mocked(app.client.status).mockImplementation(async () =>
      providerStatus(echo()),
    );
    const snapshot = await app.controller.refresh(operationId);
    expect(snapshot.phase).toBe("awaiting_deposit");
    expect(snapshot.message).toContain("Waiting for your source payment");
    expect(snapshot.operation?.id).toBe(operationId);

    // A provider that does echo a different correlation id is still refused.
    vi.mocked(app.client.status).mockImplementation(async () =>
      providerStatus({ ...echo(), correlationId: "some-other-payment" }),
    );
    const mismatched = await app.controller.refresh(operationId);
    expect(mismatched.phase).not.toBe("awaiting_deposit");
    expect(mismatched.message).toContain("Status does not match");
  });
  it("rejects testnet funding and a nonexistent named account", async () => {
    const app = setup();
    app.setContext({ ...FIXTURE_CONTEXT, networkId: "testnet" });
    await app.controller.loadAssets();
    expect(app.client.tokens).not.toHaveBeenCalled();
    const missing = setup();
    missing.setReadiness({ state: "absent", expectedKeyMatches: false });
    expect((await missing.commit()).operation).toBeUndefined();
  });
  it("permits first implicit funding only when address/key and that delivery case are proven", async () => {
    const app = setup({
      nativeDeliveryEvidence: {
        reference: "fixture",
        initializedNamed: false,
        initializedImplicit: false,
        uninitializedImplicit: true,
      },
    });
    app.setContext({ ...FIXTURE_CONTEXT, accountId: "a".repeat(64) });
    app.setReadiness({ state: "absent", expectedKeyMatches: true });
    expect((await app.commit()).canSend).toBe(true);
    const wrong = setup({
      nativeDeliveryEvidence: app.policy.nativeDeliveryEvidence,
    });
    wrong.setContext({ ...FIXTURE_CONTEXT, accountId: "a".repeat(64) });
    wrong.setReadiness({ state: "absent", expectedKeyMatches: false });
    expect((await wrong.commit()).canSend).toBe(false);
  });
  it("never exposes a quote received after an account switch", async () => {
    const app = setup();
    await app.controller.loadAssets();
    let release!: (quote: ReturnType<typeof fixtureQuote>) => void;
    vi.mocked(app.client.quote).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = app.controller.preview(app.input, FIXTURE_CONTEXT);
    app.setContext({
      ...FIXTURE_CONTEXT,
      accountId: "other.near",
      sessionEpoch: 2,
    });
    release(fixtureQuote());
    const result = await pending;
    expect(result.preview).toBeUndefined();
    expect(result.canSend).toBe(false);
  });
  it("persists before showing an address and blocks duplicate committed operations", async () => {
    const app = setup();
    const state = await app.commit();
    expect(state.canSend).toBe(true);
    expect(
      app.storage.load(FIXTURE_CONTEXT.operationId)?.quote.quote.depositAddress,
    ).toBe(state.operation?.quote.quote.depositAddress);
    const again = await app.commit();
    expect(again.message).toContain("already exists");
    expect(app.client.quote).toHaveBeenCalledTimes(3); // two previews, one commit.
  });
  it("does not expose an address when durable storage fails", async () => {
    const app = setup();
    vi.spyOn(app.durable, "setItem").mockImplementation((key, value) => {
      if (key.startsWith("metapoo:intents:")) throw new Error("Storage full");
      app.durable.data.set(key, value);
    });
    expect((await app.commit()).operation).toBeUndefined();
    expect(app.controller.getState().canSend).toBe(false);
  });
  it("keeps recovery read-only after logout and while new funding is disabled", async () => {
    const app = setup();
    const committed = await app.commit();
    app.setContext(null);
    app.policy.enabled = false;
    const recovered = await app.controller.resume(committed.operation!.id);
    expect(recovered.phase).toBe("processing");
    expect(recovered.canSend).toBe(false);
    expect(app.client.quote).toHaveBeenCalledTimes(2);
  });
  it("requires attribution and native gas, not provider SUCCESS or a token balance alone", async () => {
    const app = setup();
    await app.commit();
    app.setStatus("SUCCESS");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("settled_verifying");
    app.setEvidence({ state: "verified_wrapped", amountYocto: "1000000" });
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("needs_unwrap");
    app.setEvidence({ state: "verified_native", spendableBeforeGasYocto: "1" });
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("settled_verifying");
    app.setEvidence({
      state: "verified_native",
      spendableBeforeGasYocto: "1000000",
      receiptId: "receipt",
      transactionHash: "transaction",
    });
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("funded");
    expect(app.onBalancesChanged).toHaveBeenCalledTimes(1);
  });
  it("does not call incomplete deposit or failure a confirmed refund", async () => {
    const app = setup();
    await app.commit();
    app.setStatus("INCOMPLETE_DEPOSIT");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("incomplete_deposit");
    app.setStatus("FAILED");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("failed_needs_review");
  });
  it("expires send instructions without stranding late-deposit status tracking", async () => {
    const app = setup();
    await app.commit();
    app.setTime(FIXTURE_TIME + 21 * 60_000);
    expect(app.controller.getState().canSend).toBe(false);
    app.setStatus("PENDING_DEPOSIT");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("expired_unfunded");
    app.setStatus("PROCESSING");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("processing");
  });
  it("rejects tampered persisted quotes instead of trusting saved funded evidence", async () => {
    const app = setup();
    await app.commit();
    const key = "metapoo:intents:v1:" + FIXTURE_CONTEXT.operationId;
    app.durable.setItem(key, "{bad-json");
    expect(
      (await app.controller.resume(FIXTURE_CONTEXT.operationId)).message,
    ).toContain("invalid");
  });
  it("disposes pending reads even when the caller supplied another abort signal", async () => {
    const app = setup();
    let observed: AbortSignal | undefined;
    vi.mocked(app.client.tokens).mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          observed = signal;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const pending = app.controller.loadAssets(new AbortController().signal);
    app.controller.dispose();
    await pending;
    expect(observed?.aborted).toBe(true);
  });
  it("starts a second terminal funding operation with a fresh id without overwriting the first", async () => {
    const app = setup();
    await app.commit();
    app.setStatus("SUCCESS");
    app.setEvidence({
      state: "verified_native",
      spendableBeforeGasYocto: "1000000",
      receiptId: "receipt-1",
      transactionHash: "tx-1",
    });
    await app.controller.refresh(FIXTURE_CONTEXT.operationId);
    const original = app.durable.getItem(
      "metapoo:intents:v1:" + FIXTURE_CONTEXT.operationId,
    );
    const nextContext = { ...FIXTURE_CONTEXT, operationId: "second-operation" };
    app.setContext(nextContext);
    app.controller.reset(nextContext);
    expect(app.controller.getState().operation).toBeUndefined();
    expect(
      app.durable.getItem("metapoo:intents:v1:" + FIXTURE_CONTEXT.operationId),
    ).toBe(original);
    const second = await app.commit();
    expect(second.canSend).toBe(true);
    expect(second.operation?.id).toBe("second-operation");
    expect(app.storage.load(FIXTURE_CONTEXT.operationId)?.id).toBe(
      FIXTURE_CONTEXT.operationId,
    );
    expect(app.storage.load("second-operation")?.id).toBe("second-operation");
    expect(
      app.durable.getItem("metapoo:intents:v1:" + FIXTURE_CONTEXT.operationId),
    ).toBe(original);
  });
  it("does not reset unresolved payments or reuse a terminal recovery id", async () => {
    const app = setup();
    await app.commit();
    const nextContext = { ...FIXTURE_CONTEXT, operationId: "second-operation" };
    app.setContext(nextContext);
    expect(() => app.controller.reset(nextContext)).toThrow("Keep tracking");
    expect(app.controller.getState().operation?.id).toBe(
      FIXTURE_CONTEXT.operationId,
    );
    app.setStatus("REFUNDED");
    await app.controller.refresh(FIXTURE_CONTEXT.operationId);
    app.setContext({ ...FIXTURE_CONTEXT });
    expect(() => app.controller.reset(FIXTURE_CONTEXT)).toThrow(
      "fresh recovery id",
    );
  });
  it("never resubmits provider-added platform fees as user appFees on commit", async () => {
    const app = setup();
    vi.mocked(app.client.quote).mockImplementation(async (request) => {
      const raw = fixtureQuote(request).raw;
      raw.quoteRequest = {
        ...request,
        confidentiality: "public",
        quoteWaitingTimeMs: 0,
        insured: false,
        appFees: [{ recipient: REVIEWED_PLATFORM_FEE_RECIPIENT, fee: 20 }],
      };
      return parseQuote(raw);
    });
    expect((await app.commit()).canSend).toBe(true);
    const calls = vi.mocked(app.client.quote).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].dry).toBe(false);
    expect(calls[1][0]).not.toHaveProperty("appFees");
    expect(calls[1][0]).not.toHaveProperty("confidentiality");
    expect(calls[1][0]).not.toHaveProperty("insured");
    app.setStatus("PROCESSING");
    expect(
      (await app.controller.refresh(FIXTURE_CONTEXT.operationId)).phase,
    ).toBe("processing");
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
