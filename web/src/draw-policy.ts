import { reasonDrawIsBlocked } from "@shared/board-rules.ts";
import board from "@shared/board.json";
import type { NetworkId, OverwritePolicy } from "@shared/types.ts";
import { CONTRACT_ID } from "./config";

/**
 * The result of pressing "draw" before a wallet signing prompt.
 * This helper never marks a chain success. Success needs an observed
 * transaction and a fresh read elsewhere.
 */
export type DrawResult =
  | {
      outcome: "blocked";
      code:
        | "PixelNotChosen"
        | "ColorNotChosen"
        | "CoordinateOutOfRange"
        | "ColorOutOfRange"
        | "OverwriteRuleNotChosen"
        | "WalletNotConnected"
        | "NetworkMismatch"
        | "ContractNotConfigured";
      title: string;
      message: string;
      transactionHash: null;
      explorerUrl: null;
    }
  | {
      outcome: "ready";
      code: "ReadyToSign";
      title: string;
      message: string;
      transactionHash: null;
      explorerUrl: null;
    };

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
  code: Extract<DrawResult, { outcome: "blocked" }>["code"],
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

function policyFromBoard(): OverwritePolicy {
  return board.overwrite_rule === "open_wall" ? "open_wall" : "unresolved";
}

/**
 * Decide what a draw attempt means before any wallet prompt.
 * Shared checks cover bounds, palette, overwrite policy, wallet, and network.
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
    policyFromBoard(),
  );

  if (error?.code === "COORDINATE_OUT_OF_RANGE") {
    return blocked("CoordinateOutOfRange", "That pixel is off the board", error.message);
  }
  if (error?.code === "COLOR_OUT_OF_RANGE") {
    return blocked("ColorOutOfRange", "That color is not in the palette", error.message);
  }
  if (error?.code === "OWNERSHIP_RULE_UNRESOLVED") {
    return blocked(
      "OverwriteRuleNotChosen",
      "Drawing is waiting on a product decision",
      error.message,
    );
  }
  if (error?.code === "WALLET_NOT_CONNECTED") {
    return blocked("WalletNotConnected", "Connect a wallet first", error.message);
  }
  if (error?.code === "NETWORK_MISMATCH") {
    return blocked("NetworkMismatch", "Wallet network does not match", error.message);
  }
  if (error) {
    return blocked("OverwriteRuleNotChosen", "Drawing was not sent", error.message);
  }

  if (!CONTRACT_ID) {
    return blocked(
      "ContractNotConfigured",
      "Open wall is accepted, but no contract is configured",
      "Any connected wallet may paint any pixel under the Open wall rule. This page still has an empty contract id, so it will not open a signing prompt or pretend a transaction succeeded.",
    );
  }

  return {
    outcome: "ready",
    code: "ReadyToSign",
    title: "Ready to ask the wallet",
    message:
      "Client checks passed under Open wall. The next step is a wallet signature against the configured contract. This helper does not send that transaction by itself.",
    transactionHash: null,
    explorerUrl: null,
  };
}
