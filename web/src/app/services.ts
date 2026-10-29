/**
 * App-level services shared across routes.
 * Wallet module state + operations store outlive page mounts.
 */

import { createOperationsStore, type OperationsStore } from "./operations";
import {
  connectWallet,
  disconnectWallet,
  onWalletSession,
  restoreWalletSession,
  type ConnectWalletOptions,
  type WalletSession,
} from "../wallet";

export interface WalletService {
  getSession(): WalletSession;
  connect(options?: ConnectWalletOptions): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(listener: (session: WalletSession) => void): () => void;
  /** Resolves after the boot-time wallet restore attempt finishes. */
  whenReady: Promise<WalletSession>;
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

  // Hydrate identity from near-connect storage before the first paint path runs.
  // Connect / authorize behaviour is unchanged — this only restores an existing session.
  const whenReady = restoreWalletSession();

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
    whenReady,
  };

  return {
    wallet,
    operations: createOperationsStore(),
  };
}
