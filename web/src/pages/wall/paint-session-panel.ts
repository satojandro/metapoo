import type { AppServices } from "../../app/services";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import { isContractConfigured } from "../../contract";
import {
  describeDrawingSession,
  forgetDrawingSessionLocally,
  formatAllowanceNear,
  loadDrawingSessionRecord,
} from "../../drawing-session";
import { canUseLocalDrawingSession, fetchDrawingSessionAllowance } from "../../local-draw";
import type { Cell } from "../../selection";
import { revokeDrawingSessionKeyOnChain } from "../../wallet";
import { clearBlock, fillBlock, type UiPhase } from "./wall-view";
import type { WallScope } from "./wall-scope";

/** The paint dock's session and Direct paint controls. */
export interface PaintSessionDom {
  drawButton: HTMLButtonElement;
  result: HTMLElement;
  directPaintToggle: HTMLInputElement;
  tapToPaintAffordance: HTMLElement;
  tapToPaintAnnouncement: HTMLElement;
  paintUnlock: HTMLElement;
  paintUnlocked: HTMLElement;
  unlockPaintButton: HTMLButtonElement;
  authorizeSessionButton: HTMLButtonElement;
  forgetSessionButton: HTMLButtonElement;
  revokeSessionButton: HTMLButtonElement;
  drawingSessionStatus: HTMLElement;
  drawingSessionNote: HTMLElement;
}

export interface PaintSessionPanelDeps extends PaintSessionDom {
  scope: WallScope;
  services: AppServices;
  contractMetaOk(): boolean;
  selected(): Cell | null;
  setFlow(phase: UiPhase): void;
}

export interface PaintSessionPanel {
  /** Direct paint is allowed and the user has not turned it off. */
  tapToPaintEnabled(): boolean;
  showDrawingSession(): void;
  updateDirectPaintAvailability(): void;
}

/**
 * Part of the paint controller, kept in its own file for size: the drawing
 * session panel (authorise, forget, revoke, live allowance) and the Direct
 * paint consent it gates. Only `paint-controller.ts` creates one.
 */
export function createPaintSessionPanel(deps: PaintSessionPanelDeps): PaintSessionPanel {
  const {
    scope,
    services,
    drawButton,
    result,
    directPaintToggle,
    tapToPaintAffordance,
    tapToPaintAnnouncement,
    paintUnlock,
    paintUnlocked,
    unlockPaintButton,
    authorizeSessionButton,
    forgetSessionButton,
    revokeSessionButton,
    drawingSessionStatus,
    drawingSessionNote,
  } = deps;

  let tapToPaintEnabled = directPaintToggle.checked;
  // Direct paint is a pre-approval, not a second permission: once a drawing
  // session exists, clicking a square should just paint (Berry Club flow).
  // `null` = follow the session; a boolean = the user has decided.
  let tapToPaintUserChoice: boolean | null = null;

  scope.listen(authorizeSessionButton, "click", () => {
    void onAuthorizeSessionClick();
  });

  scope.listen(forgetSessionButton, "click", () => {
    forgetDrawingSessionLocally();
    showDrawingSession();
  });

  scope.listen(revokeSessionButton, "click", () => {
    void onRevokeSessionClick();
  });

  scope.listen(directPaintToggle, "change", () => {
    tapToPaintUserChoice = directPaintToggle.checked;
    updateDirectPaintAvailability();
  });

  scope.listen(unlockPaintButton, "click", () => {
    void onAuthorizeSessionClick();
  });

  function walletErrorHost(): HTMLElement | null {
    return document.querySelector<HTMLElement>("#wallet-error");
  }

  /**
   * Re-run connect with addFunctionCallKey while already signed in (or when the
   * checkbox path was skipped). Ordinary Connect remains available as fallback
   * on the shell wallet chrome.
   */
  async function onAuthorizeSessionClick(): Promise<void> {
    if (scope.isDisposed()) return;
    const walletError = walletErrorHost();
    if (walletError) clearBlock(walletError);
    if (!isContractConfigured()) {
      if (walletError) {
        fillBlock(
          walletError,
          "Drawing session unavailable",
          "Set VITE_CONTRACT_ID before authorizing a drawing session.",
        );
      }
      return;
    }
    authorizeSessionButton.disabled = true;
    unlockPaintButton.disabled = true;
    try {
      await services.wallet.connect({ authorizeDrawingSession: true });
      deps.setFlow(deps.selected() ? "editing" : "connected");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown wallet error";
      deps.setFlow("failed");
      if (walletError) {
        fillBlock(
          walletError,
          "Drawing session was not authorized",
          `Ordinary wallet approval still works for each draw. ${detail}`,
        );
      }
    } finally {
      unlockPaintButton.disabled = false;
      showDrawingSession();
    }
  }

  async function onRevokeSessionClick(): Promise<void> {
    const walletError = walletErrorHost();
    if (walletError) clearBlock(walletError);
    const record = loadDrawingSessionRecord();
    if (!record?.publicKey) {
      if (walletError) fillBlock(
        walletError,
        "Nothing to revoke",
        "No experimental drawing-session public key is stored in this browser.",
      );
      return;
    }
    revokeSessionButton.disabled = true;
    try {
      await revokeDrawingSessionKeyOnChain(record.publicKey);
      forgetDrawingSessionLocally();
      fillBlock(
        result,
        "Revoke submitted",
        "The wallet was asked to delete the drawing-session access key on chain. Confirm in the explorer or account keys list. This browser session was cleared.",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown wallet error";
      if (walletError) {
        fillBlock(
          walletError,
          "On-chain revoke did not complete",
          `The key may still exist on chain. ${detail}`,
        );
      }
    } finally {
      showDrawingSession();
    }
  }

  function updateDirectPaintAvailability(): void {
    const walletAccount = scope.walletAccount();
    const allowed =
      canUseLocalDrawingSession(walletAccount, scope.walletNetwork()) && deps.contractMetaOk();
    const connected = walletAccount !== null;

    // A disabled checkbox is not an explanation. With no session there is
    // nothing to toggle, so the toggle is hidden and the dock offers the single
    // approval that turns painting on. With a session, Direct paint is on by
    // default unless the user has explicitly turned it off.
    tapToPaintEnabled = allowed && (tapToPaintUserChoice ?? true);
    directPaintToggle.checked = tapToPaintEnabled;
    directPaintToggle.disabled = false;
    directPaintToggle.title = tapToPaintEnabled
      ? "Drag to paint is on: click a square to paint it, with no wallet popup."
      : "Choose a square, then press Place paint.";

    paintUnlock.hidden = !(
      connected &&
      !allowed &&
      deps.contractMetaOk() &&
      isContractConfigured()
    );
    tapToPaintAffordance.hidden = !allowed;
    tapToPaintAnnouncement.hidden = !allowed;

    // "Place paint" and "Direct paint is on" are two instructions for the same
    // act. While painting is armed the button is redundant — clicking a cell
    // already places the paint — so it steps aside instead of contradicting the
    // status line. It returns the moment painting is not armed, which is when it
    // is the only pointer path. Enter still places either way (board keydown).
    drawButton.hidden = allowed && tapToPaintEnabled;

    // A one-approval unlock that vanishes after use reads as "did it work?".
    // Keep a quiet, permanent line while the session is live.
    paintUnlocked.hidden = !allowed;
    paintUnlocked.textContent = allowed
      ? "Painting unlocked this browser. No wallet popup per pixel. Revoke it any time under About / details."
      : "";

    tapToPaintAnnouncement.textContent = !allowed
      ? ""
      : tapToPaintEnabled
        ? "Drag to paint is on. Drag or click to paint. To move the board, hold space, use two fingers, or the middle mouse button."
        : "Choose a square, then press Place paint.";
  }

  /**
   * Experimental drawing-session panel. Uses textContent only.
   */
  function showDrawingSession(): void {
    const walletAccount = scope.walletAccount();
    const walletNetwork = scope.walletNetwork();
    const status = describeDrawingSession({
      contractId: CONTRACT_ID,
      accountId: walletAccount,
      networkId: walletNetwork,
      record: loadDrawingSessionRecord(),
    });
    drawingSessionStatus.textContent = `${status.title}. ${status.message}`;
    drawingSessionNote.textContent = [
      `Configured allowance for a new session: ${status.allowanceLabel}.`,
      "Renewal: authorize again to request a new limited key (old on-chain keys are not auto-removed).",
      "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
    ].join(" ");

    const canUseContract = isContractConfigured();
    const sessionActive = status.phase === "active";
    authorizeSessionButton.disabled = !canUseContract || sessionActive;
    forgetSessionButton.disabled =
      status.record === null || status.phase === "forgotten_locally";
    revokeSessionButton.disabled = !sessionActive || !walletAccount;
    updateDirectPaintAvailability();

    if (sessionActive && walletAccount) {
      void refreshAllowanceNote(walletAccount, walletNetwork ?? PAGE_NETWORK);
    }
  }

  async function refreshAllowanceNote(
    accountId: string,
    networkId: string,
  ): Promise<void> {
    try {
      const info = await fetchDrawingSessionAllowance({ accountId, networkId });
      if (!info.found) {
        drawingSessionNote.textContent = `${drawingSessionNote.textContent} Live key check: not found on account — authorize again.`;
        return;
      }
      const remaining =
        info.remainingYocto === null
          ? "unlimited or unknown"
          : formatAllowanceNear(info.remainingYocto);
      drawingSessionNote.textContent = [
        `Live remaining allowance: ${remaining}.`,
        info.permissionSummary,
        "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
      ].join(" ");
    } catch {
      // Keep the static note if the live query fails.
    }
  }

  return {
    tapToPaintEnabled: () => tapToPaintEnabled,
    showDrawingSession,
    updateDirectPaintAvailability,
  };
}
