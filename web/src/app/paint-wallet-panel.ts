import { mountWithdrawalControls } from "./withdrawal-controls";
import { TOKEN_PAYMENTS_ENABLED } from "../payment-flags";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL, INTENTS_FUNDING_ENABLED, RHEA_MPOO_SWAP_ENABLED } from "../config";
import {
  BUY_NEAR_URL,
  createReadRpc,
  loadPaintWallet,
  NEARLY_MPOO_URL,
  type PaintWalletSnapshot,
} from "../paint-wallet";
import type { AppServices } from "./services";

type Loader = (account: string | null, signal: AbortSignal) => Promise<PaintWalletSnapshot>;
/** Each refresh replaces the previous request, so an old account cannot repaint the panel. */
export function mountPaintWalletPanel(host: HTMLElement, services: AppServices,
  load: Loader = (account, signal) => loadPaintWallet(createReadRpc(RPC_URL, signal), CONTRACT_ID, PAGE_NETWORK, account),
  network: string = PAGE_NETWORK,
): () => void {
  const showTokenPath = TOKEN_PAYMENTS_ENABLED;
  host.innerHTML = `<h2>Paint &amp; balances</h2>
    <dl class="paint-wallet-values">
      <div><dt>Price per pixel</dt><dd data-value="price"></dd></div>
      <div><dt>Paint pixels available</dt><dd data-value="credits"></dd></div>
      <div><dt>NEAR available · before gas</dt><dd data-value="near"></dd></div>
      <div data-row="mpoo"${showTokenPath ? "" : " hidden"}><dt>mPOO in wallet</dt><dd data-value="mpoo"></dd></div>
    </dl>
    <p data-value="note"></p><p class="paint-wallet-status" role="status"></p>
    <button type="button" class="action secondary paint-wallet-refresh">Refresh balances</button>
    <a class="action paint-wallet-buy" data-buy-cta target="_blank" rel="noopener noreferrer"></a>
    <p class="paint-wallet-market-note"></p>`;
  const buy = host.querySelector<HTMLAnchorElement>("[data-buy-cta]")!;
  const marketNote = host.querySelector<HTMLElement>(".paint-wallet-market-note")!;
  if (showTokenPath) {
    buy.href = NEARLY_MPOO_URL;
    buy.textContent = "Buy mPOO on NEARLY ↗";
    marketNote.textContent = network === "mainnet"
      ? "Opens the mPOO market in a new tab. Return here to refresh your balance."
      : "External mainnet market. Real mPOO bought there cannot fund testnet paint credits.";
  } else {
    buy.href = BUY_NEAR_URL;
    buy.textContent = "Buy NEAR ↗";
    marketNote.textContent =
      "Credits are bought with NEAR on this board. Opens near.com to get NEAR from other chains.";
  }
  const status = host.querySelector<HTMLElement>(".paint-wallet-status")!;
  const button = host.querySelector<HTMLButtonElement>(".paint-wallet-refresh")!;
  let generation = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  function display(key: keyof PaintWalletSnapshot, text: string): void {
    const el = host.querySelector<HTMLElement>(`[data-value="${key}"]`);
    if (el) el.textContent = text;
  }
  async function refresh(): Promise<void> {
    if (disposed) return;
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const session = services.wallet.getSession();
    const keys = (showTokenPath
      ? ["price", "credits", "near", "mpoo"]
      : ["price", "credits", "near"]) as Array<keyof PaintWalletSnapshot>;
    for (const key of keys) display(key, "Loading…");
    display("note", "Refreshing balances…");
    if (session.accountId && session.networkId !== network) {
      for (const key of keys) display(key, "Switch wallet network to view");
      status.textContent = `This app is using ${network}.`;
      return;
    }
    status.textContent = "Refreshing…";
    // Timeout includes all dependent RPC calls, not just the first fetch.
    const request = controller;
    const timeout = window.setTimeout(() => request.abort(), 15_000);
    try {
      const snapshot = await load(session.accountId, request.signal);
      if (disposed || generation !== current) return;
      for (const key of Object.keys(snapshot) as (keyof PaintWalletSnapshot)[]) {
        if (!showTokenPath && key === "mpoo") continue;
        display(key, snapshot[key]);
      }
      status.textContent = Object.values(snapshot).some(value => /unavailable|retry/i.test(value))
        ? "Some information is unavailable. Retry to refresh."
        : `Updated ${new Date().toLocaleTimeString()}`;
    } catch {
      if (disposed || generation !== current) return;
      for (const key of keys) display(key, "Unavailable — retry");
      status.textContent = "Could not refresh balances. Please retry.";
    } finally { window.clearTimeout(timeout); }
  }
  const refreshNow = (): void => { void refresh(); };
  const focus = (): void => { if (document.visibilityState !== "hidden") refreshNow(); };
  button.addEventListener("click", refreshNow);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", focus);
  const unsubscribe = services.wallet.subscribe(refreshNow);
  let lastOperations = "";
  const unsubscribeOps = services.operations.subscribe(ops => {
    const signature = ops.map(op => `${op.id}:${op.phase}:${op.updatedAtMs}`).join("|");
    if (signature !== lastOperations) { lastOperations = signature; refreshNow(); }
  });
  // Refresh visible data periodically, including paints submitted outside the operations store.
  const timer = window.setInterval(focus, 30_000);
  let disposeAcquisition: (() => void) | undefined;
  const hasRecovery = (() => { try { return Object.keys(window.localStorage).some(key => key.startsWith("metapoo:acquisition:v1:")); } catch { return false; } })();
  let disposeDialog: (() => void) | undefined;
  if (INTENTS_FUNDING_ENABLED || RHEA_MPOO_SWAP_ENABLED || hasRecovery) {
    // The funding flow lives in its own dialog, not inline in the wallet dropdown: it is a
    // multi-step payment, and the dropdown is already long. Mounted on first open, so the
    // wallet session has normally restored by then.
    const open = document.createElement("button");
    open.type = "button";
    open.className = "action paint-wallet-add-funds";
    open.textContent = hasRecovery && !INTENTS_FUNDING_ENABLED ? "Track a funding payment" : "Add funds from another chain";
    buy.before(open);
    const dialog = document.createElement("dialog");
    dialog.className = "mp-funding-dialog";
    dialog.setAttribute("aria-labelledby", "mp-funding-title");
    dialog.innerHTML = `<div class="mp-funding-head"><h2 id="mp-funding-title">Add funds</h2>
      <button type="button" class="mp-funding-close" aria-label="Close">×</button></div>
      <div class="mp-funding-body"></div>`;
    document.body.append(dialog);
    const body = dialog.querySelector<HTMLElement>(".mp-funding-body")!;
    let mounted = false;
    const close = () => { if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); };
    const onOpen = () => {
      host.closest("details")?.removeAttribute("open");
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
      if (mounted) return;
      mounted = true;
      void import("./acquisition-panel").then(({ mountAcquisitionPanel }) => {
        if (!disposed) disposeAcquisition = mountAcquisitionPanel(body, services, refreshNow);
      }).catch(() => {
        mounted = false;
        if (!disposed) body.textContent = "Funding controls could not load. Your existing wallet and credits remain available.";
      });
    };
    // A click on the backdrop lands on the dialog element itself.
    const onBackdrop = (event: MouseEvent) => { if (event.target === dialog) close(); };
    open.addEventListener("click", onOpen);
    dialog.querySelector(".mp-funding-close")!.addEventListener("click", close);
    dialog.addEventListener("click", onBackdrop);
    disposeDialog = () => { open.removeEventListener("click", onOpen); dialog.removeEventListener("click", onBackdrop); close(); dialog.remove(); open.remove(); };
  }
  const disposeWithdrawals = mountWithdrawalControls(host, services, refreshNow);
  refreshNow();
  return () => {
    disposeWithdrawals();
    disposeAcquisition?.();
    disposeDialog?.();
    disposed = true; generation++; controller?.abort(); unsubscribe(); unsubscribeOps();
    window.clearInterval(timer); button.removeEventListener("click", refreshNow);
    window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus);
  };
}
