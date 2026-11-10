import { getAcquisitionContext, reconcilePendingAcquisition } from "../wallet";
import { SEND_POLICY } from "../integrations/send/config";
import { planSend, submitSend, type SendPlan } from "../integrations/send/controller";
import { formatUnits } from "../paint-wallet";
import "./send-sheet.css";
/** Form values remain in the document across rejection. No automatic retry can spend funds. */
export function mountSendSheet(root: HTMLElement, refresh: () => void): () => void {
  root.innerHTML = `<form class="mp-send"><h2>Send</h2><label>Asset<select name="asset"><option value="NEAR">NEAR</option></select></label><label>To<input name="recipient" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="alice.near"></label><label>Amount<input name="amount" inputmode="decimal" autocomplete="off"></label><button type="button" data-max>Max</button><p>Keeps 0.01 NEAR for future network fees.</p><button type="submit">Review</button><div data-review></div><p role="status"></p><button type="button" data-reconcile>Check pending transfer</button></form>`;
  const form = root.querySelector("form")!, asset = form.elements.namedItem("asset") as HTMLSelectElement, recipient = form.elements.namedItem("recipient") as HTMLInputElement, amount = form.elements.namedItem("amount") as HTMLInputElement;
  const status = root.querySelector<HTMLElement>('[role="status"]')!, review = root.querySelector<HTMLElement>("[data-review]")!;
  for (const token of SEND_POLICY.tokens) { const option = document.createElement("option"); option.value = token.contractId; option.textContent = token.symbol; asset.append(option); }
  let disposed = false, busy = false, revision = 0;
  const invalidate = () => { revision++; review.replaceChildren(); };
  form.addEventListener("input", invalidate);
  const run = async (task: () => Promise<void>) => {
    if (busy || disposed) return; busy = true;
    form.querySelectorAll("button").forEach(b => b.disabled = true);
    try { await task(); } catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : "Unavailable — retry."; }
    finally { busy = false; if (!disposed) form.querySelectorAll("button").forEach(b => b.disabled = false); }
  };
  const prepare = async (max: boolean) => {
    const context = getAcquisitionContext(crypto.randomUUID()); if (!context) throw new Error("Connect your wallet first.");
    const version = revision;
    const plan = await planSend(context, asset.value, recipient.value, max ? "MAX" : amount.value);
    if (disposed || revision !== version) throw new Error("Form changed. Review again.");
    return plan;
  };
  root.querySelector<HTMLButtonElement>("[data-max]")!.onclick = () => void run(async () => { const p = await prepare(true); amount.value = formatUnits(p.maximum, p.decimals); invalidate(); });
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    status.textContent = "Checking balances and recipient…";
    const plan: SendPlan = await prepare(false), version = revision;
    review.replaceChildren();
    const summary = document.createElement("p"); summary.textContent = `Send ${formatUnits(plan.amount, plan.decimals)} ${plan.symbol} to ${plan.recipient}. Network fee ceiling: ${formatUnits(plan.gas, 24)} NEAR. Recipient registration: ${formatUnits(plan.registration, 24)} NEAR.`;
    const send = document.createElement("button"); send.type = "button"; send.textContent = `Send ${formatUnits(plan.amount, plan.decimals)} ${plan.symbol}`;
    send.onclick = () => void run(async () => {
      if (revision !== version) throw new Error("Form changed. Review again.");
      // Rebuild from fresh reads; a changed registration or fee ceiling needs a new review.
      const fresh = await planSend(plan.request.context, asset.value, recipient.value, amount.value);
      if (disposed || revision !== version) return;
      if (JSON.stringify(fresh.request.transactions) !== JSON.stringify(plan.request.transactions) || BigInt(fresh.request.approval.maxNativeSpendYocto) > BigInt(plan.request.approval.maxNativeSpendYocto)) throw new Error("Balance or fees changed. Review again.");
      review.replaceChildren();
      const result = await submitSend(plan); if (disposed) return;
      status.textContent = result?.status === "confirmed" ? "Sent. The transfer is confirmed." : result?.status === "not_submitted" ? "Cancelled. Nothing was sent." : result?.status === "failed" ? "The transfer failed. Only the network fee was spent." : "We can't confirm this transfer yet. Check pending transfer before trying again.";
      if (result?.transactionHash) { const link = document.createElement("a"); link.href = `https://${plan.request.context.networkId === "testnet" ? "testnet." : ""}nearblocks.io/txns/${encodeURIComponent(result.transactionHash)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "View transaction"; status.append(" ", link); }
      refresh();
    });
    review.append(summary, send); status.textContent = "Transfers can't be undone. Double-check the recipient.";
  }); };
  root.querySelector<HTMLButtonElement>("[data-reconcile]")!.onclick = () => void run(async () => {
    const context = getAcquisitionContext("send-recovery"); if (!context) throw new Error("Connect the original account first.");
    status.textContent = await reconcilePendingAcquisition(context) ? "No unresolved broadcast remains. Refresh balances before a new send." : "Still unresolved. Do not resend; check your account's transaction history."; refresh();
  });
  return () => { disposed = true; revision++; root.replaceChildren(); };
}
