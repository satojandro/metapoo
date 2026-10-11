import { reasonDrawIsBlocked } from "@shared/board-rules.ts";
import board from "@shared/board.json";
import type { NetworkId } from "@shared/types.ts";

/**
 * The result of pressing "draw" in this build.
 * `outcome` is only "blocked". There is no success value, so a click cannot
 * be reported as a confirmed transaction by accident.
 */
export interface DrawResult {
  outcome: "blocked";
  code:
    | "PixelNotChosen"
    | "ColorNotChosen"
    | "CoordinateOutOfRange"
    | "ColorOutOfRange"
    | "OverwriteRuleNotChosen"
    | "WalletNotConnected"
    | "NetworkMismatch";
  title: string;
  message: string;
  transactionHash: null;
  explorerUrl: null;
}

export interface DrawAttempt {
  x: number | null;
  y: number | null;
  color: number | null;
  connected: boolean;
  accountId: string | null;
  sessionNetworkId: NetworkId;
  boardNetworkId: NetworkId;
}

function blocked(
  code: DrawResult["code"],
  title: string,
  message: string,
): DrawResult {
  return {
    outcome: "blocked",
    code,
    title,
    message,
    transactionHash: null,
    explorerUrl: null,
  };
}

/**
 * Decide what a draw attempt means. This function never calls a wallet.
 * Shared checks cover bounds, palette, the unresolved overwrite rule,
 * wallet connection, and network match. The page adds "not chosen yet".
 */
export function prepareDraw(attempt: DrawAttempt): DrawResult {
  if (attempt.x === null || attempt.y === null) {
    return blocked(
      "PixelNotChosen",
      "Choose a pixel",
      "Select one square on the board, then pick a named color. Nothing was sent to the network.",
    );
  }

  if (attempt.color === null) {
    return blocked(
      "ColorNotChosen",
      "Choose a color",
      "Pick one of the named colors. The name is the label, not only the colored chip. Nothing was sent to the network.",
    );
  }

  const error = reasonDrawIsBlocked(
    { x: attempt.x, y: attempt.y, colorIndex: attempt.color },
    {
      connected: attempt.connected,
      accountId: attempt.accountId,
      networkId: attempt.sessionNetworkId,
    },
    attempt.boardNetworkId,
    "unresolved",
  );

  if (!error) {
    return blocked(
      "OverwriteRuleNotChosen",
      "Drawing was not sent",
      `Who may paint over a pixel is not decided (marker: ${board.overwrite_rule}). Nothing was sent to the network.`,
    );
  }

  if (error.code === "COORDINATE_OUT_OF_RANGE") {
    return blocked("CoordinateOutOfRange", "That pixel is off the board", error.message);
  }
  if (error.code === "COLOR_OUT_OF_RANGE") {
    return blocked("ColorOutOfRange", "That color is not in the palette", error.message);
  }
  if (error.code === "OWNERSHIP_RULE_UNRESOLVED") {
    return blocked(
      "OverwriteRuleNotChosen",
      "Drawing is waiting on a product decision",
      error.message,
    );
  }
  if (error.code === "WALLET_NOT_CONNECTED") {
    return blocked("WalletNotConnected", "Connect a wallet first", error.message);
  }
  return blocked("NetworkMismatch", "Wallet network does not match", error.message);
}
