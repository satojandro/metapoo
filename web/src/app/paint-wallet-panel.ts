import { TOKEN_PAYMENTS_ENABLED } from "../payment-flags";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
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
      "Credits are bought with NEAR on this board. Opens near.org to get NEAR from other chains.";
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
  refreshNow();
  return () => {
    disposed = true; generation++; controller?.abort(); unsubscribe(); unsubscribeOps();
    window.clearInterval(timer); button.removeEventListener("click", refreshNow);
    window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus);
  };
}
