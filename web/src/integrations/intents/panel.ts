import QRCode from "qrcode";
import type { OperationContext } from "../types";
import type { IntentsFundingController } from "./funding";
import { expiresAt, formatTokenAmount, providerFeeBps } from "./quote";
import type { FundingPhase, FundingSnapshot } from "./types";
import "./panel.css";

export interface IntentsPanelOptions {
  getContext(): OperationContext | null;
  /** Called only after the player chooses a new payment, never for status checks. */
  newContext?(): OperationContext | null;
  initialOperationId?: string;
  renderQr?: (address: string) => Promise<string>;
  /** Owner test mode: delivery is unproven, and the panel says so above every control. */
  testMode?: boolean;
}

/** Provider chain ids → names a player recognises. Unknown ids fall back to the raw id. */
const CHAIN_NAMES: Record<string, string> = {
  arb: "Arbitrum",
  aptos: "Aptos",
  avax: "Avalanche",
  base: "Base",
  bera: "Berachain",
  bsc: "BNB Chain",
  btc: "Bitcoin",
  eth: "Ethereum",
  gnosis: "Gnosis",
  monad: "Monad",
  near: "NEAR",
  op: "Optimism",
  pol: "Polygon",
  scroll: "Scroll",
  sol: "Solana",
  starknet: "Starknet",
  stellar: "Stellar",
  sui: "Sui",
  ton: "TON",
  tron: "Tron",
  xlayer: "X Layer",
  zec: "Zcash",
};
export const chainName = (id: string) => CHAIN_NAMES[id] ?? id;
/** Picker order: majors first. Unlisted chains sort after, alphabetically. */
const CHAIN_ORDER = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "sol", "tron"];
const FAMILY_ORDER = ["USDC", "USDT", "ETH", "SOL"];
/** USDT0 / USD₮0 is how Tether's own USDT is named on some chains; players look for "USDT". */
const family = (symbol: string) => (/^USD[T₮]0?$/i.test(symbol) ? "USDT" : symbol);
const rank = (list: string[], key: string) => {
  const i = list.indexOf(key);
  return i < 0 ? list.length : i;
};

const REFUND_PLACEHOLDER: Record<string, string> = {
  btc: "bc1…",
  sol: "Your Solana address",
  near: "you.near",
  ton: "UQ…",
  tron: "T…",
};

/** What the player sees for each tracked phase: a short label and a tone. */
const PHASE_LABEL: Partial<
  Record<FundingPhase, [string, "wait" | "good" | "bad"]>
> = {
  awaiting_deposit: ["Waiting for your payment", "wait"],
  deposit_detected: ["Payment seen", "wait"],
  processing: ["Converting", "wait"],
  incomplete_deposit: ["Incomplete payment", "bad"],
  settled_verifying: ["Checking delivery", "wait"],
  needs_unwrap: ["Arrived as wNEAR", "bad"],
  funded: ["Funded", "good"],
  refunded: ["Refunded", "bad"],
  failed_needs_review: ["Needs review", "bad"],
  expired_unfunded: ["Expired", "bad"],
  identity_changed: ["Different account", "bad"],
  unavailable: ["Status unavailable", "bad"],
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text: string, className: string, type: "button" | "submit" = "button") => {
  const b = el("button", className, text);
  b.type = type;
  return b;
};

function countdown(ms: number): string {
  if (ms <= 0) return "Expired";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)} left` : `${m}:${pad(s)} left`;
}

/** Inline funding panel: no overlay of its own and no changes to the drawing/session state. */
export function mountIntentsFundingPanel(
  host: HTMLElement,
  controller: IntentsFundingController,
  options: IntentsPanelOptions,
): () => void {
  const section = el("section", "mp-intents-panel");
  section.setAttribute("aria-label", "Add funds from another network");

  const lede = el(
    "p",
    "mp-intents-lede",
    "Pay from a wallet on another network. NEAR Intents converts it and delivers NEAR to your account.",
  );
  const status = el("p", "mp-intents-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  // ---- Step 1: what to send -------------------------------------------------------------
  const form = el("form", "mp-intents-form");
  form.noValidate = false;
  const field = (labelText: string, control: HTMLElement, hint?: HTMLElement) => {
    const wrap = el("label", "mp-intents-field");
    wrap.append(el("span", "mp-intents-label", labelText), control);
    if (hint) wrap.append(hint);
    return wrap;
  };
  const symbols = el("select", "mp-intents-input");
  symbols.required = true;
  symbols.setAttribute("aria-label", "Asset");
  const assets = el("select", "mp-intents-input");
  assets.required = true;
  assets.setAttribute("aria-label", "Source network");
  const pickRow = el("div", "mp-intents-pick");
  const amount = el("input", "mp-intents-input mp-intents-amount-input");
  amount.inputMode = "decimal";
  amount.required = true;
  amount.autocomplete = "off";
  amount.placeholder = "0.00";
  const amountSymbol = el("span", "mp-intents-amount-symbol");
  const amountWrap = el("span", "mp-intents-amount");
  amountWrap.append(amount, amountSymbol);
  const refund = el("input", "mp-intents-input mp-intents-mono");
  refund.required = true;
  refund.autocomplete = "off";
  refund.spellcheck = false;
  const refundHint = el(
    "small",
    "mp-intents-hint",
    "If the conversion can't complete, your funds go back here.",
  );
  const ownership = el("input");
  ownership.type = "checkbox";
  ownership.required = true;
  const ownershipText = el("span");
  const ownershipRow = el("label", "mp-intents-check");
  ownershipRow.append(ownership, ownershipText);
  const preview = button("Get a quote", "mp-intents-btn mp-intents-primary", "submit");
  pickRow.append(field("You send", symbols), field("Network", assets));
  form.append(
    pickRow,
    field("Amount", amountWrap),
    field("Refund address", refund, refundHint),
    ownershipRow,
    preview,
  );
  const retry = button("Try again", "mp-intents-btn");
  retry.hidden = true;

  // ---- Step 2: the quote ----------------------------------------------------------------
  const review = el("div", "mp-intents-card mp-intents-review");
  const reviewRows = el("dl", "mp-intents-rows");
  const reviewNote = el("p", "mp-intents-fine");
  const reviewActions = el("div", "mp-intents-actions");
  const confirm = button("Get payment address", "mp-intents-btn mp-intents-primary");
  const change = button("Change", "mp-intents-btn");
  reviewActions.append(confirm, change);
  review.append(el("h4", "mp-intents-card-title", "Your quote"), reviewRows, reviewNote, reviewActions);
  review.hidden = true;

  // ---- Step 3: the payment --------------------------------------------------------------
  const instructions = el("div", "mp-intents-card mp-intents-pay");
  instructions.hidden = true;
  const check = button("Check payment status", "mp-intents-btn");
  check.hidden = true;
  const startNew = button("Start another funding payment", "mp-intents-btn");
  startNew.hidden = true;
  const tracking = el("div", "mp-intents-actions");
  tracking.append(check, startNew);

  // ---- Recovery, tucked away ------------------------------------------------------------
  const recoverBox = el("details", "mp-intents-recover");
  recoverBox.append(el("summary", undefined, "Track an earlier payment"));
  const recovery = el("form", "mp-intents-recover-form");
  const recoveryId = el("input", "mp-intents-input mp-intents-mono");
  recoveryId.autocomplete = "off";
  recoveryId.required = true;
  recoveryId.placeholder = "Recovery ID";
  recoveryId.setAttribute("aria-label", "Payment recovery ID");
  const resume = button("Track saved payment", "mp-intents-btn", "submit");
  recovery.append(recoveryId, resume);
  recoverBox.append(recovery);

  const warning = el(
    "p",
    "mp-intents-fine",
    "You pay the source network's fee. Funding adds NEAR only — it does not buy paint credits or mPOO automatically.",
  );

  section.append(lede, status, form, retry, review, instructions, tracking, recoverBox, warning);
  if (options.testMode) {
    // Stated before any control, and before the amount is chosen: this route is not proven.
    const test = el(
      "p",
      "mp-intents-test",
      "TEST MODE: native NEAR delivery to this account type is not verified yet. A deposit may arrive as wNEAR or fail, and only a small test amount should be sent. Not for other players.",
    );
    test.setAttribute("role", "note");
    section.prepend(test);
  }
  host.append(section);

  let disposed = false;
  let qrRevision = 0;
  let reviewContext: OperationContext | null = null;
  let lastAssets = "";
  let renderedInstructionsKey = "";
  let expiryNode: HTMLElement | null = null;
  let expiryAt = 0;
  const getContext = () => options.getContext();
  const renderQr =
    options.renderQr ??
    ((address) =>
      QRCode.toDataURL(address, {
        width: 200,
        margin: 2,
        errorCorrectionLevel: "M",
      }));

  const row = (dl: HTMLElement, term: string, value: string, strong = false) => {
    const wrap = el("div", strong ? "is-strong" : undefined);
    wrap.append(el("dt", undefined, term), el("dd", undefined, value));
    dl.append(wrap);
  };
  const selectedToken = (snapshot = controller.getState()) =>
    snapshot.assets.find((t) => t.assetId === assets.value);
  /** Network options for the chosen asset; keeps the previous route when it is still offered. */
  function fillNetworks(snapshot: FundingSnapshot, keep?: string) {
    const routes = snapshot.assets
      .filter((t) => family(t.symbol) === symbols.value)
      .sort(
        (a, b) =>
          rank(CHAIN_ORDER, a.blockchain) - rank(CHAIN_ORDER, b.blockchain) ||
          a.blockchain.localeCompare(b.blockchain),
      );
    assets.replaceChildren(
      ...routes.map((t) => {
        const option = document.createElement("option");
        option.value = t.assetId;
        option.textContent =
          chainName(t.blockchain) +
          (family(t.symbol) !== t.symbol ? ` (${t.symbol})` : "");
        return option;
      }),
    );
    if (keep && routes.some((t) => t.assetId === keep)) assets.value = keep;
  }
  function syncTokenLabels() {
    const token = selectedToken();
    amountSymbol.textContent = token?.symbol ?? "";
    const chain = token ? chainName(token.blockchain) : "the source network";
    refund.placeholder = token
      ? `${REFUND_PLACEHOLDER[token.blockchain] ?? "0x…"} on ${chain}`
      : "";
    ownershipText.textContent = `I control this address on ${chain}`;
  }
  async function copyFresh(opId: string, text: string, done: string) {
    const fresh = controller.getState();
    if (!fresh.canSend || fresh.operation?.id !== opId) {
      details(fresh);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = done;
      status.dataset.tone = "good";
    } catch {
      status.textContent = "Copy unavailable. Select and copy the details shown.";
      status.dataset.tone = "bad";
    }
  }

  function details(snapshot: FundingSnapshot) {
    renderedInstructionsKey = `${snapshot.operation?.id ?? ""}:${snapshot.canSend}:${snapshot.message}`;
    const epoch = ++qrRevision;
    status.textContent = snapshot.message;
    status.dataset.tone =
      snapshot.phase === "unavailable" || snapshot.phase === "identity_changed"
        ? "bad"
        : "";
    const registry = JSON.stringify(snapshot.assets);
    if (registry !== lastAssets) {
      lastAssets = registry;
      const previous = selectedToken(snapshot) ?? null;
      const families = [...new Set(snapshot.assets.map((t) => family(t.symbol)))].sort(
        (a, b) => rank(FAMILY_ORDER, a) - rank(FAMILY_ORDER, b) || a.localeCompare(b),
      );
      symbols.replaceChildren(
        ...families.map((name) => {
          const option = document.createElement("option");
          option.value = option.textContent = name;
          return option;
        }),
      );
      if (previous) symbols.value = family(previous.symbol);
      fillNetworks(snapshot, previous?.assetId);
    }
    syncTokenLabels();
    const busy = ["loading_assets", "previewing", "committing"].includes(
      snapshot.phase,
    );
    const hasPayment = !!snapshot.operation;
    const disabled = snapshot.phase === "disabled";
    for (const control of [symbols, assets, amount, refund, ownership])
      control.disabled = busy || hasPayment || disabled;
    form.hidden = hasPayment || disabled || !!snapshot.preview;
    preview.disabled = busy || hasPayment || !snapshot.assets.length || disabled;
    preview.textContent =
      snapshot.phase === "previewing"
        ? "Getting a quote…"
        : snapshot.phase === "loading_assets"
          ? "Loading networks…"
          : "Get a quote";
    retry.hidden =
      hasPayment || disabled || busy || snapshot.assets.length > 0;
    review.hidden = !snapshot.preview || hasPayment;
    confirm.hidden = snapshot.phase !== "review" && snapshot.phase !== "committing";
    confirm.disabled = busy;
    confirm.textContent =
      snapshot.phase === "committing" ? "Creating address…" : "Get payment address";
    change.disabled = snapshot.phase === "committing";
    check.hidden = !hasPayment;
    // An expired, never-funded quote holds nothing to track; refusing a new payment there
    // left players locked on a dead address with no instructions and no way forward.
    startNew.hidden =
      !options.newContext ||
      !snapshot.operation ||
      !["funded", "refunded", "expired_unfunded"].includes(
        snapshot.operation.phase,
      );
    if (disabled && !hasPayment) recoverBox.open = true;

    reviewRows.replaceChildren();
    if (snapshot.preview) {
      const quote = snapshot.preview;
      const token = snapshot.assets.find(
        (t) => t.assetId === quote.quoteRequest.originAsset,
      );
      const fee = providerFeeBps(quote);
      row(
        reviewRows,
        "You send",
        `${formatTokenAmount(quote.quote.amountIn, token?.decimals ?? 0)} ${token?.symbol ?? "source units"}${token ? ` on ${chainName(token.blockchain)}` : ""}`,
      );
      row(
        reviewRows,
        "You receive (est.)",
        `≈ ${formatTokenAmount(quote.quote.amountOut, 24)} NEAR`,
        true,
      );
      row(
        reviewRows,
        "Minimum received",
        `${formatTokenAmount(quote.quote.minAmountOut, 24)} NEAR`,
      );
      row(
        reviewRows,
        "Provider fee",
        fee === undefined ? "Included in the quote" : `${(fee / 100).toFixed(2)}%, included`,
      );
      row(reviewRows, "Time", `About ${Math.ceil(quote.quote.timeEstimate / 60)} min`);
      row(reviewRows, "Refunds to", quote.quoteRequest.refundTo);
      reviewNote.textContent =
        "Your source network fee is separate. Native NEAR delivery is checked before the payment address is shown.";
    }

    instructions.replaceChildren();
    expiryNode = null;
    instructions.hidden = !hasPayment;
    if (!snapshot.operation) return;
    const op = snapshot.operation;
    recoveryId.value = op.id;
    const [label, tone] = PHASE_LABEL[op.phase] ?? [op.phase, "wait"];
    const badge = el("span", "mp-intents-badge", label);
    badge.dataset.tone = tone;
    const head = el("div", "mp-intents-pay-head");
    head.append(el("h4", "mp-intents-card-title", "Payment"), badge);
    instructions.append(head);
    const meta = el("dl", "mp-intents-rows mp-intents-meta");
    row(meta, "Delivers to", `${op.context.accountId} on ${op.context.networkId}`);
    const idRow = el("p", "mp-intents-fine mp-intents-mono", `Recovery ID: ${op.id}`);
    if (!snapshot.canSend) {
      instructions.append(
        el(
          "p",
          "mp-intents-fine",
          snapshot.sendBlockedReason ??
            "Sending instructions are hidden while this payment is processing, expired, or awaiting account and capability checks. You can keep tracking it.",
        ),
        meta,
        idRow,
      );
      return;
    }
    const q = op.quote.quote;
    const chain = chainName(op.token.blockchain);
    const sendAmount = formatTokenAmount(q.amountIn, op.token.decimals);
    const big = el("p", "mp-intents-send");
    big.append(
      el("span", "mp-intents-send-label", "Send exactly"),
      el("strong", "mp-intents-send-amount", `${sendAmount} ${op.token.symbol}`),
      el("span", "mp-intents-send-chain", `on ${chain} — no other network`),
    );
    const grid = el("div", "mp-intents-pay-grid");
    const qrSlot = el("div", "mp-intents-qr");
    const fields = el("div", "mp-intents-pay-fields");
    const addressBox = el("div", "mp-intents-copyfield");
    const addressCode = el("code", "mp-intents-mono", q.depositAddress ?? "");
    const copyAddress = button("Copy", "mp-intents-btn mp-intents-btn-sm");
    copyAddress.setAttribute("aria-label", "Copy payment address");
    copyAddress.addEventListener("click", () =>
      copyFresh(op.id, q.depositAddress!, "Address copied. Check the network and amount in your wallet."),
    );
    addressBox.append(addressCode, copyAddress);
    fields.append(el("span", "mp-intents-label", "Payment address"), addressBox);
    if (q.depositMemo) {
      const memoBox = el("div", "mp-intents-copyfield");
      memoBox.append(el("code", "mp-intents-mono", q.depositMemo));
      fields.append(
        el("span", "mp-intents-label", "Memo / tag — required"),
        memoBox,
        el(
          "p",
          "mp-intents-warn",
          `Mandatory memo/tag: ${q.depositMemo}. Include it or payment may not arrive.`,
        ),
      );
    }
    expiryAt = expiresAt(op.quote);
    expiryNode = el("p", "mp-intents-expiry");
    expiryNode.title = `Send before ${new Date(expiryAt).toLocaleString()}. Do not reuse after expiry.`;
    expiryNode.textContent = countdown(expiryAt - Date.now());
    fields.append(expiryNode);
    grid.append(qrSlot, fields);
    const copy = button("Copy payment details", "mp-intents-btn");
    copy.addEventListener("click", () =>
      copyFresh(
        op.id,
        `Network: ${op.token.blockchain}\nAsset: ${op.token.symbol} (${op.token.assetId})\nAmount: ${sendAmount}\nAddress: ${q.depositAddress}${q.depositMemo ? `\nMemo: ${q.depositMemo}` : ""}\nRecipient: ${op.context.accountId}`,
        "Payment details copied. Check the source network and memo in your wallet.",
      ),
    );
    instructions.append(
      big,
      grid,
      copy,
      el(
        "p",
        "mp-intents-fine",
        `QR contains the address only. Enter the amount and any mandatory memo separately. Do not reuse this address after it expires.`,
      ),
      meta,
      idRow,
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
        img.width = 168;
        img.height = 168;
        img.alt =
          "Deposit address QR; amount and memo must be entered separately";
        qrSlot.append(img);
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
  const onSelect = () => syncTokenLabels();
  assets.addEventListener("change", onSelect);
  const onFamily = () => {
    fillNetworks(controller.getState());
    syncTokenLabels();
    invalidate();
  };
  symbols.addEventListener("change", onFamily);
  const onPreview = (event: Event) => {
    event.preventDefault();
    const context = getContext();
    if (!context) {
      status.textContent = "Connect your wallet first";
      status.dataset.tone = "bad";
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
  const onChange = () => {
    controller.invalidatePreview();
    amount.focus();
  };
  change.addEventListener("click", onChange);
  const onRetry = () => {
    void controller.loadAssets();
  };
  retry.addEventListener("click", onRetry);
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
      status.dataset.tone = "bad";
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
    else if (expiryNode) expiryNode.textContent = countdown(expiryAt - Date.now());
  }, 1000);
  return () => {
    disposed = true;
    ++qrRevision;
    clearInterval(expiryTimer);
    unsubscribe();
    form.removeEventListener("submit", onPreview);
    form.removeEventListener("input", invalidate);
    assets.removeEventListener("change", onSelect);
    symbols.removeEventListener("change", onFamily);
    confirm.removeEventListener("click", onConfirm);
    change.removeEventListener("click", onChange);
    retry.removeEventListener("click", onRetry);
    check.removeEventListener("click", onCheck);
    recovery.removeEventListener("submit", onResume);
    startNew.removeEventListener("click", onNew);
    controller.dispose();
    section.remove();
  };
}
