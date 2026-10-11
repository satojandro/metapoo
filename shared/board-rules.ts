import { paletteColor } from "./palette.ts";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  NETWORK_LABEL,
  type DrawError,
  type DrawRequest,
  type NetworkId,
  type OverwritePolicy,
  type WalletSession,
} from "./types.ts";

/**
 * Client-side checks for one draw.
 *
 * The page uses these so a visitor gets a clear message quickly.
 * A future contract must repeat the same checks. The browser is not the
 * authority: a person can skip the page and talk to the contract directly.
 */

export function isInsideBoard(x: number, y: number): boolean {
  // Whole numbers only. A fraction means the click math is wrong.
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < BOARD_WIDTH &&
    y < BOARD_HEIGHT
  );
}

export function validateSelection(request: DrawRequest): DrawError | null {
  if (!isInsideBoard(request.x, request.y)) {
    return {
      code: "COORDINATE_OUT_OF_RANGE",
      message: `That pixel is outside the ${BOARD_WIDTH} by ${BOARD_HEIGHT} wall. Columns and rows run from 0 through ${BOARD_WIDTH - 1}.`,
    };
  }

  if (!paletteColor(request.colorIndex)) {
    return {
      code: "COLOR_OUT_OF_RANGE",
      message: "That color is not on the palette. Pick one of the named colors.",
    };
  }

  return null;
}

export function validateSession(
  session: WalletSession,
  boardNetworkId: NetworkId,
): DrawError | null {
  if (!session.connected || !session.accountId) {
    return {
      code: "WALLET_NOT_CONNECTED",
      message:
        "Connect a wallet before drawing. This practice page can use a pretend session only.",
    };
  }

  if (session.networkId !== boardNetworkId) {
    return {
      code: "NETWORK_MISMATCH",
      message: `The session says ${NETWORK_LABEL[session.networkId]}, and this board is ${NETWORK_LABEL[boardNetworkId]}. They have to match. Nothing was sent.`,
    };
  }

  return null;
}

/**
 * The single user-facing reason a draw must stop.
 * Bounds and palette come first, then the missing ownership rule,
 * then wallet and network. Visitors should hear the real blocker.
 */
export function reasonDrawIsBlocked(
  request: DrawRequest,
  session: WalletSession,
  boardNetworkId: NetworkId,
  overwritePolicy: OverwritePolicy,
): DrawError | null {
  const selectionError = validateSelection(request);
  if (selectionError) {
    return selectionError;
  }

  if (overwritePolicy === "unresolved") {
    return {
      code: "OWNERSHIP_RULE_UNRESOLVED",
      message:
        "Drawing is turned off until the product owner decides who may paint over a pixel. No wallet window was opened, and no transaction was sent.",
    };
  }

  return validateSession(session, boardNetworkId);
}

/**
 * A link to a public explorer, only when we actually have a transaction id
 * on a public NEAR network. Practice mode never gets a link.
 */
export function explorerUrl(networkId: NetworkId, transactionId: string | null): string | null {
  if (!transactionId) {
    return null;
  }

  if (networkId === "testnet") {
    return `https://testnet.nearblocks.io/txns/${encodeURIComponent(transactionId)}`;
  }

  if (networkId === "mainnet") {
    return `https://nearblocks.io/txns/${encodeURIComponent(transactionId)}`;
  }

  return null;
}
