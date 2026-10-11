import { NearConnector } from "@hot-labs/near-connect";
import { PAGE_NETWORK } from "./config";

/**
 * A connected wallet session. This is identity for the page only.
 * Connecting does not paint a pixel and does not confirm a transaction.
 */
export interface WalletSession {
  accountId: string | null;
  networkId: string | null;
}

type Listener = (session: WalletSession) => void;

let connector: NearConnector | null = null;
let session: WalletSession = { accountId: null, networkId: null };
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener(session);
  }
}

export function onWalletSession(listener: Listener): () => void {
  listeners.add(listener);
  listener(session);
  return () => {
    listeners.delete(listener);
  };
}

function ensureConnector(): NearConnector {
  if (connector) {
    return connector;
  }

  connector = new NearConnector({
    network: PAGE_NETWORK,
    features: {
      signInWithoutAddKey: true,
      signAndSendTransaction: true,
    },
  });

  connector.on("wallet:signIn", (payload: unknown) => {
    session = readSession(payload);
    emit();
  });
  connector.on("wallet:signOut", () => {
    session = { accountId: null, networkId: null };
    emit();
  });

  return connector;
}

/**
 * Wallet event objects differ slightly by version. Only strings are displayed,
 * using textContent at the call site, so an unexpected value cannot become HTML.
 */
function readSession(payload: unknown): WalletSession {
  if (!payload || typeof payload !== "object") {
    return { accountId: null, networkId: PAGE_NETWORK };
  }
  const record = payload as Record<string, unknown>;
  const accountId = firstString(
    record.accountId,
    record.account_id,
    nestedAccount(record.accounts),
  );
  const networkId = firstString(record.network, record.networkId) ?? PAGE_NETWORK;
  return { accountId, networkId };
}

function nestedAccount(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const first = value[0];
  if (typeof first === "string") {
    return first;
  }
  if (first && typeof first === "object" && "accountId" in first) {
    return (first as { accountId?: unknown }).accountId;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export async function connectWallet(): Promise<void> {
  const current = ensureConnector();
  await current.connect();
  try {
    const wallet = await current.wallet();
    const accountId = accountFromWallet(wallet);
    if (accountId) {
      session = { accountId, networkId: PAGE_NETWORK };
      emit();
    }
  } catch {
    // connect() may already have updated the session through the sign-in event.
  }
}

export async function disconnectWallet(): Promise<void> {
  if (!connector) {
    session = { accountId: null, networkId: null };
    emit();
    return;
  }
  await connector.disconnect();
  session = { accountId: null, networkId: null };
  emit();
}

function accountFromWallet(wallet: unknown): string | null {
  if (!wallet || typeof wallet !== "object") {
    return null;
  }
  const record = wallet as Record<string, unknown>;
  return firstString(record.accountId, record.account_id);
}
