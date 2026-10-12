import { NearConnector } from "@hot-labs/near-connect";
import { Account as NearAccount } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { CONTRACT_ID, RPC_URL, WALLET_NETWORK } from "./config";
import {
  buildAddFunctionCallKeyParams,
  createDrawingSessionKeypair,
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  makeAuthorizedSessionRecord,
  saveDrawingSessionRecord,
  wipeDrawingSessionStorage,
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
 * Resolve the signed-in account id from a near-connect wallet.
 * Prefer `getAccounts()` — many wallets omit top-level `accountId`.
 */
export async function accountIdFromWallet(wallet: unknown): Promise<string | null> {
  if (!wallet || typeof wallet !== "object") {
    return null;
  }
  const record = wallet as Record<string, unknown>;

  if (typeof record.getAccounts === "function") {
    try {
      const accounts = (await (
        record.getAccounts as () => Promise<unknown>
      )()) as unknown;
      const fromList = nestedAccount(accounts);
      if (typeof fromList === "string" && fromList.length > 0) {
        return fromList;
      }
    } catch {
      // Fall through to property reads.
    }
  }

  return firstString(record.accountId, record.account_id);
}

/** True when the public key exists on the account (on-chain check). */
export async function verifyAccessKeyOnAccount(
  accountId: string,
  publicKey: string,
): Promise<boolean> {
  const account = new NearAccount(
    accountId,
    new JsonRpcProvider({ url: RPC_URL }),
  );
  try {
    await account.getAccessKey(publicKey);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (/does not exist|doesn't exist|not found/i.test(detail)) {
      return false;
    }
    // RPC ambiguity: do not mark the session active.
    return false;
  }
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

    const wallet = await current.wallet();
    const accountId =
      (await accountIdFromWallet(wallet)) ?? session.accountId;
    if (!accountId) {
      wipeDrawingSessionStorage();
      throw new Error(
        "Wallet signed in but did not return an account id via getAccounts(). Drawing session was not saved.",
      );
    }

    session = { accountId, networkId: WALLET_NETWORK };
    emit();

    const keyPresent = await verifyAccessKeyOnAccount(
      accountId,
      keypair.publicKey,
    );
    if (!keyPresent) {
      wipeDrawingSessionStorage();
      throw new Error(
        "Wallet signed in, but the draw-only access key was not found on the account yet. Drawing session was not marked active. Try Authorize again, or use ordinary wallet approval.",
      );
    }

    saveDrawingSessionRecord(
      makeAuthorizedSessionRecord({
        accountId,
        networkId: WALLET_NETWORK,
        contractId: CONTRACT_ID,
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
        gasAllowanceYocto: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
      }),
    );
    return;
  }

  await current.connect();
  try {
    const wallet = await current.wallet();
    const accountId = await accountIdFromWallet(wallet);
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
 * Prefer `signAndSendDrawLocally` when an active drawing session exists;
 * this wallet popup path remains the fallback.
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

/**
 * Ask the connected wallet (full access) to delete the experimental FC key
 * on chain. Receiver is the user's own account. Still requires a wallet prompt.
 */
export async function revokeDrawingSessionKeyOnChain(publicKey: string): Promise<unknown> {
  const current = ensureConnector();
  const wallet = await current.wallet();
  const accountId =
    (await accountIdFromWallet(wallet)) ?? session.accountId;
  if (!accountId) {
    throw new Error("Connect a wallet before revoking the drawing-session key on chain.");
  }
  return wallet.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      {
        type: "DeleteKey",
        params: { publicKey },
      },
    ],
  });
}
