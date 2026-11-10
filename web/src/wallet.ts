import { NearConnector } from "@hot-labs/near-connect";
import { Account as NearAccount } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import {
  CONTRACT_ID,
  RPC_URL,
  rpcConnection,
  PAGE_NETWORK,
  WALLET_NETWORK,
  PRIVY_ENABLED,
  INTENTS_FUNDING_ENABLED,
  RHEA_MPOO_SWAP_ENABLED,
  ACQUISITION_PLAY_RESERVE_YOCTO,
} from "./config";
import {
  createPrivyManifest,
  readPrivyConfig,
  PRIVY_WALLET_ID,
} from "./integrations/privy/config";
import {
  setPrivyHostIdentity,
  setPrivyPendingDrawingAuthorization,
  isPrivyUnsubmittedRejection,
} from "./integrations/privy/session";
import { withCapitalLock } from "./integrations/operation-store";
import { createAcquisitionRpc } from "./integrations/rpc";
import { resolveAccountReadiness } from "./integrations/account-readiness";
import {
  createApprovedTransactionGateway,
  ApprovalNotSubmittedError,
  validateAcquisitionTransaction,
  type AcquisitionPolicy,
  reconcilePendingCapitalAttempt,
} from "./integrations/approved-transactions";
import {
  sameIdentity,
  type ApprovedTransactionRequest,
  type OperationContext,
} from "./integrations/types";
import { stringifyChainJson } from "./chain-json";
import { parseTxOutcome } from "./tx-outcome";
import {
  buildAddFunctionCallKeyParams,
  classifyDrawingKeyAccessKey,
  createDrawingSessionKeypair,
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  DRAWING_SESSION_METHODS,
  makeAuthorizedSessionRecord,
  saveDrawingSessionRecord,
  type DrawingKeyScope,
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
let connectorReady: Promise<void> = Promise.resolve();
let sessionEpoch = 0;
/** Epoch prevents an async quote/approval from spending after a provider or identity change. */
export function getAcquisitionContext(
  operationId: string,
): OperationContext | null {
  return session.accountId &&
    (session.networkId === "mainnet" || session.networkId === "testnet")
    ? {
        operationId,
        accountId: session.accountId,
        networkId: session.networkId,
        sessionEpoch,
      }
    : null;
}
let session: WalletSession = { accountId: null, networkId: null };
const listeners = new Set<Listener>();

function emit(): void {
  sessionEpoch++;
  if (PRIVY_ENABLED && typeof window !== "undefined") {
    setPrivyHostIdentity(
      session.accountId &&
        (session.networkId === "mainnet" || session.networkId === "testnet")
        ? {
            accountId: session.accountId,
            networkId: session.networkId,
            sessionEpoch,
          }
        : null,
      window.localStorage,
    );
  }
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

/** Current in-memory session (null account when disconnected). */
export function getWalletSession(): WalletSession {
  return session;
}

/**
 * Wallets hidden from the picker (owner, 10 Nov 2026), by near-connect manifest id:
 * a developer CLI, an EVM bridge, a DAO treasury app, and a hardware wallet. None is how a
 * player signs in from a browser, and together they crowded the list. Edit freely.
 */
export const HIDDEN_WALLET_IDS = [
  "near-cli",
  "ethereum-wallets",
  "trezu-wallet",
  "ledger",
] as const;

/** Move one registered wallet to the top of the picker. No-op if it is not registered. */
export function promoteWallet(
  target: Pick<NearConnector, "wallets" | "events">,
  id: string,
): void {
  const index = target.wallets.findIndex((w) => w.manifest.id === id);
  if (index <= 0) return;
  const [wallet] = target.wallets.splice(index, 1);
  target.wallets.unshift(wallet);
  target.events.emit("selector:walletsChanged", {});
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
    excludedWallets: [...HIDDEN_WALLET_IDS],
  });

  if (PRIVY_ENABLED && typeof window !== "undefined") {
    const availability = readPrivyConfig(
      import.meta.env,
      window.location.origin,
    );
    const target = connector;
    connectorReady = (async () => {
      if (availability.state !== "ready") return;
      await target.whenManifestLoaded;
      await target.registerWallet(createPrivyManifest(availability.config));
      // registerWallet appends; most new players have no NEAR wallet, so lead with Privy.
      promoteWallet(target, PRIVY_WALLET_ID);
    })();
    // Registration failure must not remove ordinary wallets from the selector.
    void connectorReady.catch(() => undefined);
  }

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
 * Re-read a previously selected wallet after a full page load.
 *
 * near-connect persists `selected-wallet` in storage; Meteor and other redirect
 * wallets often reload the page after sign-in or a transaction. Without this
 * boot-time restore the in-memory session stays null and the UI looks logged out.
 *
 * Restore-only: does not change key scope, allowance, or connect prompts.
 */
export async function restoreWalletSession(): Promise<WalletSession> {
  try {
    const current = ensureConnector();
    await connectorReady.catch(() => undefined);
    const { accounts } = await current.getConnectedWallet();
    const accountId = nestedAccount(accounts);
    if (typeof accountId === "string" && accountId.length > 0) {
      session = { accountId, networkId: WALLET_NETWORK };
      emit();
    }
  } catch {
    // No previously selected wallet, or the wallet has no accounts — stay disconnected.
  }
  return session;
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
  const networkId =
    firstString(record.network, record.networkId) ?? WALLET_NETWORK;
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
export async function accountIdFromWallet(
  wallet: unknown,
): Promise<string | null> {
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

/**
 * What the on-chain key at `publicKey` is, for drawing purposes (see `DrawingKeyScope`).
 * Reads the account directly so a stale local record can never impersonate a key.
 */
export async function drawingKeyScopeOnAccount(
  accountId: string,
  publicKey: string,
): Promise<DrawingKeyScope> {
  const account = new NearAccount(accountId, new JsonRpcProvider(rpcConnection(RPC_URL)));
  try {
    const access = await account.getAccessKey(publicKey);
    return classifyDrawingKeyAccessKey(access.permission, CONTRACT_ID);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (/does not exist|doesn't exist|not found/i.test(detail)) return "absent";
    throw error;
  }
}

/**
 * True when the public key can paint on this board.
 *
 * Accepts a wallet-wide key (`wildcard`) as well as one scoped to draw/draw_many:
 * Meteor ignores `allowMethods.methodNames` and adds a key for any method on the
 * receiver. Rejecting that made "Approve painting key" fail every single time, while
 * each attempt still wrote another live key to the user's account. The key can paint,
 * so the session is valid; the panel says out loud that it is wider than requested.
 */
export async function verifyAccessKeyOnAccount(
  accountId: string,
  publicKey: string,
  attempts = 4,
): Promise<boolean> {
  const account = new NearAccount(
    accountId,
    new JsonRpcProvider(rpcConnection(RPC_URL)),
  );
  // The wallet returns as soon as it has signed. AddKey is a separate receipt, and the
  // RPC we read from can lag a block behind — a single read reports "not found" for a
  // key that is about to exist, and the old code then wiped the secret.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const access = await account.getAccessKey(publicKey);
      const scope = classifyDrawingKeyAccessKey(access.permission, CONTRACT_ID);
      if (scope === "scoped" || scope === "wildcard") return true;
      return false; // the key exists and is genuinely unusable — retrying cannot help
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      const missing = /does not exist|doesn't exist|not found/i.test(detail);
      // A 429 or a dropped connection is not evidence that the key is absent. Under
      // throttling the old code gave up on the first read, so a perfectly good key read
      // as "not found" and the user was asked to approve again. Retry both cases, and
      // only conclude "absent" after the attempts are spent.
      if (attempt === attempts - 1) return false;
      const wait = missing ? 250 * (attempt + 1) : 600 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return false;
}


/**
 * How many FunctionCall keys for this board already sit on the account.
 *
 * Used only for the message when this browser holds no secret for any of them: "there
 * are N keys" and "I can sign with a key" are different facts, and the UI must not
 * pretend otherwise.
 */
export async function countBoardKeysOnAccount(accountId: string): Promise<number> {
  try {
    const account = new NearAccount(accountId, new JsonRpcProvider(rpcConnection(RPC_URL)));
    const list = await account.getAccessKeyList();
    const keys = (list as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return 0;
    return keys.filter((entry) => {
      const permission = (entry as { accessKey?: { permission?: unknown } }).accessKey?.permission;
      if (!permission || typeof permission !== "object") return false;
      const fc = (permission as { FunctionCall?: { receiverId?: unknown; receiver_id?: unknown } }).FunctionCall;
      const receiver = fc?.receiverId ?? fc?.receiver_id;
      return receiver === CONTRACT_ID;
    }).length;
  } catch {
    return 0;
  }
}


export interface DrawingSessionAuthorization {
  accountId: string;
  publicKey: string;
  transactionHash: string | null;
  /** False when the key is not readable yet. The secret is kept either way. */
  confirmed: boolean;
}

/**
 * Add the draw-only key with an ordinary wallet transaction.
 *
 * We build the AddKey action ourselves instead of asking the wallet to add it during
 * sign-in. Two reasons, both observed on testnet: Meteor ignores
 * `allowMethods.methodNames` on sign-in and stores an empty filter (any method on the
 * board), and it can throw after the key is already on chain. A plain transaction is
 * the path this app already uses successfully, it carries *our* permission — receiver,
 * draw methods, bounded allowance — and it reports a real result.
 *
 * The secret is saved before the chain check, so a slow RPC can never cost the user
 * another approval.
 */
export async function authorizeDrawingSession(
  options: { replacePublicKey?: string | null } = {},
): Promise<DrawingSessionAuthorization> {
  const current = ensureConnector();
  await connectorReady.catch(() => undefined);
  const wallet = await current.wallet().catch(() => null);
  if (!wallet) {
    throw new Error("Connect a wallet first: the drawing key is added by a wallet approval.");
  }
  const accountId = (await accountIdFromWallet(wallet)) ?? session.accountId;
  if (!accountId) {
    throw new Error("Could not read the connected account. Reconnect the wallet and try again.");
  }

  const replacing = options.replacePublicKey ?? null;
  const retireOldKey =
    replacing !== null && (await isRetirableDrawingKey(accountId, replacing));
  const keypair = await createDrawingSessionKeypair();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      {
        type: "AddKey",
        params: {
          publicKey: keypair.publicKey,
          accessKey: {
            nonce: 0,
            permission: {
              receiverId: CONTRACT_ID,
              allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
              methodNames: [...DRAWING_SESSION_METHODS],
            },
          },
        },
      },
      // Same transaction, so a renewal is one approval and never leaves the account
      // with neither key: both actions land or neither does.
      ...(retireOldKey ? [{ type: "DeleteKey" as const, params: { publicKey: replacing } }] : []),
    ],
  });
  const parsed = parseTxOutcome(outcome);
  if (parsed.status === "failed") {
    throw new Error(parsed.failureMessage ?? "The wallet refused the AddKey transaction.");
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
  session = { accountId, networkId: WALLET_NETWORK };
  emit();

  const confirmed = await verifyAccessKeyOnAccount(accountId, keypair.publicKey);
  return {
    accountId,
    publicKey: keypair.publicKey,
    transactionHash: parsed.transactionHash,
    confirmed,
  };
}

/**
 * True only for a key this app can safely delete while renewing.
 *
 * A failed DeleteKey fails its whole transaction, new key included, so a key that is
 * already gone must not be named. And this must never reach a full-access key or
 * another app's key. Any doubt, a failed read included, leaves the old key in place:
 * an orphan key is harmless, a blocked renewal is not.
 */
async function isRetirableDrawingKey(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const account = new NearAccount(accountId, new JsonRpcProvider(rpcConnection(RPC_URL)));
    const access = await account.getAccessKey(publicKey);
    const scope = classifyDrawingKeyAccessKey(access.permission, CONTRACT_ID);
    return scope === "scoped" || scope === "wildcard";
  } catch {
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
  await connectorReady.catch(() => undefined);
  const wantSession =
    options.authorizeDrawingSession === true && CONTRACT_ID.length > 0;
  // The wallet can add the key and still fail to report the session. Keep who we were
  // before the attempt so the account is never lost to a wallet-side TypeError.
  const accountBeforeAttempt = session.accountId;

  if (wantSession) {
    const keypair = await createDrawingSessionKeypair();
    const addFunctionCallKey = buildAddFunctionCallKeyParams(
      CONTRACT_ID,
      keypair.publicKey,
      DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    );
    // Reauthorize the selected Privy wallet rather than opening a second wallet picker.
    const selected = session.accountId
      ? await current.getConnectedWallet().catch(() => null)
      : null;
    const walletId =
      selected?.wallet?.manifest?.id === PRIVY_WALLET_ID
        ? PRIVY_WALLET_ID
        : undefined;
    if (walletId && session.accountId && typeof window !== "undefined") {
      setPrivyPendingDrawingAuthorization(
        {
          accountId: session.accountId,
          networkId: WALLET_NETWORK,
          sessionEpoch,
          publicKey: keypair.publicKey,
          contractId: CONTRACT_ID,
          methods: DRAWING_SESSION_METHODS,
          allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
          createdAtMs: Date.now(),
        },
        window.localStorage,
      );
    }
    // A wallet can add the key and *then* fail while returning its session state —
    // Meteor does exactly that ("Cannot read properties of undefined (reading
    // 'accountId')" after a successful sign-in). The chain is the source of truth, so
    // hold the error instead of trusting it, and decide after the key read below.
    let connectFailure: unknown = null;
    try {
      await current.connect({
        addFunctionCallKey,
        ...(walletId ? { walletId } : {}),
      });
    } catch (error) {
      connectFailure = error;
    } finally {
      if (walletId && typeof window !== "undefined")
        setPrivyPendingDrawingAuthorization(null, window.localStorage);
    }

    const wallet = await current.wallet().catch(() => null);
    const resolved = await accountIdFromWallet(wallet);
    const candidates = [resolved, session.accountId, accountBeforeAttempt].filter(
      (id, index, all): id is string => typeof id === "string" && id.length > 0 && all.indexOf(id) === index,
    );
    if (candidates.length === 0) {
      wipeDrawingSessionStorage();
      throw connectFailure instanceof Error
        ? connectFailure
        : new Error(
            "Wallet signed in but did not return an account id. Drawing session was not saved.",
          );
    }

    // The wallet may add the key to an account it then reports differently (or not at
    // all). Ask every account we know about which one actually holds this key.
    let accountId: string | null = null;
    for (const candidate of candidates) {
      if (await verifyAccessKeyOnAccount(candidate, keypair.publicKey, 2)) {
        accountId = candidate;
        break;
      }
    }
    if (!accountId) {
      const existing = await countBoardKeysOnAccount(candidates[0]);
      wipeDrawingSessionStorage();
      throw connectFailure instanceof Error
        ? connectFailure
        : new Error(
            existing > 0
              ? `Wallet signed in, but none of the ${existing} key(s) already on ${candidates[0]} for this board is one this browser holds the secret for, so it cannot sign with them. Revoke those keys in the wallet, then approve once more — or keep painting with ordinary wallet approval.`
              : "Wallet signed in, but the draw-only access key did not arrive on the account. Try Authorize again, or keep painting with ordinary wallet approval.",
          );
    }

    session = { accountId, networkId: WALLET_NETWORK };
    emit();

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
  const current = connector;
  // Invalidate authority synchronously: even a slow provider lookup must not keep a popup authorized.
  session = { accountId: null, networkId: null };
  emit();
  const selected = await current.getConnectedWallet().catch(() => null);
  await current.disconnect();
  if (
    selected?.wallet?.manifest?.id === PRIVY_WALLET_ID &&
    typeof window !== "undefined"
  ) {
    const availability = readPrivyConfig(
      import.meta.env,
      window.location.origin,
    );
    if (availability.state === "ready") {
      const { createPrivyRuntime } = await import(
        "./integrations/privy/runtime"
      );
      const runtime = createPrivyRuntime(availability.config);
      const { logoutPrivySession } = await import(
        "./integrations/privy/session"
      );
      try {
        await runtime.initialize();
        await logoutPrivySession(runtime, WALLET_NETWORK, window.localStorage);
      } finally {
        runtime.dispose();
      }
    }
  }
}

export interface DrawCallArgs {
  contractId: string;
  x: number;
  y: number;
  /** Palette index 0–7. On chain the argument name is `color`. */
  color: number;
  gas: string;
  deposit: string;
  /** Paid board: the quoted price, sent as `max_credits`. */
  maxCredits?: number | null;
}

/**
 * Ask the connected wallet to sign and send one paint FunctionCall.
 * The call is `draw` with `{x, y, color}`.
 * Returns the wallet's execution outcome (hash + status), or throws if the
 * user rejects / the wallet errors. This function does not update the picture.
 *
 * Prefer `signAndSendDrawLocally` when an active drawing session exists;
 * this wallet popup path remains the fallback.
 */
export async function signAndSendDraw(args: DrawCallArgs): Promise<unknown> {
  const current = ensureConnector();
  const wallet = await current.wallet();
  const callArgs: Record<string, unknown> = {
    x: args.x,
    y: args.y,
    color: args.color,
  };
  if (typeof args.maxCredits === "number") {
    callArgs.max_credits = args.maxCredits;
  }
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "draw",
          args: callArgs,
          gas: args.gas,
          deposit: args.deposit,
        },
      },
    ],
  });
}

export interface BuyCreditsNearCallArgs {
  contractId: string;
  /** When set, register_credit_account is the first action (exact fee deposit). */
  registrationDeposit: string | null;
  registrationGas: string;
  minCredits: string;
  expectedPrice: string;
  purchaseDeposit: string;
  purchaseGas: string;
}

/**
 * Full-access wallet path for prepaid credits (NEAR).
 * Batches optional `register_credit_account` with `buy_credits_near` so the
 * first purchase is one approval. Never use a drawing-session FC key here.
 */
async function sendBuyCreditsNearInternal(
  args: BuyCreditsNearCallArgs,
): Promise<unknown> {
  const current = ensureConnector();
  const captured = getAcquisitionContext("checkout");
  const wallet = await current.wallet();
  await assertCheckoutWallet(wallet, captured);
  const actions: Array<{
    type: "FunctionCall";
    params: {
      methodName: string;
      args: Record<string, unknown>;
      gas: string;
      deposit: string;
    };
  }> = [];
  if (args.registrationDeposit) {
    actions.push({
      type: "FunctionCall",
      params: {
        methodName: "register_credit_account",
        args: {},
        gas: args.registrationGas,
        deposit: args.registrationDeposit,
      },
    });
  }
  actions.push({
    type: "FunctionCall",
    params: {
      methodName: "buy_credits_near",
      args: {
        min_credits: args.minCredits,
        expected_price: args.expectedPrice,
      },
      gas: args.purchaseGas,
      deposit: args.purchaseDeposit,
    },
  });
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions,
  });
}

export interface BuyCreditsTokenCallArgs {
  tokenContractId: string;
  boardContractId: string;
  /** Optional prior board registration (separate tx, board receiver). */
  registrationDeposit: string | null;
  registrationGas: string;
  amount: string;
  msg: string;
  gas: string;
  deposit: string;
}

/**
 * Token purchase: optionally register on the board first, then
 * `ft_transfer_call` on the configured token with 1 yocto attached.
 */
async function sendBuyCreditsTokenInternal(
  args: BuyCreditsTokenCallArgs,
): Promise<unknown> {
  const current = ensureConnector();
  const captured = getAcquisitionContext("checkout");
  const wallet = await current.wallet();
  await assertCheckoutWallet(wallet, captured);
  if (args.registrationDeposit) {
    await wallet.signAndSendTransaction({
      receiverId: args.boardContractId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "register_credit_account",
            args: {},
            gas: args.registrationGas,
            deposit: args.registrationDeposit,
          },
        },
      ],
    });
  }
  await assertCheckoutWallet(wallet, captured);
  return wallet.signAndSendTransaction({
    receiverId: args.tokenContractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "ft_transfer_call",
          args: {
            receiver_id: args.boardContractId,
            amount: args.amount,
            msg: args.msg,
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
export async function revokeDrawingSessionKeyOnChain(
  publicKey: string,
): Promise<unknown> {
  const current = ensureConnector();
  const wallet = await current.wallet();
  const accountId = (await accountIdFromWallet(wallet)) ?? session.accountId;
  if (!accountId) {
    throw new Error(
      "Connect a wallet before revoking the drawing-session key on chain.",
    );
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

/**
 * Wallet path for the public revenue split (`distribute_near` / `distribute_mpoo`).
 * No arguments, no deposit: anyone may call it, and the caller pays only gas.
 * Never sent with a drawing-session key — the wallet signs.
 */
export async function signAndSendDistribution(args: {
  contractId: string;
  methodName: "distribute_near" | "distribute_mpoo";
  gas: string;
}): Promise<unknown> {
  const current = ensureConnector();
  const wallet = await current.wallet();
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: args.methodName,
          args: {},
          gas: args.gas,
          deposit: "0",
        },
      },
    ],
  });
}

type FunctionCallStep = { receiverId: string; methodName: string; args: Record<string, unknown>; gas: string; deposit: string };

/** One wallet transaction per step, in order. A step that fails stops the rest. */
async function sendSteps(steps: FunctionCallStep[]): Promise<unknown> {
  const wallet = await ensureConnector().wallet();
  let last: unknown;
  for (const s of steps) {
    last = await wallet.signAndSendTransaction({
      receiverId: s.receiverId,
      actions: [{ type: "FunctionCall", params: { methodName: s.methodName, args: s.args, gas: s.gas, deposit: s.deposit } }],
    });
  }
  return last;
}

/**
 * Stake: register with the staking contract first if needed (its fixed storage
 * deposit, once), then `ft_transfer_call` on TOILET with `msg: "stake"`.
 * The contract refunds a stake from an unregistered account in full.
 */
export async function signAndSendStake(args: {
  toilet: string;
  staking: string;
  amount: string;
  registerDeposit: string | null;
  storageGas: string;
  gas: string;
}): Promise<unknown> {
  const steps: FunctionCallStep[] = [];
  if (args.registerDeposit) {
    steps.push({ receiverId: args.staking, methodName: "storage_deposit", args: {}, gas: args.storageGas, deposit: args.registerDeposit });
  }
  steps.push({
    receiverId: args.toilet, methodName: "ft_transfer_call",
    args: { receiver_id: args.staking, amount: args.amount, msg: "stake" }, gas: args.gas, deposit: "1",
  });
  return sendSteps(steps);
}

/** Unstake: 10% of `amount` is burned by the contract, the rest comes back. 1 yoctoNEAR. */
export async function signAndSendUnstake(args: { staking: string; amount: string; gas: string }): Promise<unknown> {
  return sendSteps([{ receiverId: args.staking, methodName: "unstake", args: { amount: args.amount }, gas: args.gas, deposit: "1" }]);
}

/**
 * Claim released mPOO. The mPOO token can only pay an account it knows, so a
 * first-time claimer registers there first; otherwise the payout fails and the
 * contract restores it.
 */
export async function signAndSendClaimRewards(args: {
  staking: string;
  mpoo: string;
  mpooRegisterDeposit: string | null;
  storageGas: string;
  gas: string;
}): Promise<unknown> {
  const steps: FunctionCallStep[] = [];
  if (args.mpooRegisterDeposit) {
    steps.push({ receiverId: args.mpoo, methodName: "storage_deposit", args: { registration_only: true }, gas: args.storageGas, deposit: args.mpooRegisterDeposit });
  }
  steps.push({ receiverId: args.staking, methodName: "claim_rewards", args: {}, gas: args.gas, deposit: "1" });
  return sendSteps(steps);
}

/**
 * Wallet path for `claim_toilet`: the board mints the caller's earned TOILET.
 * Exactly 1 yoctoNEAR, which the board requires so a function-call key can't claim.
 * Never sent with a drawing-session key — the wallet signs.
 */
export async function signAndSendClaimToilet(args: {
  contractId: string;
  toilet: string;
  gas: string;
}): Promise<unknown> {
  const wallet = await ensureConnector().wallet();
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "claim_toilet", args: { toilet: args.toilet }, gas: args.gas, deposit: "1" },
      },
    ],
  });
}

/** Normal owner-wallet call; never uses the browser's drawing-session key. */
export async function signAndSendAdminChange(args: {
  contractId: string;
  owner: string;
  methodName:
    | "set_tunables"
    | "set_near_price"
    | "set_mpoo_price"
    | "set_paused"
    | "set_team_account"
    | "set_buyback_account"
    | "set_staking_contract";
  args: Record<string, unknown>;
}): Promise<unknown> {
  const wallet = await ensureConnector().wallet();
  const actual = await accountIdFromWallet(wallet);
  if (actual !== args.owner || session.networkId !== WALLET_NETWORK)
    throw new Error("OwnerWalletRequired");
  const json = stringifyChainJson(args.args);
  // A JSON round-trip through normal JS numbers would corrupt nanosecond history.
  // Meteor's published adapter accepts Uint8Array arguments and serializes them
  // directly (stringifyJsonOrBytes). Other adapters need an explicit byte-path check.
  const hasBigInteger = /"(?:[^"\\]|\\.)*"|-?\d+/g;
  const needsBytes = [...json.matchAll(hasBigInteger)].some(
    (m) => !m[0].startsWith('"') && !Number.isSafeInteger(Number(m[0])),
  );
  if (needsBytes && wallet.manifest.id !== "meteor-wallet") {
    throw new Error(
      "ExactSettingsWalletRequired: use Meteor Wallet to preserve the board’s full-precision settings history.",
    );
  }
  return wallet.signAndSendTransaction({
    receiverId: args.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: args.methodName,
          args: needsBytes ? new TextEncoder().encode(json) : args.args,
          gas: "50000000000000",
          deposit: "1",
        },
      },
    ],
  });
}

/** Reviewed runtime route policy. Empty exchanges keep all trading disabled until evidence exists. */
let acquisitionPolicy: AcquisitionPolicy = {
  wrapAccount: WALLET_NETWORK === "mainnet" ? "wrap.near" : "wrap.testnet",
  tokenAccounts: [],
  exchangeAccounts: [],
  poolIds: [],
  storageMaximums: {},
};
export function configureAcquisitionPolicy(policy: AcquisitionPolicy): void {
  acquisitionPolicy = JSON.parse(JSON.stringify(policy)) as AcquisitionPolicy;
}
export async function signAndSendApprovedTransactions(
  request: ApprovedTransactionRequest,
) {
  if (typeof window === "undefined")
    throw new Error("Wallet approvals require a browser");
  if (
    PAGE_NETWORK !== request.context.networkId ||
    (PAGE_NETWORK !== "mainnet" && PAGE_NETWORK !== "testnet")
  )
    throw new Error("Acquisition network mismatch");
  if (
    request.purpose === "mpoo-acquisition"
      ? !RHEA_MPOO_SWAP_ENABLED
      : !INTENTS_FUNDING_ENABLED && !RHEA_MPOO_SWAP_ENABLED
  )
    throw new Error("Acquisition approvals are disabled");
  const rpc = createAcquisitionRpc(RPC_URL);
  const selectedWallet = await ensureConnector().wallet();
  const gateway = createApprovedTransactionGateway({
    isUnsubmittedRejection: (error) =>
      selectedWallet.manifest?.id === PRIVY_WALLET_ID &&
      isPrivyUnsubmittedRejection(error),
    context: () => getAcquisitionContext(request.context.operationId),
    storage: window.localStorage,
    now: Date.now,
    validateTransaction: (tx, r) =>
      validateAcquisitionTransaction(tx, r, acquisitionPolicy),
    async readBudget(context) {
      if (!/^[1-9]\d*$/.test(ACQUISITION_PLAY_RESERVE_YOCTO))
        throw new Error("A measured play-gas reserve must be configured");
      const ready = await readConnectedAccountReadiness(context);
      if (ready.state !== "ready")
        throw new Error("Fund and initialize your account before spending");
      const gas = (await rpc("gas_price", { block_id: ready.blockHash })) as {
        gas_price: string;
      };
      return {
        spendableBeforeGasYocto: ready.spendableBeforeGasYocto,
        gasPriceYocto: gas.gas_price,
        playReserveYocto: ACQUISITION_PLAY_RESERVE_YOCTO,
      };
    },
    ...(selectedWallet.manifest?.features?.signAndSendTransactions
      ? {
          async sendBatch(
            txs: readonly import("./integrations/types").ApprovedNearTransaction[],
            context: OperationContext,
          ) {
            try {
              if (
                (await accountIdFromWallet(selectedWallet)) !==
                  context.accountId ||
                !sameIdentity(
                  context,
                  getAcquisitionContext(context.operationId),
                )
              )
                throw new Error("Wallet account changed");
            } catch {
              // No signing method has been called at this point.
              throw new ApprovalNotSubmittedError(
                "Wallet preflight failed before signing",
              );
            }
            return selectedWallet.signAndSendTransactions({
              transactions: txs.map((tx) => ({
                receiverId: tx.receiverId,
                actions: tx.actions.map((a) => ({
                  ...a,
                  params: { ...a.params },
                })),
              })),
              signerId: context.accountId,
              network: context.networkId,
            });
          },
        }
      : {}),
    async send(tx, context) {
      const wallet = selectedWallet;
      try {
        if (
          (await accountIdFromWallet(wallet)) !== context.accountId ||
          !sameIdentity(context, getAcquisitionContext(context.operationId))
        )
          throw new Error("Wallet account changed");
      } catch {
        // Keep provider errors outside this catch: after invocation they may have broadcast.
        throw new ApprovalNotSubmittedError(
          "Wallet preflight failed before signing",
        );
      }
      return wallet.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions.map((a) => ({ ...a, params: { ...a.params } })),
        signerId: context.accountId,
        network: context.networkId,
      });
    },
  });
  return gateway(request);
}

/** Re-read the selected provider's account metadata; never use email as a chain identity. */
export async function getConnectedAcquisitionPublicKey(
  context: OperationContext,
): Promise<string | undefined> {
  const wallet = await ensureConnector().wallet();
  const accounts = await wallet.getAccounts({ network: context.networkId });
  const selected = accounts.find(
    (account) => account.accountId === context.accountId,
  );
  if (
    !selected ||
    !getAcquisitionContext(context.operationId) ||
    getAcquisitionContext(context.operationId)!.sessionEpoch !==
      context.sessionEpoch
  )
    throw new Error("Selected wallet changed");
  let publicKey = selected.publicKey;
  if (
    !publicKey &&
    wallet.manifest.id === PRIVY_WALLET_ID &&
    /^[0-9a-f]{64}$/.test(context.accountId)
  ) {
    // Privy Ed25519 implicit IDs are exactly the public-key bytes, never a private key.
    const { encodeBase58 } = await import("./drawing-session");
    publicKey =
      "ed25519:" +
      encodeBase58(
        Uint8Array.from(context.accountId.match(/../g)!, (part) =>
          parseInt(part, 16),
        ),
      );
  }
  return publicKey;
}
export async function readConnectedAccountReadiness(context: OperationContext) {
  const publicKey = await getConnectedAcquisitionPublicKey(context);
  return resolveAccountReadiness(
    context.accountId,
    context.networkId,
    createAcquisitionRpc(RPC_URL),
    publicKey,
  );
}
export async function supportsAcquisitionBatchRegistrations(): Promise<boolean> {
  const wallet = await ensureConnector().wallet();
  return wallet.manifest?.features?.signAndSendTransactions === true;
}

/** Status-only recovery remains available after logout; it never requests a signature. */
export async function reconcilePendingAcquisition(
  context: OperationContext,
): Promise<boolean> {
  const url =
    context.networkId === "mainnet"
      ? "https://rpc.mainnet.near.org"
      : "https://rpc.testnet.near.org";
  const rpc = createAcquisitionRpc(url);
  return reconcilePendingCapitalAttempt(
    context,
    window.localStorage,
    (hash, accountId) =>
      rpc("EXPERIMENTAL_tx_status", {
        tx_hash: hash,
        sender_account_id: accountId,
        wait_until: "FINAL",
      }),
  );
}

async function withAcquisitionCheckoutLock(
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (
    (!INTENTS_FUNDING_ENABLED && !RHEA_MPOO_SWAP_ENABLED) ||
    typeof window === "undefined"
  )
    return run();
  return withCapitalLock(window.localStorage, async () => {
    const captured = getAcquisitionContext("checkout");
    if (!captured) throw new Error("Connect your wallet before buying credits");
    if (
      window.localStorage.getItem(
        `metapoo:capital:pending:${captured.networkId}:${captured.accountId}`,
      )
    )
      throw new Error(
        "Resolve the previous acquisition transaction before buying credits",
      );
    return run();
  });
}
export async function signAndSendBuyCreditsNear(
  args: BuyCreditsNearCallArgs,
): Promise<unknown> {
  return withAcquisitionCheckoutLock(() => sendBuyCreditsNearInternal(args));
}
export async function signAndSendBuyCreditsToken(
  args: BuyCreditsTokenCallArgs,
): Promise<unknown> {
  return withAcquisitionCheckoutLock(() => sendBuyCreditsTokenInternal(args));
}

async function assertCheckoutWallet(
  wallet: unknown,
  context: OperationContext | null,
): Promise<void> {
  if (!INTENTS_FUNDING_ENABLED && !RHEA_MPOO_SWAP_ENABLED) return;
  const account = await accountIdFromWallet(wallet);
  if (
    !context ||
    account !== context.accountId ||
    !sameIdentity(context, getAcquisitionContext(context.operationId))
  )
    throw new Error("Wallet changed before checkout approval");
}
