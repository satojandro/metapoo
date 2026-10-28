import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { FinalExecutionOutcome } from "@near-js/types";
import { chunkCells, chunkArgs, type StrokeCell } from "./pages/wall/stroke-paint";
import { parseTxOutcome, hasRecognizedTxSuccess } from "./tx-outcome";
import { CONTRACT_ID, DRAW_DEPOSIT, DRAW_GAS, RPC_URL } from "./config";
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
}

export interface AccessKeyAllowanceInfo {
  found: boolean;
  /** Remaining allowance in yoctoNEAR, or null when unlimited / unknown. */
  remainingYocto: string | null;
  permissionSummary: string;
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: RPC_URL });
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

/** Read the on-chain FC key and remaining gas allowance (if limited). */
export async function fetchDrawingSessionAllowance(input: {
  accountId: string;
  networkId: string;
}): Promise<AccessKeyAllowanceInfo> {
  const record = requireActiveRecord(input.accountId, input.networkId);
  const account = new Account(input.accountId, provider());
  try {
    const view = await account.getAccessKey(record.publicKey);
    const permission = view.permission;
    if (permission === "FullAccess") {
      return {
        found: true,
        remainingYocto: null,
        permissionSummary: "Full access (unexpected for this experiment)",
      };
    }
    const fn = permission.FunctionCall;
    const allowance =
      fn.allowance === undefined || fn.allowance === null
        ? null
        : String(fn.allowance);
    return {
      found: true,
      remainingYocto: allowance,
      permissionSummary: `receiver ${fn.receiver_id}; methods ${(fn.method_names ?? []).join(", ") || "(any)"}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    if (/does not exist|doesn't exist|not found/i.test(detail)) {
      return {
        found: false,
        remainingYocto: null,
        permissionSummary: "Key not found on account",
      };
    }
    throw new LocalDrawError("rpc", detail);
  }
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
  const callArgs = { x: args.x, y: args.y, color: args.color } as Record<string, unknown>;
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

/** Submit sequential atomic batches. Never retry or switch paths after a failure. */
export async function signAndSendStrokeLocally(args: {
  accountId: string;
  networkId: string;
  cells: readonly StrokeCell[];
  color: number;
}): Promise<LocalStrokeResult> {
  const chunks = chunkCells([...args.cells]);
  const result: LocalStrokeResult = {
    status: "confirmed", confirmedChunks: 0, totalChunks: chunks.length,
    outcomes: [], failingChunk: null, executedBlocks: [],
  };
  for (const [index, chunk] of chunks.entries()) {
    let mayHaveBroadcast = false;
    let allowanceBefore: string | null = null;
    try {
      const record = requireActiveRecord(args.accountId, args.networkId);
      const allowance = await fetchDrawingSessionAllowance(args);
      allowanceBefore = allowance.remainingYocto;
      if (!allowance.found) {
        throw new LocalDrawError("key_missing", "Authorize a new drawing session before continuing.");
      }
      const rpc = provider();
      if (allowance.remainingYocto !== null) {
        const price = await rpc.gasPrice(null);
        // Reserve prepaid gas at the current RPC price, with headroom for
        // transaction fees and the protocol's gas-price inflation margin.
        const required = BigInt(DRAW_GAS) * BigInt(price.gas_price) * 2n;
        if (BigInt(allowance.remainingYocto) < required) {
          throw new LocalDrawError("allowance_exhausted",
            "This drawing session has too little gas allowance for the next batch. Authorize a new session to continue.");
        }
      }
      const account = new Account(args.accountId, rpc, signerFromRecord(record));
      mayHaveBroadcast = true;
      const outcome = await account.callFunctionRaw({
        contractId: CONTRACT_ID, methodName: "draw_many",
        args: chunkArgs(chunk, args.color), gas: DRAW_GAS, deposit: DRAW_DEPOSIT,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      result.outcomes.push(outcome);
      const parsed = parseTxOutcome(outcome);
      if (!hasRecognizedTxSuccess(parsed)) {
        throw new Error(parsed.failureMessage ?? "Batch execution is still unconfirmed.");
      }
      result.confirmedChunks += 1;
      const executedHeight = await resolveExecutedBlockHeight(parsed.blockHash);
      if (executedHeight !== null) {
        result.executedBlocks.push({ chunkIndex: index, blockHeight: executedHeight });
      }
    } catch (error) {
      result.status = "partial";
      const message = error instanceof Error ? error.message : String(error);
      result.failingChunk = {
        index,
        // `mayHaveBroadcast` was set before the call, so it means "the send was
        // attempted", not "a transaction may exist". Ask the chain instead: an
        // executed transaction spends the session key's gas allowance, and a
        // payload that never left the browser leaves it byte-identical. Without
        // this check a purely local failure pinned every cell in the batch as
        // "confirmation delayed" forever, with no transaction on chain.
        mayHaveBroadcast: mayHaveBroadcast
          ? await (async () => {
              try {
                const after = await fetchDrawingSessionAllowance(args);
                if (after.remainingYocto === null || allowanceBefore === null) {
                  return true; // unknown allowance: stay conservative
                }
                return BigInt(after.remainingYocto) !== BigInt(allowanceBefore);
              } catch {
                return true;
              }
            })()
          : false,
        message,
      };
      break;
    }
  }
  return result;
}
