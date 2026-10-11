import { CONTRACT_ID, PAGE_NETWORK } from "./config";

export interface NetworkNotice {
  matches: boolean;
  message: string;
}

/**
 * Compare the wallet's reported network with the network this page asked for.
 * A missing wallet is not an error: looking at the board is allowed.
 */
export function describeNetwork(walletNetworkId: string | null): NetworkNotice {
  const contractLabel = CONTRACT_ID || "not configured";

  if (walletNetworkId === null) {
    return {
      matches: true,
      message: `No wallet connected. Connecting asks for the ${PAGE_NETWORK} network. Contract: ${contractLabel}. Looking at the board does not need a wallet.`,
    };
  }
  if (walletNetworkId !== PAGE_NETWORK) {
    return {
      matches: false,
      message: `Network mismatch. This page expects ${PAGE_NETWORK}, but the wallet reported ${walletNetworkId}. Disconnect and switch networks. No draw was sent.`,
    };
  }
  return {
    matches: true,
    message: `Wallet network matches this page (${PAGE_NETWORK}). Contract: ${contractLabel}.`,
  };
}
