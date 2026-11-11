/**
 * Dock-matched buy-credits panel for schema-4 boards (Phase 0).
 * Cream panel language matches `.paint-dock` — not a separate IAP aesthetic.
 *
 * A confirmed purchase closes the sheet and reports the new balance in a page toast: the
 * purchase is the point of the panel, so leaving the player on a form that quietly
 * reloaded read as if nothing had happened (issue #98). Only a confirmed result does this;
 * an unclear or failed outcome keeps the sheet open with its explanation.
 *
 * The token ("Pay with mPOO") path is feature-detected per board: it opens only
 * when `get_mpoo_sales_today()` exists and reports a non-zero cap with credits
 * remaining today, and the token's `ft_metadata` verifies. Otherwise the sheet
 * stays NEAR-only with the "Buy NEAR" link (issue #28).
 */

import {
  mpooCheckoutOpen,
  parseMpooSalesToday,
  parsePaymentConfig,
  quoteBuyCredits,
  splitTokenQuantity,
  type BuyQuote,
  type MpooSalesToday,
  type PayAsset,
  type PaymentConfigView,
} from "../buy-credits";
import { CONTRACT_ID, INTENTS_FUNDING_ENABLED, PAGE_NETWORK, RPC_URL } from "../config";
import { viewFunction } from "../contract";
import {
  BUY_NEAR_URL,
  createReadRpc,
  formatUnits,
  NEARLY_MPOO_URL,
} from "../paint-wallet";
import {
  submitBuyCredits,
  type BuyFailureCode,
  type SubmitBuyResult,
} from "../submit-buy-credits";
import type { AppServices } from "./services";

export interface BuyCreditsSheetHandles {
  open(options?: { quantity?: number }): void;
  close(): void;
  setVisible(paidBoard: boolean): void;
  setCredits(balance: bigint | null | undefined): void;
  dispose(): void;
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/** The token path, present only when today's sales are open on this board. */
interface TokenOffer {
  symbol: string;
  decimals: number;
  sales: MpooSalesToday;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      config: PaymentConfigView;
      credits: bigint | null;
      token: TokenOffer | null;
    }
  | { status: "error"; message: string };

/** Refund codes after which the sheet switches to NEAR and says why. */
const TOKEN_REFUND_CODES: ReadonlySet<BuyFailureCode> = new Set([
  "mpoo_cap_reached",
  "mpoo_sales_closed",
  "token_refunded",
  "price_changed",
]);

/** How long a purchase confirmation stays on screen before it clears itself. */
const TOAST_MS = 6000;

/** The quantity a fresh form starts on, and the sheet's own default. */
const DEFAULT_QUANTITY = 10;

/** "12 credits" / "1 credit" — the one place a credit count is pluralised. */
function creditCount(balance: bigint | number): string {
  return `${balance} credit${String(balance) === "1" ? "" : "s"}`;
}

/**
 * The player's balance in their own words. "Not registered · 0" is the contract's
 * vocabulary for an account that has never bought: to the player that is simply zero
 * credits, and naming the registration step here only raised a question.
 */
function creditLabel(balance: bigint | null | undefined): string {
  if (balance === undefined) {
    return "Reading your credits…";
  }
  if (balance === null || balance === 0n) {
    return "You have 0 credits";
  }
  return `You have ${creditCount(balance)}`;
}

/** Reset moment in the viewer's own time zone, e.g. "Tue 1:00 AM". */
export function formatResetTime(resetsAtNs: bigint, locale?: string): string {
  const date = new Date(Number(resetsAtNs / 1_000_000n));
  return date.toLocaleString(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function mountBuyCreditsSheet(
  host: HTMLElement,
  services: AppServices,
  options: {
    onCreditsChanged?: (balance: bigint | null) => void;
    /**
     * Called after every purchase attempt that reached a wallet, whatever the
     * outcome. The owner re-reads credits from chain; the sheet never bumps them.
     */
    onPurchaseSettled?: () => void;
    /** Injectable for tests; defaults to a `ft_metadata` read over RPC. */
    readTokenMetadata?: (tokenId: string) => Promise<TokenMetadata>;
    /**
     * Opens the cross-chain "Add funds" dialog and calls `onClosed` when it closes, or returns
     * false if there is no such dialog on the page. Defaults to the wallet menu's own button
     * (`.paint-wallet-add-funds`), so there is one funding flow, not two. Null hides the offer.
     */
    openFunding?: ((onClosed: () => void) => boolean) | null;
  } = {},
): BuyCreditsSheetHandles {
  const readMetadata = options.readTokenMetadata ?? readTokenMetadata;
  const openFunding =
    options.openFunding === undefined
      ? INTENTS_FUNDING_ENABLED && PAGE_NETWORK === "mainnet"
        ? openWalletFundingDialog
        : null
      : options.openFunding;
  host.innerHTML = `
    <div class="buy-credits-sheet" hidden>
      <div class="buy-credits-panel" role="dialog" aria-modal="true" aria-labelledby="buy-credits-title">
        <div class="buy-credits-header">
          <h2 id="buy-credits-title">Buy credits</h2>
          <button type="button" class="action secondary buy-credits-close">Close</button>
        </div>
        <p class="buy-credits-price" data-buy="price">Reading price…</p>
        <p class="buy-credits-token-info" data-buy="token-info" hidden></p>
        <p class="buy-credits-balance" data-buy="balance">${creditLabel(undefined)}</p>
        <label class="buy-credits-qty-label" for="buy-credits-qty">Quantity</label>
        <div class="buy-credits-qty-row">
          <button type="button" class="action secondary" data-buy="dec" aria-label="Fewer credits">−</button>
          <input id="buy-credits-qty" class="buy-credits-qty" type="number" min="1" step="1" value="10" />
          <button type="button" class="action secondary" data-buy="inc" aria-label="More credits">+</button>
        </div>
        <fieldset class="buy-credits-asset">
          <legend>Pay with</legend>
          <label><input type="radio" name="buy-asset" value="near" checked /> NEAR</label>
          <!-- Hidden by default. Revealed only after the board reports open token
             sales today, so it can never flash before config load. -->
          <label data-buy="token-option" hidden><input type="radio" name="buy-asset" value="token" /> <span data-buy="token-label">token</span></label>
        </fieldset>
        <div class="buy-credits-split" data-buy="split" hidden>
          <p data-buy="split-text"></p>
          <button type="button" class="action secondary" data-buy="split-near"></button>
        </div>
        <dl class="buy-credits-lines" data-buy="lines"></dl>
        <p class="buy-credits-total" data-buy="total"></p>
        <p class="buy-credits-note" data-buy="note">Credits are prepaid paint. They cannot be withdrawn.</p>
        <div class="buy-credits-funding" data-buy="funding" hidden>
          <p>No NEAR? Pay with USDC, USDT, ETH or SOL from another chain. It arrives as NEAR in this wallet, then you buy credits here.</p>
          <button type="button" class="action secondary" data-buy="add-funds">Add funds from another chain</button>
        </div>
        <p class="buy-credits-status" data-buy="status" role="status"></p>
        <div class="buy-credits-actions">
          <!-- The site's primary button (design/tokens.css .mp-btn-primary), so the one
               action that spends money is the same yellow as every other primary. -->
          <button type="button" class="mp-btn mp-btn-primary" data-buy="pay">Pay</button>
          <button type="button" class="action secondary" data-buy="retry-price" hidden>Retry price</button>
          <a class="action secondary buy-credits-buy-near" data-buy="buy-near" target="_blank" rel="noopener noreferrer">Buy NEAR ↗</a>
          <a class="action secondary buy-credits-nearly" data-buy="nearly" target="_blank" rel="noopener noreferrer" hidden>Buy on NEARLY ↗</a>
        </div>
        <p class="buy-credits-how"><a href="/how-it-works#hiw-pay">How paying works →</a></p>
      </div>
    </div>
  `;

  const sheet = host.querySelector<HTMLElement>(".buy-credits-sheet")!;
  const qtyInput = host.querySelector<HTMLInputElement>("#buy-credits-qty")!;
  const lines = host.querySelector<HTMLElement>("[data-buy=lines]")!;
  const totalEl = host.querySelector<HTMLElement>("[data-buy=total]")!;
  const statusEl = host.querySelector<HTMLElement>("[data-buy=status]")!;
  const priceEl = host.querySelector<HTMLElement>("[data-buy=price]")!;
  const tokenInfoEl = host.querySelector<HTMLElement>("[data-buy=token-info]")!;
  const balanceEl = host.querySelector<HTMLElement>("[data-buy=balance]")!;
  const noteEl = host.querySelector<HTMLElement>("[data-buy=note]")!;
  const payButton = host.querySelector<HTMLButtonElement>("[data-buy=pay]")!;
  const retryPrice = host.querySelector<HTMLButtonElement>("[data-buy=retry-price]")!;
  const buyNear = host.querySelector<HTMLAnchorElement>("[data-buy=buy-near]")!;
  const nearly = host.querySelector<HTMLAnchorElement>("[data-buy=nearly]")!;
  const tokenOption = host.querySelector<HTMLElement>("[data-buy=token-option]")!;
  const tokenLabel = host.querySelector<HTMLElement>("[data-buy=token-label]")!;
  const splitBox = host.querySelector<HTMLElement>("[data-buy=split]")!;
  const splitText = host.querySelector<HTMLElement>("[data-buy=split-text]")!;
  const splitNear = host.querySelector<HTMLButtonElement>("[data-buy=split-near]")!;
  const nearRadio = host.querySelector<HTMLInputElement>('input[name="buy-asset"][value="near"]')!;
  const tokenRadio = host.querySelector<HTMLInputElement>('input[name="buy-asset"][value="token"]')!;
  const closeButton = host.querySelector<HTMLButtonElement>(".buy-credits-close")!;
  const fundingBox = host.querySelector<HTMLElement>("[data-buy=funding]")!;
  const addFundsButton = host.querySelector<HTMLButtonElement>("[data-buy=add-funds]")!;
  fundingBox.hidden = !openFunding;

  buyNear.href = BUY_NEAR_URL;
  nearly.href = NEARLY_MPOO_URL;
  buyNear.hidden = false;
  nearly.hidden = true;

  let disposed = false;
  let paidBoardVisible = false;
  let load: LoadState = { status: "idle" };
  let buying = false;
  let generation = 0;
  /** Credits above today's token allowance, offered for NEAR. */
  let nearRemainder = 0;

  function tokenOffer(): TokenOffer | null {
    return load.status === "ready" ? load.token : null;
  }

  function asset(): PayAsset {
    if (!tokenOffer()) return "near";
    return tokenRadio.checked ? "token" : "near";
  }

  function selectNear(): void {
    nearRadio.checked = true;
    tokenRadio.checked = false;
  }

  function quantity(): number {
    const value = Number(qtyInput.value);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  /**
   * A confirmation that outlives the panel. A confirmed purchase closes the sheet, so a
   * status line inside it would be gone before anyone read it; the news goes to the page
   * instead. One at a time: a second purchase replaces the first rather than stacking.
   */
  let toast: HTMLElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function dismissToast(): void {
    clearTimeout(toastTimer);
    toast?.remove();
    toast = null;
  }
  function showToast(text: string): void {
    dismissToast();
    toast = document.createElement("p");
    toast.className = "mp-toast";
    // Announced, not just painted: the panel that used to hold focus is now closed.
    toast.setAttribute("role", "status");
    toast.textContent = text;
    document.body.append(toast);
    toastTimer = setTimeout(dismissToast, TOAST_MS);
  }

  /**
   * Every open starts from the same place. A sheet that kept the last purchase's quantity,
   * asset or status read as if something were still in progress.
   */
  function resetForm(quantity: number): void {
    qtyInput.value = String(quantity);
    nearRemainder = 0;
    splitBox.hidden = true;
    selectNear();
    setStatus("");
  }

  /** Token path: never let the quantity exceed today's remaining credits. */
  function clampToRemaining(): void {
    const offer = tokenOffer();
    if (!offer || asset() !== "token") {
      nearRemainder = 0;
      splitBox.hidden = true;
      return;
    }
    const split = splitTokenQuantity(quantity(), offer.sales.remaining);
    if (split.near > 0) {
      qtyInput.value = String(split.token);
      nearRemainder = split.near;
      splitText.textContent = `Only ${split.token} ${offer.symbol} credit${split.token === 1 ? "" : "s"} left today, so the quantity is capped at ${split.token}.`;
      splitNear.textContent = `Buy the other ${split.near} with NEAR`;
      splitBox.hidden = false;
    } else if (BigInt(quantity()) < offer.sales.remaining) {
      // The user lowered the quantity themselves; the offer no longer applies.
      nearRemainder = 0;
      splitBox.hidden = true;
    }
  }

  function quoteFor(state: Extract<LoadState, { status: "ready" }>): BuyQuote {
    const payWith = asset();
    return quoteBuyCredits({
      config: state.config,
      quantity: quantity(),
      asset: payWith,
      creditsBalance: state.credits,
      network: PAGE_NETWORK,
      tokenDecimals: state.token?.decimals,
      tokenSymbol: state.token?.symbol,
    });
  }

  function renderQuote(): void {
    if (load.status !== "ready") {
      lines.replaceChildren();
      totalEl.textContent = "";
      payButton.disabled = true;
      retryPrice.hidden = load.status !== "error";
      return;
    }
    retryPrice.hidden = true;
    clampToRemaining();
    let quote: BuyQuote;
    try {
      quote = quoteFor(load);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not price this purchase.");
      payButton.disabled = true;
      return;
    }
    lines.replaceChildren();
    for (const item of quote.lineItems) {
      // One cost per row: the label reads left, the money reads right. The old
      // bulleted list made a receipt look like a paragraph.
      const line = document.createElement("div");
      const label = document.createElement("dt");
      label.textContent = item.label;
      const amount = document.createElement("dd");
      amount.textContent = item.amountLabel;
      line.append(label, amount);
      lines.append(line);
    }
    if (quote.asset === "near" || !load.token) {
      totalEl.textContent = `Total · ${formatUnits(quote.totalNearAttached, 24)} NEAR, plus a small network fee`;
      payButton.textContent = `Pay ${formatUnits(quote.purchaseAmount, 24)} NEAR`;
      nearly.hidden = true;
      buyNear.hidden = false;
    } else {
      const decimals = load.token.decimals;
      totalEl.textContent = quote.registrationDeposit
        ? `Token amount · ${formatUnits(quote.purchaseAmount, decimals)} ${quote.tokenLabel} + ${formatUnits(quote.registrationDeposit, 24)} NEAR setup, plus a small network fee`
        : `Token amount · ${formatUnits(quote.purchaseAmount, decimals)} ${quote.tokenLabel}, plus a small network fee`;
      payButton.textContent = `Pay ${formatUnits(quote.purchaseAmount, decimals)} ${quote.tokenLabel}`;
      buyNear.hidden = true;
      nearly.hidden = PAGE_NETWORK !== "mainnet";
    }
    payButton.disabled = buying;
    noteEl.textContent =
      "Credits are prepaid paint still owed on the board. They cannot be withdrawn.";
  }

  /** Feature detection: missing view (old board) or bad metadata = no token path. */
  async function readTokenOffer(config: PaymentConfigView): Promise<TokenOffer | null> {
    let sales: MpooSalesToday;
    try {
      sales = parseMpooSalesToday(await viewFunction<unknown>("get_mpoo_sales_today"));
    } catch {
      return null;
    }
    if (!mpooCheckoutOpen(sales)) {
      return null;
    }
    try {
      const meta = await readMetadata(config.mpooToken);
      return { symbol: meta.symbol, decimals: meta.decimals, sales };
    } catch {
      // Without verified decimals an exact token amount cannot be quoted.
      return null;
    }
  }

  async function refreshConfig(notice?: string): Promise<void> {
    const current = ++generation;
    load = { status: "loading" };
    priceEl.textContent = "Reading price…";
    setStatus(notice ?? "Refreshing prices…");
    payButton.disabled = true;
    try {
      const raw = await viewFunction<Record<string, unknown>>("get_payment_config");
      const config = parsePaymentConfig(raw);
      const session = services.wallet.getSession();
      const [credits, token] = await Promise.all([
        (async (): Promise<bigint | null> => {
          if (!session.accountId) return null;
          const balance = await viewFunction<string | number | null>("get_credits", {
            account_id: session.accountId,
          });
          return balance === null ? null : BigInt(balance);
        })(),
        readTokenOffer(config),
      ]);
      if (disposed || current !== generation) {
        return;
      }
      load = { status: "ready", config, credits, token };
      balanceEl.textContent = session.accountId
        ? creditLabel(credits)
        : "Connect a wallet to buy credits";
      priceEl.textContent = `${formatUnits(config.nearPerCredit, 24)} NEAR / credit`;
      if (token) {
        tokenLabel.textContent = token.symbol;
        tokenOption.hidden = false;
        // No NEAR/token exchange rate is published on chain, so the discount is
        // stated, not computed against the NEAR price.
        tokenInfoEl.textContent =
          `${token.symbol} holder price · ${formatUnits(config.mpooPerCredit, token.decimals)} ${token.symbol} / credit — 20% holder discount, price set weekly. ` +
          `${token.sales.remaining} ${token.symbol} credit${token.sales.remaining === 1n ? "" : "s"} left today · resets ${formatResetTime(token.sales.resetsAtNs)} your time.`;
        tokenInfoEl.hidden = false;
      } else {
        tokenOption.hidden = true;
        tokenInfoEl.hidden = true;
        tokenInfoEl.textContent = "";
        selectNear();
      }
      setStatus(notice ?? "");
      renderQuote();
      options.onCreditsChanged?.(session.accountId ? credits : null);
    } catch (error) {
      if (disposed || current !== generation) {
        return;
      }
      const detail = error instanceof Error ? error.message : "Price unavailable";
      load = {
        status: "error",
        message: detail,
      };
      priceEl.textContent = "Price unavailable — retry";
      tokenOption.hidden = true;
      tokenInfoEl.hidden = true;
      selectNear();
      setStatus(
        notice
          ? `${notice} Prices could not be re-read: ${detail}`
          : CONTRACT_ID
            ? `Could not read payment config from ${CONTRACT_ID}. ${detail}`
            : "No board contract is configured on this page.",
      );
      payButton.disabled = true;
      retryPrice.hidden = false;
    }
  }

  async function pay(): Promise<void> {
    if (buying || load.status !== "ready") {
      return;
    }
    const session = services.wallet.getSession();
    if (!session.accountId || !session.networkId) {
      setStatus("Connect a wallet first.");
      return;
    }
    if (session.networkId !== PAGE_NETWORK) {
      setStatus(`This app is using ${PAGE_NETWORK}. Switch wallet network to buy.`);
      return;
    }
    clampToRemaining();
    let quote: BuyQuote;
    try {
      quote = quoteFor(load);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid quantity");
      return;
    }

    buying = true;
    payButton.disabled = true;
    const opId = `buy-credits:${session.accountId}:${Date.now()}`;
    services.operations.upsert({
      id: opId,
      kind: "buy_paint",
      phase: "awaiting_signature",
      accountId: session.accountId,
      networkId: session.networkId,
      transactionId: null,
      title: "Buy credits",
      detail: `${quote.quantity} credits`,
      meta: { quantity: quote.quantity, asset: quote.asset },
    });

    const result: SubmitBuyResult = await submitBuyCredits({
      quote,
      accountId: session.accountId,
      networkId: session.networkId,
      pageNetwork: PAGE_NETWORK,
      tokenContractId: load.config.mpooToken,
      creditsBefore: load.credits,
      readCredits: async (accountId) => {
        const balance = await viewFunction<string | number | null>("get_credits", {
          account_id: accountId,
        });
        return balance === null ? null : BigInt(balance);
      },
      onProgress: (progress) => {
        if (progress.phase === "wallet_prompt") {
          setStatus(progress.detail);
        } else if (progress.phase === "submitted" || progress.phase === "reconciling") {
          setStatus("Purchase submitted — reading credits…");
          services.operations.upsert({
            id: opId,
            kind: "buy_paint",
            phase: "submitted",
            accountId: session.accountId,
            networkId: session.networkId,
            transactionId: progress.transactionId,
            title: "Buy credits",
            detail: "Submitted",
          });
        }
      },
    });

    buying = false;
    if (disposed) {
      return;
    }
    // Credits are re-read from chain by the owner after every attempt.
    options.onPurchaseSettled?.();

    if (result.status === "confirmed") {
      services.operations.upsert({
        id: opId,
        kind: "buy_paint",
        phase: "confirmed",
        accountId: session.accountId,
        networkId: session.networkId,
        transactionId: result.transactionId,
        title: "Buy credits",
        detail: result.message,
      });
      balanceEl.textContent = creditLabel(result.creditsAfter);
      // The dock and the next tap's balance come from chain, never from this number.
      options.onCreditsChanged?.(result.creditsAfter);
      // A confirmed purchase is over (#98): close the form and say what the player now
      // owns, instead of reloading prices in place and looking like nothing happened.
      // Only this branch does this — an unclear or failed outcome keeps the sheet open.
      close();
      showToast(`You have ${creditCount(result.creditsAfter)} — go paint`);
      return;
    }

    if (result.status === "confirmation_delayed") {
      services.operations.upsert({
        id: opId,
        kind: "buy_paint",
        phase: "confirmation_delayed",
        accountId: session.accountId,
        networkId: session.networkId,
        transactionId: result.transactionId,
        title: "Buy credits",
        detail: result.message,
      });
      setStatus(result.message);
      payButton.disabled = false;
      return;
    }

    services.operations.upsert({
      id: opId,
      kind: "buy_paint",
      phase: result.code === "user_rejected" ? "cancelled_before_submission" : "failed",
      accountId: session.accountId,
      networkId: session.networkId,
      transactionId: result.transactionId,
      title: result.title,
      detail: result.message,
    });
    // Rejected / failed / refunded: keep the chain-read balance on screen.
    balanceEl.textContent = creditLabel(result.creditsAfter ?? load.credits);

    if (quote.asset === "token" && TOKEN_REFUND_CODES.has(result.code)) {
      // Offer NEAR in the same sheet, then re-read prices and today's sales.
      selectNear();
      nearRemainder = 0;
      splitBox.hidden = true;
      await refreshConfig(result.message);
      return;
    }
    setStatus(
      result.code === "insufficient_funds" && openFunding
        ? `${result.title}. ${result.message} You can add funds from another chain below.`
        : `${result.title}. ${result.message}`,
    );
    if (result.code === "insufficient_funds" && openFunding) fundingBox.dataset.emphasis = "true";
    payButton.disabled = false;
    renderQuote();
  }

  function open(opts?: { quantity?: number }): void {
    if (!paidBoardVisible) {
      return;
    }
    const wanted = opts?.quantity;
    // A payment waiting on the wallet keeps the sheet's own state: reopening it must
    // not wipe the status the player needs, nor the quantity they chose.
    if (!buying) {
      resetForm(
        wanted && Number.isInteger(wanted) && wanted > 0 ? wanted : DEFAULT_QUANTITY,
      );
      // Reopening means the last confirmation is old news; never leave it over the form.
      dismissToast();
    }
    sheet.hidden = false;
    if (!CONTRACT_ID) {
      priceEl.textContent = "Paid painting not available yet";
      setStatus("No board contract is configured on this page.");
      payButton.disabled = true;
      return;
    }
    void refreshConfig();
    qtyInput.focus();
  }

  function close(): void {
    sheet.hidden = true;
    setStatus("");
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !sheet.hidden) {
      close();
    }
  };

  closeButton.addEventListener("click", close);
  // One funding flow: close this window, open the wallet menu's Add funds dialog, and come
  // back here when it closes, so the next step after NEAR lands is buying credits.
  addFundsButton.addEventListener("click", () => {
    if (!openFunding) return;
    const quantityNow = quantity();
    close();
    const opened = openFunding(() => {
      if (!disposed) open({ quantity: quantityNow });
    });
    if (!opened) {
      open({ quantity: quantityNow });
      setStatus("Add funds is in the wallet menu at the top of the page.");
    }
  });
  retryPrice.addEventListener("click", () => {
    void refreshConfig();
  });
  host.querySelector("[data-buy=dec]")!.addEventListener("click", () => {
    qtyInput.value = String(Math.max(1, quantity() - 1));
    renderQuote();
  });
  host.querySelector("[data-buy=inc]")!.addEventListener("click", () => {
    qtyInput.value = String(quantity() + 1);
    renderQuote();
  });
  qtyInput.addEventListener("input", () => renderQuote());
  for (const radio of [nearRadio, tokenRadio]) {
    radio.addEventListener("change", () => renderQuote());
  }
  splitNear.addEventListener("click", () => {
    const rest = nearRemainder;
    selectNear();
    nearRemainder = 0;
    splitBox.hidden = true;
    if (rest > 0) {
      qtyInput.value = String(rest);
    }
    setStatus(`Switched to NEAR for the other ${rest} credit${rest === 1 ? "" : "s"}.`);
    renderQuote();
  });
  payButton.addEventListener("click", () => {
    void pay();
  });
  window.addEventListener("keydown", onKey);
  const unsubWallet = services.wallet.subscribe(() => {
    if (!sheet.hidden) {
      void refreshConfig();
    }
  });

  return {
    open,
    close,
    setVisible(paidBoard: boolean) {
      paidBoardVisible = paidBoard;
      if (!paidBoardVisible) {
        close();
      }
    },
    setCredits(balance) {
      if (load.status === "ready") {
        load = { ...load, credits: balance ?? null };
      }
      balanceEl.textContent = creditLabel(balance);
      if (!sheet.hidden) {
        renderQuote();
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      dismissToast();
      unsubWallet();
      window.removeEventListener("keydown", onKey);
      host.replaceChildren();
    },
  };
}

/** Verified `ft_metadata`: integer decimals and a short printable symbol. */
export function parseTokenMetadata(raw: unknown): TokenMetadata {
  const meta = (raw ?? {}) as { decimals?: unknown; symbol?: unknown };
  const decimals = meta.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error("Invalid decimals");
  }
  const symbol = typeof meta.symbol === "string" ? meta.symbol.trim() : "";
  if (!/^[\p{L}\p{N}._-]{1,16}$/u.test(symbol)) {
    throw new Error("Invalid symbol");
  }
  return { symbol, decimals };
}

async function readTokenMetadata(tokenId: string): Promise<TokenMetadata> {
  const rpc = createReadRpc(RPC_URL, new AbortController().signal);
  const response = (await rpc("query", {
    request_type: "call_function",
    account_id: tokenId,
    method_name: "ft_metadata",
    args_base64: btoa("{}"),
    finality: "final",
  })) as { result?: number[] };
  if (!Array.isArray(response.result)) {
    throw new Error("Invalid metadata");
  }
  return parseTokenMetadata(
    JSON.parse(new TextDecoder().decode(new Uint8Array(response.result))),
  );
}

/** Click the wallet menu's "Add funds from another chain" and watch its dialog close. */
export function openWalletFundingDialog(onClosed: () => void): boolean {
  const button = document.querySelector<HTMLButtonElement>(".paint-wallet-add-funds");
  if (!button) return false;
  button.click();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.mp-funding-dialog");
  if (dialog) dialog.addEventListener("close", onClosed, { once: true });
  return true;
}
