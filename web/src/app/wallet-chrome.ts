/**
 * Global wallet + operations chrome. Mounted once on the shell;
 * survives route changes so broadcast ops stay visible.
 */

import { CONTRACT_ID, PAGE_NETWORK } from "../config";
import { isContractConfigured } from "../contract";
import { listRecoverableAcquisitions } from "../integrations/operation-store";
import { describeNetwork } from "../network";
import { shortAccount } from "../shared/short-account";
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

  const accountSection = root.querySelector<HTMLElement>("#wallet-account");
  const accountId = accountSection?.querySelector<HTMLElement>("[data-account-id]") ?? null;
  const accountCopy = accountSection?.querySelector<HTMLButtonElement>(".wallet-account-copy") ?? null;
  const accountNote = accountSection?.querySelector<HTMLElement>(".wallet-account-note") ?? null;

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
      walletSummaryToggle.textContent = connectedAccount
        ? shortAccount(connectedAccount)
        : "Wallet";
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
    // Technical details holds identifiers for support, short like everywhere else; the
    // full account id lives in the copy button's clipboard payload and its title.
    const contract = shortAccount(CONTRACT_ID) || "not configured";
    walletSummary.textContent = session.accountId
      ? `Account ${shortAccount(session.accountId)} · contract ${contract}`
      : `Not connected · contract ${contract}`;
    connectButton.textContent = session.accountId ? "Disconnect" : "Connect wallet";
    placeWalletControls(session.accountId);
    showAccount(session.accountId);
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

  /** Short id, full id in the title: a 64-character implicit id does not fit the header. */
  function showAccount(account: string | null): void {
    if (!accountSection || !accountId) return;
    accountSection.hidden = account === null;
    const shown = account === null ? "" : shortAccount(account);
    if (accountId.textContent !== shown) {
      accountId.textContent = shown;
      accountId.title = account ?? "";
      if (accountNote) accountNote.textContent = "";
    }
  }

  const onCopyAccount = (): void => {
    const { accountId: account, networkId } = services.wallet.getSession();
    if (!account || !accountNote) return;
    const copied = () => {
      accountNote.textContent = `Address copied. Send only NEAR on NEAR ${networkId} to it.`;
    };
    // No on-screen copy of the full id to fall back to selecting: point at the wallet instead
    // of telling the player to copy a shortened address.
    const fallback = () => {
      accountNote.textContent = "Copy was blocked. Copy the address from your wallet app.";
    };
    try {
      void navigator.clipboard.writeText(account).then(copied, fallback);
    } catch {
      fallback();
    }
  };
  if (accountCopy) {
    accountCopy.addEventListener("click", onCopyAccount);
    cleanups.push(() => accountCopy.removeEventListener("click", onCopyAccount));
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
    // Nothing in flight is the normal state: say nothing rather than print a "nothing here"
    // block above Technical details.
    opsRecovery.hidden = recoverable.length === 0;
    if (recoverable.length === 0) return;
    const heading = document.createElement("h2");
    heading.textContent = "Operations";
    opsRecovery.append(heading);
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
