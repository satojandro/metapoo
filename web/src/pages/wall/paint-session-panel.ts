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
import { clearBlock, fillBlock, fillDismissibleBlock, type UiPhase } from "./wall-view";
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
  paintRenew: HTMLElement;
  renewPaintButton: HTMLButtonElement;
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
  /** The chain refused the current key for its allowance: offer a new key in the dock. */
  promptKeyRenewal(): void;
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
    paintRenew,
    renewPaintButton,
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
  // Which key ran low, not a flag: any new key, a forgotten key or another account
  // ends the prompt with nothing to reset.
  let lowKey: string | null = null;
  const renewalNeeded = (): boolean =>
    lowKey !== null && loadDrawingSessionRecord()?.publicKey === lowKey;

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

  scope.listen(renewPaintButton, "click", () => {
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
    renewPaintButton.disabled = true;
    const renewing = renewalNeeded();
    try {
      if (!scope.walletAccount()) await services.wallet.connect();
      const authorize = services.wallet.authorizeDrawingSession;
      if (!authorize) throw new Error("Drawing sessions are not available in this build.");
      const authorization = await authorize(renewing ? { replacePublicKey: lowKey } : undefined);
      deps.setFlow(deps.selected() ? "editing" : "connected");
      if (!authorization.confirmed) {
        fillBlock(
          result,
          "Approval submitted",
          "The key is on chain but not readable from this RPC yet. Painting will pick it up on the next refresh.",
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown wallet error";
      deps.setFlow("failed");
      if (walletError) {
        fillDismissibleBlock(
          walletError,
          "Drawing session was not authorized",
          `${renewing ? "Your current key is still low, so painting stays paused until a new one is approved." : "Ordinary wallet approval still works for each draw."} ${detail} (build ${__BUILD_ID__})`,
        );
      }
    } finally {
      unlockPaintButton.disabled = false;
      renewPaintButton.disabled = false;
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
      : "Choose a square, then Paint this tile.";

    paintUnlock.hidden = !(
      connected &&
      !allowed &&
      deps.contractMetaOk() &&
      isContractConfigured()
    );
    const renew = allowed && renewalNeeded();
    paintRenew.hidden = !renew;
    tapToPaintAffordance.hidden = !allowed;
    tapToPaintAnnouncement.hidden = !allowed;

    // "Place paint" and "Direct paint is on" are two instructions for the same
    // act. While painting is armed the button is redundant — clicking a cell
    // already places the paint — so it steps aside instead of contradicting the
    // status line. It returns the moment painting is not armed, which is when it
    // is the only pointer path. Enter still places either way (board keydown).
    drawButton.hidden = allowed && tapToPaintEnabled;

    // A one-approval unlock that vanishes instantly reads as "did it work?", but a
    // permanent line is clutter. It confirms, then fades (wall-page.css); revoking
    // lives under About / details.
    paintUnlocked.hidden = !allowed || renew;
    paintUnlocked.textContent = allowed && !renew ? "Painting unlocked. No wallet popup per tile." : "";

    tapToPaintAnnouncement.textContent = !allowed
      ? ""
      : renew
        ? "Your painting key needs renewing."
        : tapToPaintEnabled
        ? "Drag to paint is on. Drag or click to paint. To move the board, hold space, use two fingers, or the middle mouse button."
        : "Choose a square, then Paint this tile.";
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
      "Renewal: when the key runs low, the dock replaces it with a new limited key in one approval.",
      "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
      `Build ${__BUILD_ID__}.`,
    ].join(" ");

    const canUseContract = isContractConfigured();
    const sessionActive = status.phase === "active";
    authorizeSessionButton.disabled = !canUseContract || (sessionActive && !renewalNeeded());
    forgetSessionButton.disabled =
      status.record === null || status.phase === "forgotten_locally";
    revokeSessionButton.disabled = !sessionActive || !walletAccount;
    updateDirectPaintAvailability();

    // A stale error must never outlive a good state: the block floats over the page.
    if (sessionActive) {
      const stale = walletErrorHost();
      if (stale) clearBlock(stale);
    }
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
        info.wildcard
          ? `This wallet added a key for ANY method on ${CONTRACT_ID}, not just painting — it can also spend credits or claim TOILET from this browser. Revoke it when you are done.`
          : "",
        "Forget clears this browser only. Revoke on-chain asks the wallet to DeleteKey.",
      ].filter(Boolean).join(" ");
    } catch {
      // Keep the static note if the live query fails.
    }
  }

  return {
    tapToPaintEnabled: () => tapToPaintEnabled,
    showDrawingSession,
    updateDirectPaintAvailability,
    promptKeyRenewal() {
      lowKey = loadDrawingSessionRecord()?.publicKey ?? null;
      showDrawingSession();
    },
  };
}
