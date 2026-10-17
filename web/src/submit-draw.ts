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
import {
  buildPaidFunctionCall,
  type PaidFunctionCall,
} from "./paid-paint";
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
 * - confirmed — wallet recognized success AND `get_pixel` matches
 * - confirmation_delayed — wallet recognized success, board read not matched yet
 * - overwritten — wallet recognized success, another artist already credits the cell
 * - failed — user rejected, wallet send error, or recognized on-chain failure
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
      status: "confirmed";
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

/** Paid paint fields frozen at Place / queue time (Journey C). */
export interface SubmitDrawPaidFields {
  maxCost: string;
  pricingVersion: string;
  expiresAtNs: string;
  actionNonce: string;
  /** When set, session `draw` with deposit 0; otherwise paint_with_wallet. */
  sessionId?: string;
}

export interface SubmitDrawInput {
  x: number;
  y: number;
  colorIndex: number;
  accountId: string;
  networkId: NetworkId;
  onProgress?: (progress: DrawProgress) => void;
  /**
   * When present, submit via paid board methods (schema 3).
   * Free schema 2 omits this and keeps legacy draw({x,y,color}).
   */
  paid?: SubmitDrawPaidFields;
}

/** Resolve the FunctionCall for a paid submit (pure; used by tests too). */
export function resolvePaidSubmitCall(
  input: Pick<SubmitDrawInput, "x" | "y" | "colorIndex" | "paid">,
): PaidFunctionCall | null {
  if (!input.paid) {
    return null;
  }
  return buildPaidFunctionCall({
    x: input.x,
    y: input.y,
    colorIndex: input.colorIndex,
    maxCost: input.paid.maxCost,
    pricingVersion: input.paid.pricingVersion,
    expiresAtNs: input.paid.expiresAtNs,
    actionNonce: input.paid.actionNonce,
    sessionId: input.paid.sessionId,
  });
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
  const paidCall = resolvePaidSubmitCall(input);
  // Paid session draw needs a registered board session_id. Until
  // register_paint_session is wired, local FC-key sessions only cover free
  // draw or paid draw when sessionId is already present on the request.
  const canLocalPaidSession =
    paidCall !== null &&
    paidCall.methodName === "draw" &&
    Boolean(input.paid?.sessionId);
  const canLocalFree =
    paidCall === null &&
    canUseLocalDrawingSession(input.accountId, input.networkId);
  const tryLocal =
    (canLocalPaidSession || canLocalFree) &&
    canUseLocalDrawingSession(input.accountId, input.networkId);

  let outcome: unknown;
  let usedLocalSession = false;

  if (tryLocal) {
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
        ...(paidCall
          ? {
              paidCall: {
                methodName: paidCall.methodName,
                args: paidCall.args as unknown as Record<string, unknown>,
                deposit: paidCall.deposit,
              },
            }
          : {}),
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
            walletPromptExplanation(input, sponsorship.message, paidCall),
          ].join(" "),
        });
      } else {
        input.onProgress?.({
          phase: "wallet_prompt",
          detail: [
            "Local drawing session could not start this paint.",
            error instanceof Error ? error.message : "Unknown local-sign error.",
            walletPromptExplanation(input, sponsorship.message, paidCall),
          ].join(" "),
        });
      }
    }
  }

  if (!usedLocalSession) {
    input.onProgress?.({
      phase: "wallet_prompt",
      detail: walletPromptExplanation(input, sponsorship.message, paidCall),
    });
    try {
      outcome = await signAndSendDraw({
        contractId: CONTRACT_ID,
        x: input.x,
        y: input.y,
        color: input.colorIndex,
        gas: DRAW_GAS,
        deposit: DRAW_DEPOSIT,
        ...(paidCall
          ? {
              paidCall: {
                methodName: paidCall.methodName,
                args: paidCall.args as unknown as Record<string, unknown>,
                deposit: paidCall.deposit,
              },
            }
          : {}),
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

  // A fulfilled wallet call with an unrecognized outcome is unresolved, not a
  // transaction failure. It may already have broadcast, so never resubmit it.
  // A matching get_pixel is also insufficient: it could be older board state.
  if (!hasRecognizedTxSuccess(parsed)) {
    return {
      status: "confirmation_delayed",
      title: "Submission unresolved — not retried",
      message: transactionId
        ? "The wallet call completed and returned a transaction id, but its execution status is not yet resolvable. This page will not mark it failed or submit it again automatically. Check the explorer and refresh the board later."
        : "The wallet call completed, but returned neither a transaction id nor a resolvable execution status. It may have broadcast, so this page will not mark it failed or submit it again automatically. Check wallet activity before trying another paint.",
      transactionId,
      explorerUrl: link,
      pixel: null,
      observedBlockHeight: null,
    };
  }

  // Recognized success necessarily carries a transaction id.
  if (!transactionId) {
    throw new Error("Recognized transaction success is missing its hash.");
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
        status: "confirmed",
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
  paidCall: PaidFunctionCall | null,
): string {
  if (paidCall) {
    return [
      "Your wallet will ask you to approve one function call:",
      `method ${paidCall.methodName} on contract ${CONTRACT_ID},`,
      `with arguments x=${input.x}, y=${input.y}, color=${input.colorIndex},`,
      `max_cost=${paidCall.args.max_cost}, pricing_version=${paidCall.args.pricing_version},`,
      `expires_at_ns=${paidCall.args.expires_at_ns}, action_nonce=${paidCall.args.action_nonce}.`,
      paidCall.methodName === "paint_with_wallet"
        ? "Deposit is 1 yoctoNEAR (paid wallet paint)."
        : "Deposit is 0 (paid session draw).",
      "That paints one square under the Open wall rule. TOILET cost is separate from network gas.",
      sponsorshipMessage,
    ].join(" ");
  }
  return [
    "Your wallet will ask you to approve one function call:",
    `method draw on contract ${CONTRACT_ID},`,
    `with arguments x=${input.x}, y=${input.y}, color=${input.colorIndex}.`,
    "That paints one square under the Open wall rule.",
    "The game adds no application fee. Your wallet may still pay a small network gas fee.",
    sponsorshipMessage,
  ].join(" ");
}
