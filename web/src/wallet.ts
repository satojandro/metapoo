import { NearConnector } from "@hot-labs/near-connect";
import { CONTRACT_ID, WALLET_NETWORK } from "./config";
import {
  buildAddFunctionCallKeyParams,
  createDrawingSessionKeypair,
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  makeAuthorizedSessionRecord,
  saveDrawingSessionRecord,
} from "./drawing-session";

/**
 * A connected wallet session. This is identity for the page only.
 * Connecting does not paint a pixel and does not confirm a transaction.
 */
export interface WalletSession {
  accountId: string | null;
  networkId: string | null;
}

export interface ConnectWalletOptions {
  /**
   * When true (and a contract id is configured), ask the wallet to add a
   * limited function-call key for `draw` during sign-in.
   * Default / ordinary Connect leaves this off (fallback path).
   */
  authorizeDrawingSession?: boolean;
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

  // Default features keep ordinary sign-in without an FC key.
  // connect({ addFunctionCallKey }) further filters for wallets that support
  // signInWithFunctionCallKey when the user opts into a drawing session.
  connector = new NearConnector({
    network: WALLET_NETWORK,
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
    return { accountId: null, networkId: WALLET_NETWORK };
  }
  const record = payload as Record<string, unknown>;
  const accountId = firstString(
    record.accountId,
    record.account_id,
    nestedAccount(record.accounts),
  );
  const networkId = firstString(record.network, record.networkId) ?? WALLET_NETWORK;
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

/**
 * Ordinary Connect (default): sign in without requesting an FC key.
 * Opt-in: pass `{ authorizeDrawingSession: true }` when a contract id is set.
 */
export async function connectWallet(
  options: ConnectWalletOptions = {},
): Promise<void> {
  const current = ensureConnector();
  const wantSession =
    options.authorizeDrawingSession === true && CONTRACT_ID.length > 0;

  if (wantSession) {
    const keypair = await createDrawingSessionKeypair();
    const addFunctionCallKey = buildAddFunctionCallKeyParams(
      CONTRACT_ID,
      keypair.publicKey,
      DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    );
    await current.connect({ addFunctionCallKey });
    try {
      const wallet = await current.wallet();
      const accountId = accountFromWallet(wallet);
      if (accountId) {
        session = { accountId, networkId: WALLET_NETWORK };
        saveDrawingSessionRecord(
          makeAuthorizedSessionRecord({
            accountId,
            networkId: WALLET_NETWORK,
            contractId: CONTRACT_ID,
            publicKey: keypair.publicKey,
            secretKeyHex: keypair.secretKeyHex,
            gasAllowanceYocto: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
          }),
        );
        emit();
      }
    } catch {
      // connect() may already have updated the session through the sign-in event.
      // If we have an account from the event, still try to persist the keypair.
      if (session.accountId) {
        saveDrawingSessionRecord(
          makeAuthorizedSessionRecord({
            accountId: session.accountId,
            networkId: session.networkId ?? WALLET_NETWORK,
            contractId: CONTRACT_ID,
            publicKey: keypair.publicKey,
            secretKeyHex: keypair.secretKeyHex,
            gasAllowanceYocto: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
          }),
        );
      }
    }
    return;
  }

  await current.connect();
  try {
    const wallet = await current.wallet();
    const accountId = accountFromWallet(wallet);
    if (accountId) {
      session = { accountId, networkId: WALLET_NETWORK };
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

export interface DrawCallArgs {
  contractId: string;
  x: number;
  y: number;
  /** Palette index 0–7. On chain the argument name is `color`. */
  color: number;
  gas: string;
  deposit: string;
}

/**
 * Ask the connected wallet to sign and send one `draw` function call.
 * Returns the wallet's execution outcome (hash + status), or throws if the
 * user rejects / the wallet errors. This function does not update the picture.
 *
 * Even when an experimental drawing session FC key was requested at connect,
 * this path still uses the wallet popup API until local signing is proven.
 */
export async function signAndSendDraw(args: DrawCallArgs): Promise<unknown> {
  const current = ensureConnector();
  const wallet = await current.wallet();
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "draw",
          args: {
            x: args.x,
            y: args.y,
            color: args.color,
          },
          gas: args.gas,
          deposit: args.deposit,
        },
      },
    ],
  });
}

function accountFromWallet(wallet: unknown): string | null {
  if (!wallet || typeof wallet !== "object") {
    return null;
  }
  const record = wallet as Record<string, unknown>;
  return firstString(record.accountId, record.account_id);
}
