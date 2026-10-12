import { explorerUrl } from "@shared/board-rules.ts";
import type { NetworkId, PixelView } from "@shared/types.ts";
import {
  CONTRACT_ID,
  DRAW_DEPOSIT,
  DRAW_GAS,
} from "./config";
import { confirmPixelAfterDraw, isContractConfigured } from "./contract";
import {
  canUseLocalDrawingSession,
  LocalDrawError,
  signAndSendDrawLocally,
} from "./local-draw";
import { describeSponsorship } from "./sponsorship";
import {
  hasRecognizedTxSuccess,
  isUserRejection,
  parseTxOutcome,
} from "./tx-outcome";
import { signAndSendDraw } from "./wallet";

/**
 * Full draw path after client checks have already passed (`prepareDraw`).
 *
 * Status meanings:
 * - rejected — client / config stopped us; nothing submitted
 * - pending — reported while we wait (UI progress only)
 * - success — wallet recognized success AND `get_pixel` matches
 * - confirmation_delayed — wallet recognized success, board read not matched yet
 * - overwritten — wallet recognized success, another artist already credits the cell
 * - failed — user rejected, wallet error, on-chain failure, or unclear status
 *
 * An uncertain / delayed outcome must not be auto-resubmitted.
 * A bare transaction id with an unrecognized status is never enough for success.
 */

export type DrawProgress =
  | { phase: "wallet_prompt"; detail: string }
  | { phase: "pending"; transactionId: string; explorer: string | null }
  | { phase: "confirming"; transactionId: string; explorer: string | null };

export type SubmitDrawResult =
  | {
      status: "rejected";
      title: string;
      message: string;
      transactionId: null;
      explorerUrl: null;
      pixel: null;
    }
  | {
      status: "pending";
      title: string;
      message: string;
      transactionId: string;
      explorerUrl: string | null;
      pixel: null;
    }
  | {
      status: "success";
      title: string;
      message: string;
      transactionId: string;
      explorerUrl: string | null;
      pixel: PixelView;
      /** Block height from the confirming get_pixel response. */
      observedBlockHeight: number;
    }
  | {
      status: "confirmation_delayed";
      title: string;
      message: string;
      /** May be null when broadcast is uncertain and no hash was observed. */
      transactionId: string | null;
      explorerUrl: string | null;
      pixel: PixelView | null;
      observedBlockHeight: number | null;
    }
  | {
      status: "overwritten";
      title: string;
      message: string;
      transactionId: string;
      explorerUrl: string | null;
      pixel: PixelView;
      observedBlockHeight: number;
    }
  | {
      status: "failed";
      title: string;
      message: string;
      transactionId: string | null;
      explorerUrl: string | null;
      pixel: null;
    };

export interface SubmitDrawInput {
  x: number;
  y: number;
  colorIndex: number;
  accountId: string;
  networkId: NetworkId;
  onProgress?: (progress: DrawProgress) => void;
}

export async function submitDraw(input: SubmitDrawInput): Promise<SubmitDrawResult> {
  if (!isContractConfigured()) {
    return {
      status: "rejected",
      title: "Contract not configured",
      message:
        "No game contract id is configured, so nothing was sent to the network.",
      transactionId: null,
      explorerUrl: null,
      pixel: null,
    };
  }

  // Read sponsorship so the prompt text stays honest. Path is always ordinary
  // wallet in MVP (see sponsorship.ts).
  const sponsorship = describeSponsorship();

  let outcome: unknown;
  let usedLocalSession = false;

  if (canUseLocalDrawingSession(input.accountId, input.networkId)) {
    input.onProgress?.({
      phase: "wallet_prompt",
      detail:
        "Using your authorized drawing session to sign locally (no wallet popup)…",
    });
    try {
      outcome = await signAndSendDrawLocally({
        accountId: input.accountId,
        networkId: input.networkId,
        x: input.x,
        y: input.y,
        color: input.colorIndex,
      });
      usedLocalSession = true;
    } catch (error) {
      if (error instanceof LocalDrawError) {
        if (error.code === "allowance_exhausted") {
          return {
            status: "failed",
            title: "Drawing session allowance exhausted",
            message: `${error.message} Nothing was auto-resubmitted. Renew the session or use ordinary wallet approval.`,
            transactionId: null,
            explorerUrl: null,
            pixel: null,
          };
        }
        // If the signed tx may already be on the network, never open a second
        // wallet submission for the same paint.
        if (error.mayHaveBroadcast) {
          return {
            status: "confirmation_delayed",
            title: "Submission uncertain — not retried",
            message: [
              "The local drawing-session send failed after signing may have started.",
              error.message,
              "This page will not open a second wallet transaction for the same paint (that could spend gas twice or overwrite intervening art).",
              "Refresh the board and check your account activity / explorer before trying again.",
            ].join(" "),
            transactionId: null,
            explorerUrl: null,
            pixel: null,
            observedBlockHeight: null,
          };
        }
        // Definitely never broadcast — safe to offer ordinary wallet fallback.
        input.onProgress?.({
          phase: "wallet_prompt",
          detail: [
            "Local drawing session could not start this paint.",
            error.message,
            walletPromptExplanation(input, sponsorship.message),
          ].join(" "),
        });
      } else {
        input.onProgress?.({
          phase: "wallet_prompt",
          detail: [
            "Local drawing session could not start this paint.",
            error instanceof Error ? error.message : "Unknown local-sign error.",
            walletPromptExplanation(input, sponsorship.message),
          ].join(" "),
        });
      }
    }
  }

  if (!usedLocalSession) {
    input.onProgress?.({
      phase: "wallet_prompt",
      detail: walletPromptExplanation(input, sponsorship.message),
    });
    try {
      outcome = await signAndSendDraw({
        contractId: CONTRACT_ID,
        x: input.x,
        y: input.y,
        color: input.colorIndex,
        gas: DRAW_GAS,
        deposit: DRAW_DEPOSIT,
      });
    } catch (error) {
      if (isUserRejection(error)) {
        return {
          status: "failed",
          title: "Wallet prompt closed",
          message:
            "You closed or rejected the wallet window. Nothing was painted. You can try again when you are ready.",
          transactionId: null,
          explorerUrl: null,
          pixel: null,
        };
      }
      const detail = error instanceof Error ? error.message : "Unknown wallet error";
      return {
        status: "failed",
        title: "Wallet could not send",
        message: `The wallet could not send the draw. ${detail}`,
        transactionId: null,
        explorerUrl: null,
        pixel: null,
      };
    }
  }

  const parsed = parseTxOutcome(outcome);
  const transactionId = parsed.transactionHash;
  const link = explorerUrl(input.networkId, transactionId);

  if (parsed.status === "failed") {
    return {
      status: "failed",
      title: "Transaction failed",
      message:
        parsed.failureMessage ??
        "The transaction was observed on chain and did not succeed. The pixel was not updated from this attempt.",
      transactionId,
      explorerUrl: link,
      pixel: null,
    };
  }

  if (!transactionId) {
    return {
      status: "failed",
      title: "No transaction id",
      message:
        "The wallet returned no transaction id, so this page will not claim success. Try again or check the wallet activity list.",
      transactionId: null,
      explorerUrl: null,
      pixel: null,
    };
  }

  // Hash alone with an unrecognized status must not become UI success.
  // A matching get_pixel could be leftover state from an earlier paint.
  if (!hasRecognizedTxSuccess(parsed)) {
    return {
      status: "failed",
      title: "Transaction status unclear",
      message:
        "The wallet returned a transaction id, but not a clear success or failure status. This page will not claim success from a matching pixel alone. Open the explorer link, then use Refresh board to verify what is on chain.",
      transactionId,
      explorerUrl: link,
      pixel: null,
    };
  }

  input.onProgress?.({
    phase: "pending",
    transactionId,
    explorer: link,
  });
  input.onProgress?.({
    phase: "confirming",
    transactionId,
    explorer: link,
  });

  try {
    const confirm = await confirmPixelAfterDraw({
      x: input.x,
      y: input.y,
      colorIndex: input.colorIndex,
      artistAccountId: input.accountId,
    });

    if (
      confirm.kind === "confirmed" &&
      confirm.pixel &&
      confirm.observedBlockHeight !== null
    ) {
      return {
        status: "success",
        title: "Pixel painted",
        message:
          "The wallet reported a successful transaction and a fresh board read shows your color on that square.",
        transactionId,
        explorerUrl: link,
        pixel: confirm.pixel,
        observedBlockHeight: confirm.observedBlockHeight,
      };
    }

    if (
      confirm.kind === "overwritten" &&
      confirm.pixel &&
      confirm.observedBlockHeight !== null
    ) {
      return {
        status: "overwritten",
        title: "Paint landed, then the wall moved on",
        message:
          "Your transaction succeeded, but the cell now credits a different artist under the Open wall rule. That is not a failed transaction — someone else painted over it (or beat the read). Check the explorer link; do not resubmit the same paint automatically.",
        transactionId,
        explorerUrl: link,
        pixel: confirm.pixel,
        observedBlockHeight: confirm.observedBlockHeight,
      };
    }

    return {
      status: "confirmation_delayed",
      title: "Submitted — confirmation delayed",
      message:
        "The wallet reported success, but a later board read does not yet show your color and account on that cell. The page will keep a pending preview and will not claim failure or resubmit. Open the explorer link and wait for the next board refresh.",
      transactionId,
      explorerUrl: link,
      pixel: confirm.pixel,
      observedBlockHeight: confirm.observedBlockHeight,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Read failed";
    return {
      status: "confirmation_delayed",
      title: "Submitted — could not re-read yet",
      message: `The wallet reported success, but the page could not re-read the pixel yet (${detail}). This is not treated as a failed transaction. Wait for a board refresh; do not resubmit automatically.`,
      transactionId,
      explorerUrl: link,
      pixel: null,
      observedBlockHeight: null,
    };
  }
}

function walletPromptExplanation(
  input: SubmitDrawInput,
  sponsorshipMessage: string,
): string {
  return [
    "Your wallet will ask you to approve one function call:",
    `method draw on contract ${CONTRACT_ID},`,
    `with arguments x=${input.x}, y=${input.y}, color=${input.colorIndex}.`,
    "That paints one square under the Open wall rule.",
    "The game adds no application fee. Your wallet may still pay a small network gas fee.",
    sponsorshipMessage,
  ].join(" ");
}
