/**
 * Global wallet + operations chrome. Mounted once on the shell;
 * survives route changes so broadcast ops stay visible.
 */

import { CONTRACT_ID, PAGE_NETWORK } from "../config";
import { isContractConfigured } from "../contract";
import { listRecoverableAcquisitions } from "../integrations/operation-store";
import { describeNetwork } from "../network";
import type { AppServices } from "./services";
import type { OperationRecord } from "./operations";

export interface WalletChromeDispose {
  (): void;
}

/**
 * Wire the shell wallet region. Expects markup with:
 * #wallet-summary, #network-summary, #connect-button, #wallet-error,
 * #authorize-drawing-session (optional), #ops-recovery
 */
export function mountWalletChrome(
  root: HTMLElement,
  services: AppServices,
): WalletChromeDispose {
  const walletSummary = mustChild<HTMLElement>(root, "#wallet-summary");
  const networkSummary = mustChild<HTMLElement>(root, "#network-summary");
  const connectButton = mustChild<HTMLButtonElement>(root, "#connect-button");
  const walletError = mustChild<HTMLElement>(root, "#wallet-error");
  const opsRecovery = root.querySelector<HTMLElement>("#ops-recovery");
  const authorizeDrawingSession = root.querySelector<HTMLInputElement>(
    "#authorize-drawing-session",
  );

  const cleanups: Array<() => void> = [];
  const walletDetails = root.querySelector<HTMLDetailsElement>(
    "details.wallet-details",
  );
  const walletSummaryToggle = walletDetails?.querySelector("summary") ?? null;
  let recoverableOps = 0;

  /**
   * One wallet control in the header. Disconnected: a Connect button. Connected:
   * the account name opens the wallet panel, and Disconnect lives inside it. The
   * panel also shows while a broadcast operation is still recoverable, connected
   * or not. The drawing-key opt-in is not in the header: it stays in the wallet
   * panel, and the wall page shows it in its paint dock while disconnected.
   */
  function placeWalletControls(connectedAccount: string | null): void {
    if (!walletDetails) return;
    let savedAcquisitions = 0;
    try {
      savedAcquisitions = listRecoverableAcquisitions(
        window.localStorage,
      ).length;
    } catch {
      /* Read-only wallet still works if storage is blocked. */
    }
    const showPanel =
      connectedAccount !== null || recoverableOps > 0 || savedAcquisitions > 0;
    walletDetails.hidden = !showPanel;
    if (!showPanel) walletDetails.open = false;
    if (walletSummaryToggle) {
      walletSummaryToggle.textContent = connectedAccount ?? "Wallet";
      walletSummaryToggle.title = connectedAccount ?? "";
    }
    if (connectedAccount) {
      walletDetails.append(connectButton);
    } else {
      walletDetails.before(connectButton);
    }
  }

  function showWallet(): void {
    const session = services.wallet.getSession();
    if (session.accountId) {
      walletSummary.textContent = `Connected account: ${session.accountId}. Contract: ${
        CONTRACT_ID || "not configured"
      }.`;
      connectButton.textContent = "Disconnect wallet";
    } else {
      walletSummary.textContent = `Not connected. You can still browse. Contract: ${
        CONTRACT_ID || "not configured"
      }.`;
      connectButton.textContent = "Connect wallet";
    }
    placeWalletControls(session.accountId);
    const notice = describeNetwork(
      session.accountId ? session.networkId : null,
    );
    networkSummary.textContent = notice.message;
    if (authorizeDrawingSession) {
      authorizeDrawingSession.disabled =
        !isContractConfigured() || session.accountId !== null;
      authorizeDrawingSession.title = isContractConfigured()
        ? "Ask the wallet for a draw-only function-call key during Connect"
        : "Configure VITE_CONTRACT_ID first";
    }
  }

  function showOps(ops: readonly OperationRecord[]): void {
    if (!opsRecovery) {
      return;
    }
    const recoverable = ops.filter(
      (op) =>
        op.phase === "awaiting_signature" ||
        op.phase === "submitted" ||
        op.phase === "confirmation_delayed",
    );
    recoverableOps = recoverable.length;
    placeWalletControls(services.wallet.getSession().accountId);
    opsRecovery.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Operations";
    opsRecovery.append(heading);
    if (recoverable.length === 0) {
      const empty = document.createElement("p");
      empty.textContent =
        "No in-flight wallet operations. Leaving a page does not drop a broadcast transaction.";
      opsRecovery.append(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "ops-list";
    for (const op of recoverable) {
      const item = document.createElement("li");
      item.textContent = `${op.title} — ${op.phase}${
        op.transactionId ? ` · tx ${op.transactionId}` : ""
      }. ${op.detail}`;
      list.append(item);
    }
    opsRecovery.append(list);
  }

  const onConnect = (): void => {
    void (async () => {
      walletError.replaceChildren();
      connectButton.disabled = true;
      try {
        const session = services.wallet.getSession();
        if (session.accountId) {
          await services.wallet.disconnect();
        } else {
          const wantSession =
            Boolean(authorizeDrawingSession?.checked) && isContractConfigured();
          // Connect first, then add the draw-only key as its own transaction: the
          // permission has to be ours, not something the wallet fills in during sign-in.
          await services.wallet.connect();
          if (wantSession) await services.wallet.authorizeDrawingSession?.();
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Unknown wallet error";
        fillBlock(
          walletError,
          "Wallet was not connected",
          `You can keep browsing. ${detail}`,
        );
      } finally {
        connectButton.disabled = false;
        showWallet();
      }
    })();
  };

  connectButton.addEventListener("click", onConnect);
  cleanups.push(() => connectButton.removeEventListener("click", onConnect));

  cleanups.push(services.wallet.subscribe(() => showWallet()));
  cleanups.push(services.operations.subscribe(showOps));

  const refreshAcquisitions = () => showWallet();
  window.addEventListener("metapoo:acquisition-change", refreshAcquisitions);
  window.addEventListener("storage", refreshAcquisitions);
  cleanups.push(() =>
    window.removeEventListener(
      "metapoo:acquisition-change",
      refreshAcquisitions,
    ),
  );
  cleanups.push(() =>
    window.removeEventListener("storage", refreshAcquisitions),
  );
  showWallet();

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function mustChild<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Wallet chrome is missing required element ${selector}.`);
  }
  return element;
}

function fillBlock(host: HTMLElement, title: string, message: string): void {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  host.append(heading, paragraph);
}

export function networkLabel(): string {
  return isContractConfigured() ? PAGE_NETWORK : "mock";
}
