import { explorerUrl } from "@shared/board-rules.ts";
import type { NetworkId, PixelView } from "@shared/types.ts";
import {
  CONTRACT_ID,
  DRAW_DEPOSIT,
  DRAW_GAS,
} from "./config";
import { confirmPixelAfterDraw, isContractConfigured } from "./contract";
import { describeSponsorship } from "./sponsorship";
import { isUserRejection, parseTxOutcome } from "./tx-outcome";
import { signAndSendDraw } from "./wallet";

/**
 * Full draw path after client checks have already passed (`prepareDraw`).
 *
 * Status meanings (same words as `shared/types.ts`):
 * - rejected — client / config stopped us; nothing submitted
 * - pending — reported while we wait (UI may show this briefly)
 * - success — transaction id observed AND `get_pixel` shows the new cell
 * - failed — user rejected, wallet error, on-chain failure, or confirm mismatch
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

  input.onProgress?.({
    phase: "wallet_prompt",
    detail: walletPromptExplanation(input, sponsorship.message),
  });

  let outcome: unknown;
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

  let pixel: PixelView | null = null;
  try {
    pixel = await confirmPixelAfterDraw({
      x: input.x,
      y: input.y,
      colorIndex: input.colorIndex,
      artistAccountId: input.accountId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Read failed";
    return {
      status: "failed",
      title: "Could not confirm on chain",
      message: `A transaction id exists, but the page could not re-read the pixel to confirm. ${detail}`,
      transactionId,
      explorerUrl: link,
      pixel: null,
    };
  }

  if (!pixel) {
    return {
      status: "failed",
      title: "Read did not match yet",
      message:
        "A transaction was sent, but a later board read did not yet show your color and account on that cell. Open the explorer link and try refreshing. The picture was not updated from a click alone.",
      transactionId,
      explorerUrl: link,
      pixel: null,
    };
  }

  return {
    status: "success",
    title: "Pixel painted",
    message:
      "The wallet returned a transaction id and a fresh board read shows your color on that square.",
    transactionId,
    explorerUrl: link,
    pixel,
  };
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
