import QRCode from "qrcode";
import type { OperationContext } from "../types";
import type { IntentsFundingController } from "./funding";
import { expiresAt, formatTokenAmount, providerFeeBps } from "./quote";
import type { FundingSnapshot } from "./types";
import "./panel.css";

export interface IntentsPanelOptions {
  getContext(): OperationContext | null;
  /** Called only after the player chooses a new payment, never for status checks. */
  newContext?(): OperationContext | null;
  initialOperationId?: string;
  renderQr?: (address: string) => Promise<string>;
}

/** Inline wallet panel: no overlay and no changes to the drawing/session state. */
export function mountIntentsFundingPanel(
  host: HTMLElement,
  controller: IntentsFundingController,
  options: IntentsPanelOptions,
): () => void {
  const section = document.createElement("section");
  section.className = "mp-intents-panel";
  section.setAttribute("aria-label", "Add funds from another network");
  const title = document.createElement("h3");
  title.textContent = "Add funds";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const form = document.createElement("form");
  const label = (name: string, control: HTMLElement) => {
    const element = document.createElement("label");
    element.append(document.createTextNode(name), control);
    return element;
  };
  const assets = document.createElement("select");
  assets.required = true;
  const amount = document.createElement("input");
  amount.inputMode = "decimal";
  amount.required = true;
  amount.autocomplete = "off";
  const refund = document.createElement("input");
  refund.required = true;
  refund.autocomplete = "off";
  refund.spellcheck = false;
  const ownership = document.createElement("input");
  ownership.type = "checkbox";
  ownership.required = true;
  const refreshAssets = document.createElement("button");
  refreshAssets.type = "button";
  refreshAssets.textContent = "Refresh supported assets";
  const preview = document.createElement("button");
  preview.type = "submit";
  preview.textContent = "Get a quote";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = "Get payment address";
  confirm.hidden = true;
  form.append(
    label("Asset and source network", assets),
    label("Amount to send", amount),
    label("Refund address on the source network", refund),
    label("I control this refund address", ownership),
    refreshAssets,
    preview,
    confirm,
  );
  const review = document.createElement("div");
  const instructions = document.createElement("div");
  const recovery = document.createElement("form");
  const recoveryId = document.createElement("input");
  recoveryId.autocomplete = "off";
  recoveryId.required = true;
  const resume = document.createElement("button");
  resume.type = "submit";
  resume.textContent = "Track saved payment";
  recovery.append(label("Payment recovery ID", recoveryId), resume);
  const check = document.createElement("button");
  check.type = "button";
  check.textContent = "Check payment status";
  check.hidden = true;
  const startNew = document.createElement("button");
  startNew.type = "button";
  startNew.textContent = "Start another funding payment";
  startNew.hidden = true;
  const warning = document.createElement("p");
  warning.textContent =
    "Pay from your external wallet on the exact source network. You pay that network's fee. Funding does not buy credits or mPOO automatically.";
  section.append(
    title,
    status,
    form,
    review,
    instructions,
    check,
    startNew,
    warning,
    recovery,
  );
  host.append(section);
  let disposed = false;
  let qrRevision = 0;
  let reviewContext: OperationContext | null = null;
  let lastAssets = "";
  let renderedInstructionsKey = "";
  const getContext = () => options.getContext();
  const renderQr =
    options.renderQr ??
    ((address) =>
      QRCode.toDataURL(address, {
        width: 200,
        margin: 2,
        errorCorrectionLevel: "M",
      }));
  const paragraph = (text: string) => {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  };
  function details(snapshot: FundingSnapshot) {
    renderedInstructionsKey = `${snapshot.operation?.id ?? ""}:${snapshot.canSend}:${snapshot.message}`;
    const epoch = ++qrRevision;
    status.textContent = snapshot.message;
    const registry = JSON.stringify(snapshot.assets);
    if (registry !== lastAssets) {
      lastAssets = registry;
      const previous = assets.value;
      assets.replaceChildren();
      for (const token of snapshot.assets) {
        const option = document.createElement("option");
        option.value = token.assetId;
        option.textContent = `${token.symbol} · ${token.blockchain}`;
        assets.append(option);
      }
      if (snapshot.assets.some((t) => t.assetId === previous))
        assets.value = previous;
    }
    const busy = ["loading_assets", "previewing", "committing"].includes(
      snapshot.phase,
    );
    const hasPayment = !!snapshot.operation;
    for (const control of [assets, amount, refund, ownership])
      control.disabled = busy || hasPayment || snapshot.phase === "disabled";
    refreshAssets.disabled =
      busy || hasPayment || snapshot.phase === "disabled";
    preview.disabled =
      busy ||
      hasPayment ||
      !snapshot.assets.length ||
      snapshot.phase === "disabled";
    confirm.hidden = snapshot.phase !== "review" || !snapshot.preview;
    confirm.disabled = busy;
    check.hidden = !snapshot.operation;
    startNew.hidden =
      !options.newContext ||
      !snapshot.operation ||
      !["funded", "refunded"].includes(snapshot.operation.phase);
    review.replaceChildren();
    if (snapshot.preview) {
      const quote = snapshot.preview;
      const token = snapshot.assets.find(
        (t) => t.assetId === quote.quoteRequest.originAsset,
      );
      const fee = providerFeeBps(quote);
      review.append(
        paragraph(
          `You send ${formatTokenAmount(quote.quote.amountIn, token?.decimals ?? 0)} ${token?.symbol ?? "source units"}`,
        ),
        paragraph(
          `Estimated destination amount: ${formatTokenAmount(quote.quote.amountOut, 24)} NEAR equivalent`,
        ),
        paragraph(
          `Minimum destination amount: ${formatTokenAmount(quote.quote.minAmountOut, 24)} NEAR equivalent`,
        ),
        paragraph(
          `Estimated wait: ${Math.ceil(quote.quote.timeEstimate / 60)} minutes. Provider costs are reflected in the quoted output; your source network fee is separate.`,
        ),
        paragraph(
          fee === undefined
            ? "Provider fee is not itemized in this quote. Review the final quoted output."
            : `Provider platform fee: ${(fee / 100).toFixed(2)}%, reflected in the quoted output.`,
        ),
        paragraph(
          `Refunds go to ${quote.quoteRequest.refundTo}. Native NEAR delivery is checked before payment instructions are enabled.`,
        ),
      );
    }
    instructions.replaceChildren();
    if (!snapshot.operation) return;
    const op = snapshot.operation;
    recoveryId.value = op.id;
    instructions.append(
      paragraph(`Recovery ID: ${op.id}`),
      paragraph(
        `Destination: ${op.context.accountId} on ${op.context.networkId}`,
      ),
    );
    if (!snapshot.canSend) {
      instructions.append(
        paragraph(
          "Sending instructions are hidden while this payment is processing, expired, or awaiting account and capability checks. You can keep tracking it.",
        ),
      );
      return;
    }
    const q = op.quote.quote;
    instructions.append(
      paragraph(
        `Send exactly ${formatTokenAmount(q.amountIn, op.token.decimals)} ${op.token.symbol} on ${op.token.blockchain}.`,
      ),
      paragraph(`Payment address: ${q.depositAddress}`),
      paragraph(
        `Send before ${new Date(expiresAt(op.quote)).toLocaleString()}. Do not reuse after expiry.`,
      ),
    );
    if (q.depositMemo)
      instructions.append(
        paragraph(
          `Mandatory memo/tag: ${q.depositMemo}. Include it or payment may not arrive.`,
        ),
      );
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy payment details";
    copy.addEventListener("click", async () => {
      const fresh = controller.getState();
      if (!fresh.canSend || fresh.operation?.id !== op.id) {
        details(fresh);
        return;
      }
      try {
        await navigator.clipboard.writeText(
          `Network: ${op.token.blockchain}\nAsset: ${op.token.symbol} (${op.token.assetId})\nAmount: ${formatTokenAmount(q.amountIn, op.token.decimals)}\nAddress: ${q.depositAddress}${q.depositMemo ? `\nMemo: ${q.depositMemo}` : ""}\nRecipient: ${op.context.accountId}`,
        );
        status.textContent =
          "Payment details copied. Check the source network and memo in your wallet.";
      } catch {
        status.textContent =
          "Copy unavailable. Select and copy the displayed details manually.";
      }
    });
    instructions.append(
      copy,
      paragraph(
        "QR contains the address only. Enter the amount and any mandatory memo separately.",
      ),
    );
    void renderQr(q.depositAddress!)
      .then((url) => {
        if (
          disposed ||
          epoch !== qrRevision ||
          !controller.getState().canSend ||
          !url.startsWith("data:image/png;base64,")
        )
          return;
        const img = document.createElement("img");
        img.src = url;
        img.width = 200;
        img.height = 200;
        img.alt =
          "Deposit address QR; amount and memo must be entered separately";
        instructions.append(img);
      })
      .catch(() => {
        /* Copyable text remains the primary payment instruction. */
      });
  }
  const unsubscribe = controller.subscribe(details);
  const invalidate = () => {
    if (controller.getState().preview) controller.invalidatePreview();
  };
  form.addEventListener("input", invalidate);
  const onPreview = (event: Event) => {
    event.preventDefault();
    const context = getContext();
    if (!context) {
      status.textContent = "Connect your wallet first";
      return;
    }
    reviewContext = context;
    void controller.preview(
      {
        assetId: assets.value,
        amount: amount.value.trim(),
        refundAddress: refund.value.trim(),
        refundAddressConfirmed: ownership.checked,
      },
      context,
    );
  };
  form.addEventListener("submit", onPreview);
  const onConfirm = () => {
    const snapshot = controller.getState();
    if (snapshot.preview && reviewContext)
      void controller.commit(snapshot.preview.correlationId, reviewContext);
  };
  confirm.addEventListener("click", onConfirm);
  const onAssets = () => {
    void controller.loadAssets();
  };
  refreshAssets.addEventListener("click", onAssets);
  const onCheck = () => {
    const op = controller.getState().operation;
    if (op) void controller.refresh(op.id);
  };
  check.addEventListener("click", onCheck);
  const onNew = () => {
    try {
      const context = options.newContext?.();
      if (!context)
        throw new Error("Connect a wallet before starting another payment");
      controller.reset(context);
      reviewContext = null;
      ownership.checked = false;
      void controller.loadAssets();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "New payment unavailable";
    }
  };
  startNew.addEventListener("click", onNew);
  const onResume = (event: Event) => {
    event.preventDefault();
    const context = getContext(),
      id = recoveryId.value.trim();
    void controller.resume(
      id,
      context ? { ...context, operationId: id } : undefined,
    );
  };
  recovery.addEventListener("submit", onResume);
  if (options.initialOperationId)
    void controller.resume(options.initialOperationId);
  else if (controller.getState().phase !== "disabled")
    void controller.loadAssets();
  // Expiry can change without a provider status update; clear copy and QR promptly.
  const expiryTimer = setInterval(() => {
    const snapshot = controller.getState();
    const key = `${snapshot.operation?.id ?? ""}:${snapshot.canSend}:${snapshot.message}`;
    if (snapshot.operation && key !== renderedInstructionsKey)
      details(snapshot);
  }, 1000);
  return () => {
    disposed = true;
    ++qrRevision;
    clearInterval(expiryTimer);
    unsubscribe();
    form.removeEventListener("submit", onPreview);
    form.removeEventListener("input", invalidate);
    confirm.removeEventListener("click", onConfirm);
    refreshAssets.removeEventListener("click", onAssets);
    check.removeEventListener("click", onCheck);
    recovery.removeEventListener("submit", onResume);
    startNew.removeEventListener("click", onNew);
    controller.dispose();
    section.remove();
  };
}
