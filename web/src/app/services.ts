/**
 * App-level services shared across routes.
 * Wallet module state + operations store outlive page mounts.
 */

import { createOperationsStore, type OperationsStore } from "./operations";
import {
  authorizeDrawingSession,
  connectWallet,
  disconnectWallet,
  onWalletSession,
  restoreWalletSession,
  type ConnectWalletOptions,
  type DrawingSessionAuthorization,
  type WalletSession,
} from "../wallet";

export interface WalletService {
  getSession(): WalletSession;
  connect(options?: ConnectWalletOptions): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(listener: (session: WalletSession) => void): () => void;
  /**
   * Add the draw-only key with one wallet transaction (see `authorizeDrawingSession`).
   * Optional so test doubles that never paint do not have to stub it.
   */
  authorizeDrawingSession?(options?: {
    /** A renewal: delete this key in the same transaction that adds the new one. */
    replacePublicKey?: string | null;
  }): Promise<DrawingSessionAuthorization>;
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
    authorizeDrawingSession(options) {
      return authorizeDrawingSession(options);
    },
    whenReady,
  };

  return {
    wallet,
    operations: createOperationsStore(),
  };
}
