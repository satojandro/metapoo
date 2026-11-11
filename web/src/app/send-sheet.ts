import { getAcquisitionContext, hasPendingAcquisition, reconcilePendingAcquisition } from "../wallet";
import { SEND_POLICY } from "../integrations/send/config";
import { planSend, submitSend, type SendPlan } from "../integrations/send/controller";
import { formatUnits, walletAmount } from "../paint-wallet";
import "./send-sheet.css";

/** Four decimals, cut never rounded — the same reading as the wallet panel. */
export function balanceText(plan: SendPlan): string {
  return `${plan.symbol} · ${walletAmount(formatUnits(plan.maximum, plan.decimals))} available`;
}

/**
 * The total the player is agreeing to. Registration is priced in NEAR, so it can only be
 * added to the amount when the amount is NEAR too; a token send says the fee is separate
 * in words rather than inventing a cross-asset sum.
 */
export function totalText(plan: SendPlan): string {
  if (plan.symbol === "NEAR") {
    return `${formatUnits((BigInt(plan.amount) + BigInt(plan.registration)).toString(), plan.decimals)} NEAR`;
  }
  // A token amount and a NEAR setup fee cannot be summed, so the total names both instead of
  // dropping the setup row that sits directly above it (review of PR #111, item 5).
  const setup = plan.registration !== "0" ? `${formatUnits(plan.registration, 24)} NEAR setup, ` : "";
  return `${formatUnits(plan.amount, plan.decimals)} ${plan.symbol} + ${setup}plus a small network fee`;
}

function reviewRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

/**
 * A send that reads like a payment: the asset row carries the balance, Max sits inside
 * the amount field, and the review is one labelled line per fact instead of a sentence
 * that runs amount, recipient, fee ceiling and registration together.
 *
 * Form values remain in the document across rejection. No automatic retry can spend funds.
 * The Close button is part of the panel's own header; `onClose` lets the dialog that hosts
 * it unmount this sheet (the sheet clears itself when mounted bare).
 */
export function mountSendSheet(root: HTMLElement, refresh: () => void, onClose?: () => void): () => void {
  root.innerHTML = `<form class="mp-send"><div class="mp-send-header"><h2>Send</h2><button type="button" class="action secondary mp-send-close" data-close>Close</button></div><label class="mp-send-field"><span class="mp-send-label">Asset</span><span class="mp-send-asset"><select name="asset"><option value="NEAR">NEAR</option></select><span class="mp-send-balance" data-balance></span></span></label><label class="mp-send-field"><span class="mp-send-label">To</span><input name="recipient" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="alice.near"></label><label class="mp-send-field"><span class="mp-send-label">Amount</span><span class="mp-send-amount"><input name="amount" inputmode="decimal" autocomplete="off"><button type="button" class="mp-send-max" data-max>Max</button></span></label><p class="mp-send-note">Keeps 0.01 NEAR for future network fees.</p><button type="submit" class="mp-btn mp-btn-primary mp-send-submit">Review</button><div data-review></div><p class="mp-send-status" role="status"></p><button type="button" class="mp-send-reconcile" data-reconcile hidden>Check pending transfer</button></form>`;
  const form = root.querySelector("form")!, asset = form.elements.namedItem("asset") as HTMLSelectElement, recipient = form.elements.namedItem("recipient") as HTMLInputElement, amount = form.elements.namedItem("amount") as HTMLInputElement;
  const status = root.querySelector<HTMLElement>('[role="status"]')!, review = root.querySelector<HTMLElement>("[data-review]")!, balance = root.querySelector<HTMLElement>("[data-balance]")!, pending = root.querySelector<HTMLButtonElement>("[data-reconcile]")!;
  for (const token of SEND_POLICY.tokens) { const option = document.createElement("option"); option.value = token.contractId; option.textContent = token.symbol; asset.append(option); }
  let disposed = false, busy = false, revision = 0;
  const invalidate = () => { revision++; review.replaceChildren(); };
  // "Unavailable" is for a read that was tried and failed, not for the moment before a
  // recipient exists; the slot stays empty until a plan reads a balance.
  const clearBalance = () => { balance.textContent = ""; };
  /**
   * The reconcile control is shown whenever the account has an unresolved acquisition, which is
   * a fact about storage rather than about this mounted sheet: closing the dialog used to hide
   * the only control that clears the marker (review of PR #111, item 1).
   */
  /** An outcome this sheet itself saw cannot be un-seen by a storage probe. */
  let sawUnknown = false;
  const syncPending = () => {
    const context = getAcquisitionContext("send-reconcile");
    pending.hidden = !(sawUnknown || (context && hasPendingAcquisition(context)));
  };
  form.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => { if (onClose) onClose(); else root.replaceChildren(); };
  form.addEventListener("input", invalidate);
  // A balance belongs to one asset. Switching assets drops the old reading rather than
  // showing one token's balance beside another token's symbol.
  asset.addEventListener("change", clearBalance);
  const run = async (task: () => Promise<void>) => {
    if (busy || disposed) return; busy = true;
    // Close stays available: closing mid-read was allowed before this PR (review item 6).
    form.querySelectorAll<HTMLButtonElement>("button:not([data-close])").forEach(b => { b.disabled = true; });
    try { await task(); } catch (error) {
      if (!disposed) {
        const message = error instanceof Error ? error.message : "Unavailable — retry.";
        status.textContent = message;
        // The reconcile guard is the other honest trigger for showing the control.
        if (/Reconcile the previous payment/i.test(message)) syncPending();
      }
    }
    finally {
      busy = false;
      if (!disposed) { form.querySelectorAll<HTMLButtonElement>("button:not([data-close])").forEach(b => { b.disabled = false; }); syncPending(); }
    }
  };
  const prepare = async (max: boolean) => {
    const context = getAcquisitionContext(crypto.randomUUID()); if (!context) throw new Error("Connect your wallet first.");
    const version = revision;
    const plan = await planSend(context, asset.value, recipient.value, max ? "MAX" : amount.value);
    if (disposed || revision !== version) throw new Error("Form changed. Review again.");
    return plan;
  };
  const showBalance = (plan: SendPlan) => { balance.textContent = balanceText(plan); };
  root.querySelector<HTMLButtonElement>("[data-max]")!.onclick = () => void run(async () => { const p = await prepare(true); showBalance(p); amount.value = formatUnits(p.maximum, p.decimals); invalidate(); });
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    status.textContent = "Checking balances and recipient…";
    const plan: SendPlan = await prepare(false), version = revision;
    showBalance(plan);
    review.replaceChildren();
    const lines = document.createElement("dl");
    lines.className = "mp-send-lines";
    lines.append(reviewRow("You send", `${formatUnits(plan.amount, plan.decimals)} ${plan.symbol}`));
    lines.append(reviewRow("To", plan.recipient));
    lines.append(reviewRow("Network fee, at most", `${formatUnits(plan.gas, 24)} NEAR`));
    if (BigInt(plan.registration) > 0n) lines.append(reviewRow("Recipient setup", `${formatUnits(plan.registration, 24)} NEAR`));
    lines.append(reviewRow("Total", totalText(plan)));
    const send = document.createElement("button"); send.type = "button"; send.className = "mp-btn mp-btn-primary"; send.textContent = `Send ${formatUnits(plan.amount, plan.decimals)} ${plan.symbol}`;
    send.onclick = () => void run(async () => {
      if (revision !== version) throw new Error("Form changed. Review again.");
      // Rebuild from fresh reads; a changed registration or fee ceiling needs a new review.
      const fresh = await planSend(plan.request.context, asset.value, recipient.value, amount.value);
      if (disposed || revision !== version) return;
      if (JSON.stringify(fresh.request.transactions) !== JSON.stringify(plan.request.transactions) || BigInt(fresh.request.approval.maxNativeSpendYocto) > BigInt(plan.request.approval.maxNativeSpendYocto)) throw new Error("Balance or fees changed. Review again.");
      review.replaceChildren();
      const result = await submitSend(plan); if (disposed) return;
      // The one case its message describes: a broadcast we cannot confirm. A confirmed,
      // cancelled or failed transfer leaves nothing to reconcile, so the button stays hidden.
      pending.hidden = result?.status !== "unknown";
      if (result?.status === "unknown") sawUnknown = true;
      status.textContent = result?.status === "confirmed" ? "Sent. The transfer is confirmed." : result?.status === "not_submitted" ? "Cancelled. Nothing was sent." : result?.status === "failed" ? "The transfer failed. Only the network fee was spent." : "We can't confirm this transfer yet. Check pending transfer before trying again.";
      if (result?.transactionHash) { const link = document.createElement("a"); link.href = `https://${plan.request.context.networkId === "testnet" ? "testnet." : ""}nearblocks.io/txns/${encodeURIComponent(result.transactionHash)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "View transaction"; status.append(" ", link); }
      refresh();
    });
    review.append(lines, send); status.textContent = "Transfers can't be undone. Double-check the recipient.";
  }); };
  pending.onclick = () => void run(async () => {
    const context = getAcquisitionContext("send-recovery"); if (!context) throw new Error("Connect the original account first.");
    const cleared = await reconcilePendingAcquisition(context);
    if (cleared) sawUnknown = false;
    status.textContent = cleared ? "No unresolved broadcast remains. Refresh balances before a new send." : "Still unresolved. Do not resend; check your account's transaction history.";
    refresh();
  });
  syncPending();
  return () => { disposed = true; revision++; root.replaceChildren(); };
}
