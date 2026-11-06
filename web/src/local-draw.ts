import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { FinalBlockJsonRpcProvider, PinnedFinalBlockJsonRpcProvider } from "./final-block-provider";
import { KeyPairSigner } from "@near-js/signers";
import type { FinalExecutionOutcome } from "@near-js/types";
import { chunkCells, chunkArgs, type StrokeCell } from "./pages/wall/stroke-paint";
import { parseTxOutcome, hasRecognizedTxSuccess } from "./tx-outcome";
import { CONTRACT_ID, DRAW_DEPOSIT, DRAW_GAS, RPC_URL, rpcConnection } from "./config";
import { readRpcFetch } from "./read-rpc";
import {
  describeDrawingSession,
  loadDrawingSessionRecord,
  type DrawingSessionRecord,
} from "./drawing-session";

/**
 * Local draw path using an experimental function-call access key.
 * Signs in the browser and broadcasts via RPC — no wallet popup when the
 * stored key is valid and has remaining allowance.
 */

export class LocalDrawError extends Error {
  readonly code:
    | "no_session"
    | "mismatch"
    | "missing_secret"
    | "key_missing"
    | "allowance_exhausted"
    | "rpc";
  /**
   * True when a signed transaction may already have been broadcast.
   * Callers must NOT fall back to a second submission path.
   */
  readonly mayHaveBroadcast: boolean;

  constructor(
    code: LocalDrawError["code"],
    message: string,
    mayHaveBroadcast = false,
  ) {
    super(message);
    this.name = "LocalDrawError";
    this.code = code;
    this.mayHaveBroadcast = mayHaveBroadcast;
  }
}

export interface LocalDrawArgs {
  accountId: string;
  networkId: string;
  x: number;
  y: number;
  color: number;
  /**
   * Paid board: the quoted price, sent as `max_credits`. The revised contract
   * rejects with PriceRoseAboveMax above it; the old one ignores the field
   * (near-sdk only denies unknown JSON args under #[deny_unknown_arguments]).
   */
  maxCredits?: number | null;
}

/** `max_credits` only when there is a quoted price (paid board). */
export function withMaxCredits<T extends Record<string, unknown>>(
  args: T,
  maxCredits: number | null | undefined,
): T & { max_credits?: number } {
  return typeof maxCredits === "number" ? { ...args, max_credits: maxCredits } : args;
}

export interface AccessKeyAllowanceInfo {
  found: boolean;
  /** Remaining allowance in yoctoNEAR, or null when unlimited / unknown. */
  remainingYocto: string | null;
  permissionSummary: string;
  /** True when the wallet added a key with no method filter: any method on the board. */
  wildcard?: boolean;
  /**
   * The key's nonce at the read, as a decimal string; absent when the node did not
   * say. Every transaction the chain includes for this key raises it, executed
   * successfully or not, which makes it the evidence for "did a send land".
   */
  nonce?: string;
}

function provider(): JsonRpcProvider {
  return new FinalBlockJsonRpcProvider(rpcConnection(RPC_URL));
}

function requireActiveRecord(
  accountId: string,
  networkId: string,
): DrawingSessionRecord {
  const record = loadDrawingSessionRecord();
  const status = describeDrawingSession({
    contractId: CONTRACT_ID,
    accountId,
    networkId,
    record,
  });
  if (status.phase !== "active" || !record) {
    throw new LocalDrawError(
      status.phase === "account_mismatch" ? "mismatch" : "no_session",
      status.message,
    );
  }
  const secret = record.secretKey || record.secretKeyHex;
  if (!secret || record.forgottenLocally) {
    throw new LocalDrawError(
      "missing_secret",
      "This browser no longer has the drawing-session secret. Authorize again.",
    );
  }
  return record;
}

function signerFromRecord(record: DrawingSessionRecord): KeyPairSigner {
  const secret = record.secretKey || record.secretKeyHex;
  if (!secret.startsWith("ed25519:")) {
    throw new LocalDrawError(
      "missing_secret",
      "Stored drawing-session key is not a NEAR ed25519 secret. Authorize a new session.",
    );
  }
  return new KeyPairSigner(KeyPair.fromString(secret as KeyPairString));
}

/**
 * A read through the shared transport (`read-rpc.ts`): throttling-aware, queued,
 * with the network's fallback endpoint. The drawing key's pre-send checks used to
 * hit `RPC_URL` alone, so one 429 from the primary made a single paint fall back
 * to a wallet popup even with a working session key (issue #70).
 */
async function readRpc<T>(method: string, params: unknown): Promise<T> {
  let body: { result?: T; error?: unknown };
  try {
    const response = await readRpcFetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "metapoo-draw", method, params }),
    });
    body = (await response.json()) as { result?: T; error?: unknown };
  } catch (error) {
    throw new LocalDrawError("rpc", error instanceof Error ? error.message : "Network read failed.");
  }
  if (body.error !== undefined) throw new RpcReadFailure(body.error);
  return body.result as T;
}

class RpcReadFailure extends Error {
  constructor(readonly error: unknown) {
    super(describeRpcError(error));
  }
}

function describeRpcError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { cause?: { name?: unknown }; data?: unknown; message?: unknown };
    const parts = [e.cause?.name, typeof e.data === "string" ? e.data : null, e.message]
      .filter((part): part is string => typeof part === "string" && part !== "");
    if (parts.length) return parts.join(": ");
  }
  return typeof error === "string" ? error : "RPC error";
}

/** The node's answer for a key that is not on the account (both RPC error shapes). */
function isMissingKey(detail: string): boolean {
  return /UNKNOWN_ACCESS_KEY|does not exist|doesn't exist/i.test(detail);
}

type AccessKeyPermission =
  | "FullAccess"
  | { FunctionCall: { allowance?: string | null; receiver_id: string; method_names?: string[] } };

/** Read the on-chain FC key and remaining gas allowance (if limited). */
export async function fetchDrawingSessionAllowance(input: {
  accountId: string;
  networkId: string;
}): Promise<AccessKeyAllowanceInfo> {
  const record = requireActiveRecord(input.accountId, input.networkId);
  let view: { permission?: AccessKeyPermission; nonce?: unknown; error?: unknown };
  try {
    view = await readRpc("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: input.accountId,
      public_key: record.publicKey,
    });
  } catch (error) {
    if (error instanceof LocalDrawError) throw error;
    const detail = error instanceof Error ? error.message : "Unknown error";
    if (isMissingKey(detail)) return notFound();
    throw new LocalDrawError("rpc", detail);
  }
  // Older nodes answer a missing key with a result carrying an `error` string.
  if (typeof view?.error === "string") {
    if (isMissingKey(view.error)) return notFound();
    throw new LocalDrawError("rpc", view.error);
  }
  const permission = view?.permission;
  const nonce = readNonce(view?.nonce);
  if (permission === "FullAccess") {
    return {
      found: true,
      remainingYocto: null,
      permissionSummary: "Full access (unexpected for this experiment)",
      ...(nonce !== null ? { nonce } : {}),
    };
  }
  if (!permission || typeof permission !== "object" || !permission.FunctionCall) {
    throw new LocalDrawError("rpc", "Unrecognised access-key response.");
  }
  const fn = permission.FunctionCall;
  const allowance =
    fn.allowance === undefined || fn.allowance === null ? null : String(fn.allowance);
  return {
    found: true,
    remainingYocto: allowance,
    permissionSummary: `receiver ${fn.receiver_id}; methods ${(fn.method_names ?? []).join(", ") || "(any)"}`,
    wildcard: (fn.method_names ?? []).length === 0,
    ...(nonce !== null ? { nonce } : {}),
  };
}

/** A nonce as a decimal string, or null when the value is not a whole number. */
function readNonce(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return raw;
  if (typeof raw === "bigint" && raw >= 0n) return raw.toString();
  return null;
}

function notFound(): AccessKeyAllowanceInfo {
  return { found: false, remainingYocto: null, permissionSummary: "Key not found on account" };
}

/**
 * Sign and send `draw` with the stored FC key.
 * Returns a wallet-like outcome object for `parseTxOutcome`.
 */
export async function signAndSendDrawLocally(
  args: LocalDrawArgs,
): Promise<FinalExecutionOutcome> {
  const record = requireActiveRecord(args.accountId, args.networkId);

  const allowance = await fetchDrawingSessionAllowance({
    accountId: args.accountId,
    networkId: args.networkId,
  });
  if (!allowance.found) {
    throw new LocalDrawError(
      "key_missing",
      "The drawing-session key is not on this account anymore. Authorize again or use ordinary wallet approval.",
    );
  }
  if (allowance.remainingYocto !== null) {
    try {
      if (BigInt(allowance.remainingYocto) === 0n) {
        throw new LocalDrawError(
          "allowance_exhausted",
          "The drawing-session gas allowance is exhausted. Renew by authorizing a new session, or use ordinary wallet approval.",
        );
      }
    } catch (error) {
      if (error instanceof LocalDrawError) {
        throw error;
      }
    }
  }

  const signer = signerFromRecord(record);
  const account = new Account(args.accountId, provider(), signer);

  // Once callFunctionRaw starts, a lost RPC response may still mean the tx
  // landed. Treat any error from this call as possibly-broadcast.
  const callArgs = withMaxCredits(
    { x: args.x, y: args.y, color: args.color },
    args.maxCredits,
  ) as Record<string, unknown>;
  try {
    return await account.callFunctionRaw({
      contractId: CONTRACT_ID,
      methodName: "draw",
      args: callArgs,
      gas: DRAW_GAS,
      deposit: DRAW_DEPOSIT,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    if (/allowance|not enough balance|LackBalanceForState/i.test(detail)) {
      throw new LocalDrawError(
        "allowance_exhausted",
        `Drawing-session allowance or balance blocked the call. ${detail}`,
        true,
      );
    }
    throw new LocalDrawError(
      "rpc",
      detail,
      true,
    );
  }
}

/** True when an active local session can attempt no-popup draws. */
export function canUseLocalDrawingSession(
  accountId: string | null,
  networkId: string | null,
): boolean {
  if (!accountId || !CONTRACT_ID) {
    return false;
  }
  const status = describeDrawingSession({
    contractId: CONTRACT_ID,
    accountId,
    networkId,
    record: loadDrawingSessionRecord(),
  });
  return status.phase === "active";
}

/**
 * Resolve an executed-transaction block hash to its height.
 *
 * Best-effort by design: if this fails, the caller simply falls back to the
 * periodic full board read, which stays the reconciler regardless. It is never
 * worth failing a confirmed stroke because a height lookup timed out.
 */
async function resolveExecutedBlockHeight(blockHash: string | null): Promise<number | null> {
  if (!blockHash) {
    return null;
  }
  try {
    const block = (await provider().block({ blockId: blockHash })) as {
      header?: { height?: unknown };
    };
    const height = Number(block.header?.height);
    return Number.isFinite(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

export interface LocalStrokeResult {
  status: "confirmed" | "partial";
  confirmedChunks: number;
  totalChunks: number;
  outcomes: FinalExecutionOutcome[];
  failingChunk: { index: number; mayHaveBroadcast: boolean; message: string } | null;
  /**
   * Block height each confirmed chunk actually executed in, resolved from the
   * transaction receipt. The caller stamps its cells at these heights instead
   * of waiting for a full board read to rediscover its own write. Best-effort:
   * a chunk whose height cannot be resolved is simply absent, and the periodic
   * full read remains the reconciler either way.
   */
  executedBlocks: Array<{ chunkIndex: number; blockHeight: number }>;
}

/**
 * Submit sequential atomic batches. Never retry or switch paths after a failure.
 *
 * Reads are per stroke, not per chunk (each one is a ~250 ms round trip, and they
 * used to run serially in front of every chunk):
 * - the key's allowance and nonce, and the gas price, are read once, in parallel;
 *   later chunks check a running estimate and read again only when it runs low;
 * - every chunk signs against one pinned finalized block;
 * - each chunk's executed-block lookup runs beside the next chunk instead of
 *   in front of it.
 */
export async function signAndSendStrokeLocally(args: {
  accountId: string;
  networkId: string;
  cells: readonly StrokeCell[];
  color: number;
  /** Paid board: `max_credits` for each draw_many chunk, in order. */
  maxCredits?: readonly number[] | null;
}): Promise<LocalStrokeResult> {
  const chunks = chunkCells([...args.cells]);
  const result: LocalStrokeResult = {
    status: "confirmed", confirmedChunks: 0, totalChunks: chunks.length,
    outcomes: [], failingChunk: null, executedBlocks: [],
  };
  const heightLookups: Array<Promise<{ chunkIndex: number; blockHeight: number } | null>> = [];
  const rpc = new PinnedFinalBlockJsonRpcProvider(rpcConnection(RPC_URL));
  let account: Account | null = null;
  // Started now, awaited only if the allowance is limited (it normally is).
  let gasPrice: Promise<bigint> | null = null;
  const readGasPrice = (): Promise<bigint> =>
    (gasPrice ??= readRpc<{ gas_price: string }>("gas_price", [null]).then((p) => BigInt(p.gas_price)));
  /** Allowance still available, as far as this stroke can tell without a read. */
  let estimatedRemaining: bigint | null = null;
  /** The key's nonce before the current chunk's send; null when unknown. */
  let nonceBefore: bigint | null = null;

  /** A fresh key read: found or throw, and reset both estimates from the chain. */
  const readKey = async (): Promise<void> => {
    const allowance = await fetchDrawingSessionAllowance(args);
    if (!allowance.found) {
      throw new LocalDrawError("key_missing", "Authorize a new drawing session before continuing.");
    }
    estimatedRemaining = allowance.remainingYocto === null ? null : BigInt(allowance.remainingYocto);
    nonceBefore = allowance.nonce === undefined ? null : BigInt(allowance.nonce);
  };

  for (const [index, chunk] of chunks.entries()) {
    let mayHaveBroadcast = false;
    try {
      const record = requireActiveRecord(args.accountId, args.networkId);
      if (index === 0) {
        void readGasPrice().catch(() => undefined);
        await readKey();
      }
      if (estimatedRemaining !== null) {
        // Reserve prepaid gas at the current RPC price, with headroom for
        // transaction fees and the protocol's gas-price inflation margin.
        const required = BigInt(DRAW_GAS) * (await readGasPrice()) * 2n;
        if (estimatedRemaining < required && index > 0) {
          // The estimate is deliberately pessimistic; ask the chain before refusing.
          await readKey();
        }
        if (estimatedRemaining !== null && estimatedRemaining < required) {
          throw new LocalDrawError("allowance_exhausted",
            "This drawing session has too little gas allowance for the next batch. Authorize a new session to continue.");
        }
      }
      account ??= new Account(args.accountId, rpc, signerFromRecord(record));
      mayHaveBroadcast = true;
      const outcome = await account.callFunctionRaw({
        contractId: CONTRACT_ID, methodName: "draw_many",
        args: withMaxCredits(chunkArgs(chunk, args.color), args.maxCredits?.[index]),
        gas: DRAW_GAS, deposit: DRAW_DEPOSIT,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      result.outcomes.push(outcome);
      if (estimatedRemaining !== null) {
        // Charge the estimate the same reserve the check above requires, so it
        // only ever errs low; running low triggers a real read, not a refusal.
        const charged = BigInt(DRAW_GAS) * (await readGasPrice()) * 2n;
        estimatedRemaining = estimatedRemaining > charged ? estimatedRemaining - charged : 0n;
      }
      const parsed = parseTxOutcome(outcome);
      if (!hasRecognizedTxSuccess(parsed)) {
        throw new Error(parsed.failureMessage ?? "Batch execution is still unconfirmed.");
      }
      result.confirmedChunks += 1;
      // Only after success: a returned failure must keep the pre-send nonce as its
      // baseline, so the check in `catch` sees it move and reports "may have
      // broadcast". This chunk's own nonce is the next chunk's baseline.
      nonceBefore = transactionNonce(outcome);
      heightLookups.push(
        resolveExecutedBlockHeight(parsed.blockHash).then((blockHeight) =>
          blockHeight === null ? null : { chunkIndex: index, blockHeight }),
      );
    } catch (error) {
      result.status = "partial";
      const message = error instanceof Error ? error.message : String(error);
      result.failingChunk = {
        index,
        // `mayHaveBroadcast` was set before the call, so it means "the send was
        // attempted", not "a transaction may exist". Ask the chain instead: every
        // transaction included for this key raises its nonce, and a payload that
        // never left the browser leaves it unchanged. Without this check a purely
        // local failure pinned every cell in the batch as "confirmation delayed"
        // forever, with no transaction on chain.
        mayHaveBroadcast: mayHaveBroadcast ? await nonceMoved(args, nonceBefore) : false,
        message,
      };
      break;
    }
  }
  for (const found of await Promise.all(heightLookups)) {
    if (found) result.executedBlocks.push(found);
  }
  return result;
}

/** The nonce a transaction outcome reports, or null when it does not say. */
function transactionNonce(outcome: FinalExecutionOutcome): bigint | null {
  const raw = readNonce((outcome as { transaction?: { nonce?: unknown } }).transaction?.nonce);
  return raw === null ? null : BigInt(raw);
}

/**
 * True unless the chain shows the key's nonce exactly where it was before the send.
 * Any doubt (no baseline, a failed read, a missing key) stays conservative: true.
 */
async function nonceMoved(
  input: { accountId: string; networkId: string },
  before: bigint | null,
): Promise<boolean> {
  if (before === null) return true;
  try {
    const after = await fetchDrawingSessionAllowance(input);
    if (!after.found || after.nonce === undefined) return true;
    return BigInt(after.nonce) !== before;
  } catch {
    return true;
  }
}
