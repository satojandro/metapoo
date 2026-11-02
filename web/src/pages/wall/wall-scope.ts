import type { NetworkId } from "@shared/types.ts";
import { PAGE_NETWORK } from "../../config";

/**
 * What every wall controller shares with the mount: listener registration that
 * `dispose()` undoes, the disposed flag, and the live wallet identity.
 *
 * Controllers never read each other's variables. Anything else they need comes
 * through their own `deps`.
 */
export interface WallScope {
  /** addEventListener that the wall's dispose removes again. */
  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  /** Run `cleanup` when the wall is disposed, with the listener cleanups. */
  onDispose(cleanup: () => void): void;
  isDisposed(): boolean;
  walletAccount(): string | null;
  walletNetwork(): string | null;
  /** The wallet's network if it is a known id, else the page network. */
  walletNetworkId(): NetworkId;
}

export interface WallScopeHandle extends WallScope {
  setWallet(accountId: string | null, networkId: string | null): void;
  /** Sets the disposed flag. Returns false if it was already set. */
  markDisposed(): boolean;
  /** Runs every registered cleanup once, ignoring errors. */
  runCleanups(): void;
}

export function createWallScope(): WallScopeHandle {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let walletAccount: string | null = null;
  let walletNetwork: string | null = null;

  return {
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      cleanups.push(() => target.removeEventListener(type, handler, options));
    },
    onDispose(cleanup) {
      cleanups.push(cleanup);
    },
    isDisposed: () => disposed,
    walletAccount: () => walletAccount,
    walletNetwork: () => walletNetwork,
    walletNetworkId() {
      if (
        walletNetwork === "mock" ||
        walletNetwork === "localnet" ||
        walletNetwork === "testnet" ||
        walletNetwork === "mainnet"
      ) {
        return walletNetwork;
      }
      return PAGE_NETWORK;
    },
    setWallet(accountId, networkId) {
      walletAccount = accountId;
      walletNetwork = networkId;
    },
    markDisposed() {
      if (disposed) return false;
      disposed = true;
      return true;
    },
    runCleanups() {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // ignore listener cleanup errors
        }
      }
      cleanups.length = 0;
    },
  };
}
