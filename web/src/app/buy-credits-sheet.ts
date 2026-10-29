/**
 * Dock-matched buy-credits panel for schema-4 boards (Phase 0).
 * Cream panel language matches `.paint-dock` — not a separate IAP aesthetic.
 */

import {
  parsePaymentConfig,
  quoteBuyCredits,
  type BuyQuote,
  type PayAsset,
  TOKEN_PAYMENTS_ENABLED,
  type PaymentConfigView,
} from "../buy-credits";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import { viewFunction } from "../contract";
import { createReadRpc, formatUnits, NEARLY_MPOO_URL } from "../paint-wallet";
import { submitBuyCredits, type SubmitBuyResult } from "../submit-buy-credits";
import type { AppServices } from "./services";

export interface BuyCreditsSheetHandles {
  open(options?: { quantity?: number }): void;
  close(): void;
  setVisible(paidBoard: boolean): void;
  setCredits(balance: bigint | null | undefined): void;
  dispose(): void;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      config: PaymentConfigView;
      credits: bigint | null;
      tokenDecimals: number;
    }
  | { status: "error"; message: string };

function creditLabel(balance: bigint | null | undefined): string {
  if (balance === undefined) {
    return "Credits: …";
  }
  if (balance === null) {
    return "Credits: not registered · 0";
  }
  return `Credits: ${balance}`;
}

export function mountBuyCreditsSheet(
  host: HTMLElement,
  services: AppServices,
  options: {
    onCreditsChanged?: (balance: bigint | null) => void;
  } = {},
): BuyCreditsSheetHandles {
  host.innerHTML = `
    <div class="buy-credits-sheet" hidden>
      <div class="buy-credits-panel" role="dialog" aria-modal="true" aria-labelledby="buy-credits-title">
        <div class="buy-credits-header">
          <h2 id="buy-credits-title">Buy credits</h2>
          <button type="button" class="action secondary buy-credits-close">Close</button>
        </div>
        <p class="buy-credits-price" data-buy="price">Reading price…</p>
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
          <!-- Hidden by default: launch sells credits for NEAR only. Render reveals it only
             when TOKEN_PAYMENTS_ENABLED is true, so it can never flash before config load. -->
          <label data-buy="token-option" hidden><input type="radio" name="buy-asset" value="token" /> <span data-buy="token-label">test token</span></label>
        </fieldset>
        <ul class="buy-credits-lines" data-buy="lines"></ul>
        <p class="buy-credits-total" data-buy="total"></p>
        <p class="buy-credits-note" data-buy="note">Credits are prepaid paint. They cannot be withdrawn.</p>
        <p class="buy-credits-status" data-buy="status" role="status"></p>
        <div class="buy-credits-actions">
          <button type="button" class="action place" data-buy="pay">Pay</button>
          <a class="action secondary buy-credits-nearly" data-buy="nearly" target="_blank" rel="noopener noreferrer" hidden>Buy on NEARLY ↗</a>
        </div>
      </div>
    </div>
  `;

  const sheet = host.querySelector<HTMLElement>(".buy-credits-sheet")!;
  const qtyInput = host.querySelector<HTMLInputElement>("#buy-credits-qty")!;
  const lines = host.querySelector<HTMLElement>("[data-buy=lines]")!;
  const totalEl = host.querySelector<HTMLElement>("[data-buy=total]")!;
  const statusEl = host.querySelector<HTMLElement>("[data-buy=status]")!;
  const priceEl = host.querySelector<HTMLElement>("[data-buy=price]")!;
  const balanceEl = host.querySelector<HTMLElement>("[data-buy=balance]")!;
  const noteEl = host.querySelector<HTMLElement>("[data-buy=note]")!;
  const payButton = host.querySelector<HTMLButtonElement>("[data-buy=pay]")!;
  const nearly = host.querySelector<HTMLAnchorElement>("[data-buy=nearly]")!;
  const tokenOption = host.querySelector<HTMLElement>("[data-buy=token-option]")!;
  const tokenLabel = host.querySelector<HTMLElement>("[data-buy=token-label]")!;
  const closeButton = host.querySelector<HTMLButtonElement>(".buy-credits-close")!;

  nearly.href = NEARLY_MPOO_URL;

  let disposed = false;
  let paidBoardVisible = false;
  let load: LoadState = { status: "idle" };
  let lastCredits: bigint | null | undefined = undefined;
  let buying = false;
  let generation = 0;

  function asset(): PayAsset {
    if (!TOKEN_PAYMENTS_ENABLED) return "near";
    const checked = host.querySelector<HTMLInputElement>('input[name="buy-asset"]:checked');
    return checked?.value === "token" ? "token" : "near";
  }

  function quantity(): number {
    const value = Number(qtyInput.value);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function renderQuote(): void {
    if (load.status !== "ready") {
      lines.replaceChildren();
      totalEl.textContent = "";
      payButton.disabled = true;
      return;
    }
    let quote: BuyQuote;
    try {
      quote = quoteBuyCredits({
        config: load.config,
        quantity: quantity(),
        asset: asset(),
        creditsBalance: load.credits,
        network: PAGE_NETWORK,
        tokenDecimals: load.tokenDecimals,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not price this purchase.");
      payButton.disabled = true;
      return;
    }
    lines.replaceChildren();
    for (const item of quote.lineItems) {
      const li = document.createElement("li");
      li.textContent = `${item.label} · ${item.amountLabel}`;
      lines.append(li);
    }
    if (quote.asset === "near") {
      totalEl.textContent = `Total attached · ${formatUnits(quote.totalNearAttached, 24)} NEAR (plus network gas)`;
      payButton.textContent = `Pay ${formatUnits(quote.purchaseAmount, 24)} NEAR`;
      nearly.hidden = true;
    } else {
      totalEl.textContent =
        quote.registrationDeposit
          ? `Token amount · ${formatUnits(quote.purchaseAmount, load.tokenDecimals)} ${quote.tokenLabel} + ${formatUnits(quote.registrationDeposit, 24)} NEAR setup (plus gas)`
          : `Token amount · ${formatUnits(quote.purchaseAmount, load.tokenDecimals)} ${quote.tokenLabel} (plus gas)`;
      payButton.textContent = `Pay with ${quote.tokenLabel}`;
      nearly.hidden = PAGE_NETWORK !== "mainnet";
    }
    payButton.disabled = buying;
    noteEl.textContent =
      "Credits are prepaid paint still owed on the board. They cannot be withdrawn.";
  }

  async function refreshConfig(): Promise<void> {
    const current = ++generation;
    load = { status: "loading" };
    priceEl.textContent = "Reading price…";
    setStatus("Refreshing prices…");
    payButton.disabled = true;
    try {
      const raw = await viewFunction<Record<string, unknown>>("get_payment_config");
      const config = parsePaymentConfig(raw);
      const session = services.wallet.getSession();
      let credits: bigint | null = null;
      if (session.accountId) {
        const balance = await viewFunction<string | number | null>("get_credits", {
          account_id: session.accountId,
        });
        credits = balance === null ? null : BigInt(balance);
      } else {
        credits = null;
      }
      let tokenDecimals = 18;
      try {
        tokenDecimals = await readTokenDecimals(config.mpooToken);
      } catch {
        tokenDecimals = 18;
      }
      if (disposed || current !== generation) {
        return;
      }
      load = { status: "ready", config, credits, tokenDecimals };
      lastCredits = session.accountId ? credits : undefined;
      balanceEl.textContent = session.accountId
        ? creditLabel(credits)
        : "Credits: connect wallet to buy";
      priceEl.textContent = TOKEN_PAYMENTS_ENABLED
        ? `${formatUnits(config.nearPerCredit, 24)} NEAR / credit · ${formatUnits(config.mpooPerCredit, tokenDecimals)} ${PAGE_NETWORK === "mainnet" ? "mPOO" : "test token"} / credit`
        : `${formatUnits(config.nearPerCredit, 24)} NEAR / credit`;
      tokenLabel.textContent = PAGE_NETWORK === "mainnet" ? "mPOO" : "test token";
      // Launch sells credits for NEAR only, so the token radio stays out of reach
      // rather than offering a path whose exchange rate is still undecided.
      tokenOption.hidden = !TOKEN_PAYMENTS_ENABLED;
      setStatus("");
      renderQuote();
      options.onCreditsChanged?.(session.accountId ? credits : null);
    } catch (error) {
      if (disposed || current !== generation) {
        return;
      }
      load = {
        status: "error",
        message: error instanceof Error ? error.message : "Price unavailable",
      };
      priceEl.textContent = "Price unavailable — retry";
      setStatus("Could not read payment config. Close and try again.");
      payButton.disabled = true;
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
    let quote: BuyQuote;
    try {
      quote = quoteBuyCredits({
        config: load.config,
        quantity: quantity(),
        asset: asset(),
        creditsBalance: load.credits,
        network: PAGE_NETWORK,
        tokenDecimals: load.tokenDecimals,
      });
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
      setStatus(result.message);
      lastCredits = result.creditsAfter;
      balanceEl.textContent = creditLabel(result.creditsAfter);
      options.onCreditsChanged?.(result.creditsAfter);
      await refreshConfig();
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
    // Rejected / failed: keep the pre-purchase balance on screen.
    balanceEl.textContent = creditLabel(result.creditsAfter ?? load.credits);
    setStatus(`${result.title}. ${result.message}`);
    payButton.disabled = false;
    renderQuote();
  }

  function open(opts?: { quantity?: number }): void {
    if (!paidBoardVisible) {
      return;
    }
    if (opts?.quantity && Number.isInteger(opts.quantity) && opts.quantity > 0) {
      qtyInput.value = String(opts.quantity);
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
  host.querySelector("[data-buy=dec]")!.addEventListener("click", () => {
    qtyInput.value = String(Math.max(1, quantity() - 1));
    renderQuote();
  });
  host.querySelector("[data-buy=inc]")!.addEventListener("click", () => {
    qtyInput.value = String(quantity() + 1);
    renderQuote();
  });
  qtyInput.addEventListener("input", () => renderQuote());
  for (const radio of host.querySelectorAll<HTMLInputElement>('input[name="buy-asset"]')) {
    radio.addEventListener("change", () => renderQuote());
  }
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
      lastCredits = balance;
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
      unsubWallet();
      window.removeEventListener("keydown", onKey);
      host.replaceChildren();
    },
  };
}

async function readTokenDecimals(tokenId: string): Promise<number> {
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
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(response.result))) as {
    decimals?: number;
  };
  if (!Number.isInteger(meta.decimals) || (meta.decimals as number) < 0) {
    throw new Error("Invalid decimals");
  }
  return meta.decimals as number;
}
