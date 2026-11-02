import type { OperationContext } from "../types";
import { sameIdentity } from "../types";
import { formatUnits } from "../../paint-wallet";
import { NEARLY_FALLBACK, parseDisplayAmount } from "./config";
import type { RheaExecutionPlan, RheaOperation } from "./types";

export interface RheaPanelDependencies {
  getContext(): OperationContext | null;
  prepareQuote(
    inputYocto: string,
    slippageBps: number,
    signal: AbortSignal,
  ): Promise<RheaExecutionPlan>;
  approve(plan: RheaExecutionPlan): Promise<RheaOperation>;
  resume(operationId: string): Promise<RheaOperation>;
  prepareContinuation?(
    operation: RheaOperation,
    signal: AbortSignal,
  ): Promise<RheaExecutionPlan>;
  lastOperationId?(): string | null;
  availabilityReason?: string;
  onClose?(): void;
}

/** No HTML from a route/provider is interpolated; all values use textContent. */
export function mountRheaPanel(
  host: HTMLElement,
  deps: RheaPanelDependencies,
): () => void {
  const section = document.createElement("section");
  section.className = "mp-card rhea-acquisition";
  section.setAttribute("aria-label", "Buy mPOO");
  const heading = document.createElement("h3");
  heading.textContent = "Buy mPOO";
  const note = document.createElement("p");
  note.textContent =
    deps.availabilityReason ??
    "Buy mPOO into your wallet using NEAR. You pay network gas; credits are purchased separately.";
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "NEAR to swap ";
  const amount = document.createElement("input");
  amount.name = "rhea-near-amount";
  amount.inputMode = "decimal";
  amount.autocomplete = "off";
  amount.required = true;
  label.append(amount);
  const toleranceLabel = document.createElement("label");
  toleranceLabel.textContent = "Slippage limit ";
  const slippage = document.createElement("select");
  for (const bps of [50, 100, 200]) {
    const option = document.createElement("option");
    option.value = String(bps);
    option.textContent = `${bps / 100}%`;
    option.selected = bps === 100;
    slippage.append(option);
  }
  toleranceLabel.append(slippage);
  const quoteButton = document.createElement("button");
  quoteButton.type = "submit";
  quoteButton.className = "mp-button";
  quoteButton.textContent = "Review swap";
  form.append(label, toleranceLabel, quoteButton);
  const review = document.createElement("div");
  review.hidden = true;
  review.setAttribute("aria-label", "Swap review");
  const summary = document.createElement("p");
  const approval = document.createElement("button");
  approval.type = "button";
  approval.className = "mp-button";
  approval.textContent = "Approve reviewed checkpoint";
  review.append(summary, approval);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const recovery = document.createElement("button");
  recovery.type = "button";
  recovery.textContent = "Check previous swap";
  recovery.hidden = !deps.lastOperationId?.();
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Review next checkpoint";
  next.hidden = true;
  const fallback = document.createElement("a");
  fallback.href = NEARLY_FALLBACK;
  fallback.target = "_blank";
  fallback.rel = "noopener noreferrer";
  fallback.textContent = "Buy mPOO on Nearly (mainnet)";
  section.append(heading, note, form, review, status, recovery, next, fallback);
  host.append(section);
  let disposed = false,
    busy = false,
    generation = 0;
  let read: AbortController | null = null;
  let plan: RheaExecutionPlan | null = null;
  let operation: RheaOperation | null = null;
  const setBusy = (value: boolean) => {
    busy = value;
    amount.disabled = value || !!deps.availabilityReason;
    slippage.disabled = value || !!deps.availabilityReason;
    quoteButton.disabled = value || !!deps.availabilityReason;
    approval.disabled = value || !plan;
    recovery.disabled = value;
    next.disabled = value;
    section.setAttribute("aria-busy", String(value));
  };
  const present = (op: RheaOperation) => {
    operation = op;
    status.textContent = `${op.message}${op.hashes.length ? ` Transaction references: ${op.hashes.join(", ")}` : ""}`;
    recovery.hidden = false;
    next.hidden =
      op.phase !== "next_checkpoint_review" || !deps.prepareContinuation;
  };
  const describePlan = (candidate: RheaExecutionPlan) => {
    plan = candidate;
    const q = candidate.quote;
    const tokenLabel = q.route.fixture ? "test token" : "mPOO";
    summary.textContent =
      `Swap ${formatUnits(q.inputNearYocto, 24)} NEAR. Estimated ${formatUnits(q.expectedNetMpooAtomic, q.route.decimals[q.route.mpooToken])} ${tokenLabel}; minimum ${formatUnits(q.minNetMpooAtomic, q.route.decimals[q.route.mpooToken])} ${tokenLabel} net. ` +
      `Trading tax ${q.evidence.buyBps / 100}%. Route: ${q.route.legs.map((x) => `${x.tokenIn} → ${x.tokenOut}`).join("; ")}. Pool fees: ${q.route.legs.map((x) => `${x.feeBps / 100}%`).join(", ")}. Price impact at most ${q.priceImpactBps / 100}%. ` +
      `Native spending ceiling including storage and gas: ${formatUnits(candidate.maxNativeSpendYocto, 24)} NEAR. Play reserve: ${formatUnits(candidate.reserveYocto, 24)} NEAR. ` +
      `${candidate.approvalCount} approval${candidate.approvalCount === 1 ? "" : "s"}. Cross-exchange checkpoints can partially complete, leaving intermediate assets in your wallet.`;
    review.hidden = false;
    status.textContent =
      "Review the costs and net minimum before approving. An expired quote will be rejected before signing.";
    setBusy(false);
  };
  const invalidate = () => {
    generation++;
    read?.abort();
    plan = null;
    review.hidden = true;
    setBusy(false);
  };
  amount.addEventListener("input", invalidate);
  slippage.addEventListener("change", invalidate);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || deps.availabilityReason) return;
    const context = deps.getContext();
    if (!context) {
      status.textContent = "Connect a wallet before buying mPOO.";
      return;
    }
    const turn = ++generation;
    read?.abort();
    read = new AbortController();
    plan = null;
    review.hidden = true;
    setBusy(true);
    status.textContent = "Checking route, trading tax and costs…";
    try {
      const result = await deps.prepareQuote(
        parseDisplayAmount(amount.value.trim(), 24),
        Number(slippage.value),
        read.signal,
      );
      if (disposed || turn !== generation) return;
      if (
        !sameIdentity(context, deps.getContext()) ||
        !sameIdentity(context, result.quote.context)
      )
        throw new Error("Wallet changed; review a new quote");
      describePlan(result);
    } catch (error) {
      if (!disposed && turn === generation)
        status.textContent =
          error instanceof Error ? error.message : "Swap quote unavailable";
    } finally {
      if (!disposed && turn === generation) setBusy(false);
    }
  });
  approval.addEventListener("click", async () => {
    if (busy || !plan) return;
    const selected = plan;
    if (!sameIdentity(selected.quote.context, deps.getContext())) {
      invalidate();
      status.textContent = "Wallet changed; review a new quote.";
      return;
    }
    plan = null;
    review.hidden = true;
    setBusy(true);
    status.textContent = "Waiting for your wallet approval…";
    try {
      const result = await deps.approve(selected);
      if (!disposed && sameIdentity(result.context, deps.getContext()))
        present(result);
      else if (!disposed)
        status.textContent =
          "Wallet changed. The original swap record was preserved.";
    } catch (error) {
      if (!disposed)
        status.textContent =
          error instanceof Error ? error.message : "Swap could not proceed";
    } finally {
      if (!disposed) setBusy(false);
    }
  });
  recovery.addEventListener("click", async () => {
    const id = operation?.operationId ?? deps.lastOperationId?.();
    if (busy || !id) return;
    setBusy(true);
    try {
      const result = await deps.resume(id);
      const current = deps.getContext();
      // Read-only recovery survives a new browser session epoch; it grants no signing authority.
      if (
        !disposed &&
        current?.accountId === result.context.accountId &&
        current.networkId === result.context.networkId
      )
        present(result);
    } catch (error) {
      if (!disposed)
        status.textContent =
          error instanceof Error ? error.message : "Recovery unavailable";
    } finally {
      if (!disposed) setBusy(false);
    }
  });
  next.addEventListener("click", async () => {
    if (busy || !operation || !deps.prepareContinuation) return;
    read?.abort();
    read = new AbortController();
    setBusy(true);
    try {
      const result = await deps.prepareContinuation(operation, read.signal);
      if (!disposed && sameIdentity(result.quote.context, deps.getContext()))
        describePlan(result);
    } catch (error) {
      if (!disposed)
        status.textContent =
          error instanceof Error ? error.message : "Next quote unavailable";
    } finally {
      if (!disposed) setBusy(false);
    }
  });
  setBusy(false);
  return () => {
    disposed = true;
    generation++;
    read?.abort();
    section.remove();
  };
}
