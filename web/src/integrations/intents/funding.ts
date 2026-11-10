import { sameIdentity } from "../types";
import type { OperationContext } from "../types";
import { withCapitalLock } from "../operation-store";
import { IntentsApiError } from "./client";
import {
  assertQuoteMatches,
  canonicalQuoteRequest,
  expiresAt,
  integer,
  makeQuoteRequest,
  parseTokenAmount,
  providerFeeBps,
} from "./quote";
import type { IntentsStorage } from "./storage";
import type {
  FundingClient,
  FundingEvidence,
  FundingOperation,
  FundingPolicy,
  FundingPreviewInput,
  FundingQuote,
  FundingReadiness,
  FundingSnapshot,
  FundingStatus,
  IntentsToken,
} from "./types";

export interface IntentsFundingDependencies {
  client: FundingClient;
  storage: IntentsStorage;
  currentContext(): OperationContext | null;
  readReadiness(context: OperationContext): Promise<FundingReadiness>;
  policy: FundingPolicy;
  reconcileDestination(
    operation: FundingOperation,
    status: FundingStatus,
  ): Promise<FundingEvidence>;
  onBalancesChanged?(context: OperationContext): void;
  now?: () => number;
  /** Disable only for deterministic tests; no live settlement is simulated. */
  poll?: boolean;
}

export function createIntentsFundingController(
  deps: IntentsFundingDependencies,
) {
  const now = deps.now ?? Date.now;
  let state: FundingSnapshot = {
    phase: deps.policy.enabled ? "editing" : "disabled",
    message: deps.policy.enabled
      ? "Choose an asset to add funds"
      : "Cross-chain funding is not enabled. You can receive native NEAR directly.",
    assets: [],
    canSend: false,
  };
  let assetsAt = 0;
  let previewContext: OperationContext | null = null;
  let previewToken: IntentsToken | null = null;
  let previewId = "";
  let approvedToSend = "";
  /** Last capability-gate refusal, so a resumed payment can say why its address is withheld. */
  let gateReason = "";
  let revision = 0;
  let disposed = false;
  let committing = false;
  let refreshing: Promise<FundingSnapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollAttempt = 0;
  let retryAfter = 0;
  const abort = new AbortController();
  const requestSignal = (external?: AbortSignal) =>
    external ? AbortSignal.any([external, abort.signal]) : abort.signal;
  const listeners = new Set<(state: FundingSnapshot) => void>();
  const clone = <T>(value: T): T => structuredClone(value);
  const matches = (ctx: OperationContext) =>
    sameIdentity(ctx, deps.currentContext());
  const active = (ctx: OperationContext) => {
    if (disposed || !matches(ctx))
      throw new Error(
        "Account changed. Start a new review for the selected account.",
      );
    if (!deps.policy.enabled || ctx.networkId !== "mainnet")
      throw new Error(
        "Cross-chain funding is available only on an enabled mainnet page",
      );
  };
  function getState(): FundingSnapshot {
    const result = clone(state);
    const op = result.operation;
    result.canSend =
      !!op &&
      state.phase === "awaiting_deposit" &&
      approvedToSend === op.id &&
      !disposed &&
      deps.policy.enabled &&
      matches(op.context) &&
      op.phase === "awaiting_deposit" &&
      now() + (deps.policy.sendSafetyMarginMs ?? 60_000) < expiresAt(op.quote);
    if (op && !matches(op.context)) {
      result.canSend = false;
      result.message = `This payment is for ${op.context.accountId}. Tracking stays available; select that account to see payment instructions.`;
    }
    if (op && !result.canSend) result.sendBlockedReason = blockedReason(op);
    return result;
  }
  /**
   * Say which gate is closed. Without this the panel can only print one catch-all sentence and
   * a player stuck on an expired quote has no way to tell expiry from a failed capability check.
   */
  function blockedReason(op: FundingOperation): string | undefined {
    if (!matches(op.context))
      return `This payment is for ${op.context.accountId}; select that account to see its payment address.`;
    if (!deps.policy.enabled)
      return "Cross-chain funding is disabled on this page. Receive native NEAR directly instead.";
    if (op.phase === "expired_unfunded")
      return "This quote expired before any payment arrived, so its address must not be reused. Start a new payment to get a fresh address.";
    if (now() + (deps.policy.sendSafetyMarginMs ?? 60_000) >= expiresAt(op.quote))
      return "This quote has expired, so its address must not be reused. Start a new payment to get a fresh address.";
    if (state.phase !== "awaiting_deposit")
      return state.message;
    if (approvedToSend !== op.id)
      return gateReason
        ? `Sending stays paused: ${gateReason}`
        : "Account capability checks have not passed yet, so the payment address stays hidden. Tracking continues in the background.";
    return undefined;
  }
  function emit(update: Partial<FundingSnapshot>): FundingSnapshot {
    if (disposed) return getState();
    state = { ...state, ...update, canSend: false };
    const snapshot = getState();
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }
  function fail(error: unknown): FundingSnapshot {
    return emit({
      phase: "unavailable",
      message:
        error instanceof Error
          ? error.message
          : "Funding unavailable. Keep your payment details.",
    });
  }
  function save(operation: FundingOperation) {
    operation.updatedAtMs = now();
    deps.storage.save(operation);
  }
  async function prerequisites(ctx: OperationContext) {
    active(ctx);
    if (!deps.policy.transportVerified)
      throw new Error(
        "Cross-chain funding transport has not passed browser checks. Receive native NEAR directly for now.",
      );
    const readiness = await deps.readReadiness(ctx);
    active(ctx);
    const proof = deps.policy.nativeDeliveryEvidence;
    const implicit = /^[0-9a-f]{64}$/.test(ctx.accountId);
    if (deps.policy.deliveryMode !== "native") {
      throw new Error(
        "Wrapped NEAR delivery needs a separately verified unwrap flow. Receive native NEAR directly for now.",
      );
    }
    const proven =
      !!proof.reference &&
      (readiness.state === "absent"
        ? implicit &&
          readiness.expectedKeyMatches === true &&
          proof.uninitializedImplicit
        : readiness.state === "ready" &&
          (implicit
            ? proof.initializedImplicit && readiness.expectedKeyMatches === true
            : proof.initializedNamed));
    if (!proven) {
      // Test mode lets the owner exercise the route before the evidence exists. It does not
      // claim the route is proven: the panel says exactly what is unverified on every screen.
      if (!deps.policy.unverifiedTestDelivery)
        throw new Error(
          "Native NEAR delivery to this account type has not been verified. Receive native NEAR directly for now.",
        );
    }
  }
  async function loadAssets(signal?: AbortSignal): Promise<FundingSnapshot> {
    const ctx = deps.currentContext();
    if (!ctx) return fail(new Error("Connect a wallet before adding funds"));
    const seq = ++revision;
    try {
      active(ctx);
      emit({ phase: "loading_assets", message: "Checking supported assets…" });
      const tokens = await deps.client.tokens(requestSignal(signal));
      active(ctx);
      if (seq !== revision) return getState();
      const assets = tokens.filter(
        (t) =>
          deps.policy.sourceAllowlist.some(
            (a) => a.assetId === t.assetId && a.blockchain === t.blockchain,
          ) && t.assetId !== "nep141:mpoo.nearlytrade.near",
      );
      assetsAt = now();
      return emit({
        assets,
        phase: "editing",
        message: assets.length
          ? "Choose your source asset and refund address"
          : "No reviewed source routes are available. Receive NEAR directly for now.",
      });
    } catch (error) {
      return seq === revision ? fail(error) : getState();
    }
  }
  async function preview(
    input: FundingPreviewInput,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<FundingSnapshot> {
    let seq = ++revision;
    previewId = "";
    try {
      active(ctx);
      if (!input.refundAddressConfirmed)
        throw new Error("Confirm that you control the refund address");
      if (!assetsAt || now() - assetsAt > 60_000) {
        // A player filling the form for over a minute is normal. Re-read the registry for them
        // rather than refusing and asking them to find a refresh button.
        await loadAssets(signal);
        if (!assetsAt || now() - assetsAt > 60_000) return getState();
        seq = ++revision;
        active(ctx);
      }
      const token = state.assets.find((t) => t.assetId === input.assetId);
      if (!token) throw new Error("Select a supported source asset");
      const request = makeQuoteRequest(
        token,
        parseTokenAmount(input.amount, token.decimals),
        ctx.accountId,
        input.refundAddress,
        now(),
        deps.policy.quoteLifetimeMs,
      );
      emit({
        phase: "previewing",
        preview: undefined,
        message: "Getting a conversion quote…",
      });
      const quote = await deps.client.quote(request, requestSignal(signal));
      active(ctx);
      if (seq !== revision) return getState();
      assertQuoteMatches(quote, request);
      if (!(await deps.client.verify(quote)))
        throw new Error("Could not verify the quote");
      active(ctx);
      if (seq !== revision) return getState();
      previewContext = clone(ctx);
      previewToken = clone(token);
      previewId = quote.correlationId;
      return emit({
        phase: "review",
        preview: quote,
        operation: undefined,
        message:
          "Review the amount and minimum received before getting a payment address",
      });
    } catch (error) {
      return seq === revision ? fail(error) : getState();
    }
  }
  async function commit(
    id: string,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<FundingSnapshot> {
    if (committing) return getState();
    committing = true;
    try {
      return await withCapitalLock(deps.storage.durable, async () => {
        active(ctx);
        if (
          !state.preview ||
          !previewToken ||
          !previewContext ||
          !matches(previewContext) ||
          id !== previewId ||
          ctx.operationId !== previewContext.operationId
        )
          throw new Error("Review a fresh quote first");
        const existing = deps.storage.load(ctx.operationId);
        if (existing)
          throw new Error(
            "This payment already exists. Resume its status instead of creating another address.",
          );
        const preview = clone(state.preview),
          token = clone(previewToken);
        if (
          now() + (deps.policy.sendSafetyMarginMs ?? 60_000) >=
          expiresAt(preview)
        )
          throw new Error("Quote expired. Request a fresh quote.");
        await prerequisites(ctx);
        const request = canonicalQuoteRequest(preview.quoteRequest, false);
        emit({
          phase: "committing",
          message: "Creating your payment instructions…",
        });
        const quote = await deps.client.quote(request, requestSignal(signal));
        active(ctx);
        assertQuoteMatches(quote, request);
        if (!(await deps.client.verify(quote)))
          throw new Error("Could not verify the payment address");
        active(ctx);
        if (
          BigInt(quote.quote.minAmountOut) <
            BigInt(preview.quote.minAmountOut) ||
          quote.quote.amountIn !== preview.quote.amountIn
        )
          throw new Error(
            "Conversion changed. Request a new quote and review the new amounts.",
          );
        if (providerFeeBps(quote) !== providerFeeBps(preview))
          throw new Error(
            "Provider fee changed. Request a new quote and review the new costs.",
          );
        if (
          now() + (deps.policy.sendSafetyMarginMs ?? 60_000) >=
          expiresAt(quote)
        )
          throw new Error(
            "Payment instructions expired before they were ready",
          );
        const operation: FundingOperation = {
          version: 1,
          id: ctx.operationId,
          context: clone(ctx),
          token,
          quote,
          createdAtMs: now(),
          updatedAtMs: now(),
          phase: "awaiting_deposit",
        };
        save(operation);
        approvedToSend = operation.id;
        gateReason = "";
        previewId = "";
        const result = emit({
          operation,
          preview: undefined,
          phase: operation.phase,
          message:
            "Send the exact amount on the selected source network. Keep its transaction details.",
        });
        schedule(operation.id);
        return result;
      });
    } catch (error) {
      return fail(error);
    } finally {
      committing = false;
    }
  }
  async function resume(
    operationId: string,
    context?: OperationContext,
    signal?: AbortSignal,
  ): Promise<FundingSnapshot> {
    ++revision;
    approvedToSend = "";
    try {
      const operation = deps.storage.load(operationId);
      if (!operation)
        throw new Error("No saved payment found for that recovery id");
      if (!(await deps.client.verify(operation.quote)))
        throw new Error(
          "Saved payment signature is invalid. Keep your source transaction details.",
        );
      if (disposed) return getState();
      assertQuoteMatches(operation.quote, operation.quote.quoteRequest);
      // Rebind only the session epoch, never the historical recipient/network.
      if (
        context &&
        context.accountId === operation.context.accountId &&
        context.networkId === operation.context.networkId &&
        context.operationId === operation.id &&
        matches(context)
      ) {
        try {
          await prerequisites(context);
          operation.context = clone(context);
          save(operation);
          approvedToSend = operation.id;
          gateReason = "";
        } catch (error) {
          // Read-only recovery is correct, but silence is not: keep the reason for the panel.
          gateReason =
            error instanceof Error
              ? error.message
              : "Account capability checks have not passed yet.";
        }
      }
      emit({
        operation,
        preview: undefined,
        phase: operation.phase,
        message:
          "Resuming the original payment; no new address or transaction will be created",
      });
      const result = await refresh(operationId, signal);
      schedule(operationId);
      return result;
    } catch (error) {
      return fail(error);
    }
  }
  async function refresh(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<FundingSnapshot> {
    if (refreshing) return refreshing;
    const viewRevision = revision;
    const run = async () => {
      try {
        const operation = deps.storage.load(operationId);
        if (!operation) throw new Error("Saved payment is unavailable");
        if (!(await deps.client.verify(operation.quote)))
          throw new Error("Saved quote could not be verified");
        const status = await deps.client.status(
          operation.quote,
          requestSignal(signal),
        );
        if (disposed) return getState();
        const echoed = status.quoteResponse;
        assertQuoteMatches(echoed, operation.quote.quoteRequest);
        // `/v0/status` omits correlationId (it is outside the vendor's signed payload), so
        // bind identity to the deposit address, memo and minimum output that were approved.
        if (
          (echoed.correlationId !== undefined &&
            echoed.correlationId !== operation.quote.correlationId) ||
          echoed.quote.depositAddress !==
            operation.quote.quote.depositAddress ||
          echoed.quote.depositMemo !== operation.quote.quote.depositMemo ||
          echoed.quote.minAmountOut !== operation.quote.quote.minAmountOut
        )
          throw new Error("Status does not match the saved payment");
        operation.status = status;
        const map = {
          PENDING_DEPOSIT: "awaiting_deposit",
          KNOWN_DEPOSIT_TX: "deposit_detected",
          PROCESSING: "processing",
          INCOMPLETE_DEPOSIT: "incomplete_deposit",
          SUCCESS: "settled_verifying",
          REFUNDED: "refunded",
          FAILED: "failed_needs_review",
          UNKNOWN: "failed_needs_review",
        } as const;
        operation.phase = map[status.status];
        let message = {
          PENDING_DEPOSIT: "Waiting for your source payment",
          KNOWN_DEPOSIT_TX: "Source payment detected; waiting for conversion",
          PROCESSING: "Conversion is processing",
          INCOMPLETE_DEPOSIT:
            "Deposit is incomplete. Keep tracking for the refund; do not send again automatically.",
          SUCCESS: "Conversion complete; checking native NEAR delivery",
          REFUNDED:
            "Provider reports a refund. Check your source refund address.",
          FAILED: "Payment needs review. Failure does not confirm a refund.",
          UNKNOWN:
            "Unrecognized provider status. Keep your details and contact support; do not send again.",
        }[status.status];
        if (
          status.status === "PENDING_DEPOSIT" &&
          now() + (deps.policy.sendSafetyMarginMs ?? 60_000) >=
            expiresAt(operation.quote)
        ) {
          operation.phase = "expired_unfunded";
          message =
            "Payment instructions expired. Keep tracking if you already sent funds; do not reuse the address.";
        }
        if (status.status === "SUCCESS") {
          operation.evidence = await deps.reconcileDestination(
            operation,
            status,
          );
          if (disposed) return getState();
          if (operation.evidence.state === "verified_native") {
            const spendable = operation.evidence.spendableBeforeGasYocto;
            if (
              spendable &&
              BigInt(integer(spendable)) >=
                BigInt(integer(deps.policy.playReserveYocto))
            ) {
              operation.phase = "funded";
              message =
                "Native NEAR delivery verified. Choose Buy credits or Buy mPOO when ready.";
              if (matches(operation.context))
                deps.onBalancesChanged?.(operation.context);
            } else
              message =
                "Native NEAR arrived, but the remaining balance is below the play-gas reserve. Add more NEAR before spending.";
          } else if (operation.evidence.state === "verified_wrapped") {
            operation.phase = "needs_unwrap";
            message =
              "Wrapped NEAR arrived. It is not native gas; a separately approved unwrap is required.";
          } else if (operation.evidence.message)
            message = operation.evidence.message;
        }
        save(operation);
        pollAttempt = 0;
        retryAfter = 0;
        if (
          viewRevision !== revision ||
          (state.operation && state.operation.id !== operation.id)
        )
          return getState();
        return emit({
          operation,
          preview: undefined,
          phase: operation.phase,
          message,
        });
      } catch (error) {
        if (error instanceof IntentsApiError)
          retryAfter = error.retryAfterMs ?? 0;
        ++pollAttempt;
        return fail(error);
      }
    };
    refreshing = run();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }
  function schedule(id: string) {
    if (timer) clearTimeout(timer);
    if (
      disposed ||
      deps.poll === false ||
      ["funded", "refunded"].includes(state.phase)
    )
      return;
    const delay = Math.max(
      retryAfter,
      Math.min(30_000, 3000 * 2 ** Math.min(pollAttempt, 4)) +
        Math.floor(Math.random() * 500),
    );
    timer = setTimeout(async () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState !== "hidden"
      )
        await refresh(id);
      schedule(id);
    }, delay);
  }
  const onVisible = () => {
    if (state.operation && document.visibilityState === "visible")
      void refresh(state.operation.id);
  };
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisible);
  return {
    getState,
    loadAssets,
    preview,
    commit,
    resume,
    refresh,
    subscribe(listener: (state: FundingSnapshot) => void) {
      listeners.add(listener);
      listener(getState());
      return () => listeners.delete(listener);
    },
    invalidatePreview() {
      ++revision;
      previewId = "";
      previewContext = null;
      previewToken = null;
      return emit({
        preview: undefined,
        phase: state.operation
          ? state.phase
          : deps.policy.enabled
            ? "editing"
            : "disabled",
      });
    },
    reset(context: OperationContext) {
      active(context);
      // A quote that expired with no payment received holds nothing to track, and blocking a new
      // payment left players stuck on a dead address. Money-in-flight phases stay gated.
      if (
        state.operation &&
        !["funded", "refunded", "expired_unfunded"].includes(
          state.operation.phase,
        )
      ) {
        throw new Error(
          "Keep tracking the original payment before starting another funding operation",
        );
      }
      if (state.operation?.id === context.operationId)
        throw new Error("A new payment needs a fresh recovery id");
      ++revision;
      approvedToSend = "";
      gateReason = "";
      previewId = "";
      previewContext = null;
      previewToken = null;
      if (timer) clearTimeout(timer);
      pollAttempt = 0;
      const previous = state.operation?.id;
      return emit({
        operation: undefined,
        preview: undefined,
        phase: "editing",
        message: previous
          ? `Start a new payment. Record ${previous} is retained — track it if you already sent funds to its address.`
          : "Start a new payment.",
      });
    },
    dispose() {
      disposed = true;
      ++revision;
      abort.abort();
      if (timer) clearTimeout(timer);
      listeners.clear();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

export type IntentsFundingController = ReturnType<
  typeof createIntentsFundingController
>;
