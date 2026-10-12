/**
 * App-level services shared across routes.
 * Wallet module state + operations store outlive page mounts.
 */

import { createOperationsStore, type OperationsStore } from "./operations";
import {
  connectWallet,
  disconnectWallet,
  onWalletSession,
  type ConnectWalletOptions,
  type WalletSession,
} from "../wallet";

export interface WalletService {
  getSession(): WalletSession;
  connect(options?: ConnectWalletOptions): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(listener: (session: WalletSession) => void): () => void;
}

export interface AppServices {
  wallet: WalletService;
  operations: OperationsStore;
}

export function createAppServices(): AppServices {
  let latest: WalletSession = { accountId: null, networkId: null };

  // Keep a process-wide mirror so getSession() works without a subscriber.
  onWalletSession((session) => {
    latest = session;
  });

  const wallet: WalletService = {
    getSession() {
      return latest;
    },
    connect(options) {
      return connectWallet(options);
    },
    disconnect() {
      return disconnectWallet();
    },
    subscribe(listener) {
      return onWalletSession(listener);
    },
  };

  return {
    wallet,
    operations: createOperationsStore(),
  };
}
