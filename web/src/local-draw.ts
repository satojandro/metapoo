import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { FinalBlockJsonRpcProvider } from "./final-block-provider";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, createTransaction, type SignedTransaction } from "@near-js/transactions";
import type { FinalExecutionOutcome } from "@near-js/types";
import { baseDecode, baseEncode } from "@near-js/utils";
import { chunkCells, chunkArgs, type StrokeCell } from "./pages/wall/stroke-paint";
import { parseTxOutcome, hasRecognizedTxSuccess } from "./tx-outcome";
import { CONTRACT_ID, DRAW_DEPOSIT, DRAW_GAS, RPC_URL, rpcConnection } from "./config";
import { readRpcFetch } from "./read-rpc";
import {
  describeDrawingSession,
  isDrawingKeyLow,
  loadDrawingSessionRecord,
  quotedRefusalCostYocto,
  refusalCostRatio,
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
    if (isDrawingKeyLow(detail)) logAllowanceRefusal(detail);
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

/**
 * What happened to one batch. Batches are signed together and sent together, so
 * one failing no longer stops the ones after it: each carries its own result.
 * - confirmed: executed; its cells are written (at `blockHeight`, when known).
 * - failed: the chain or the node said no; nothing was stored or charged.
 * - uncertain: it may have been broadcast and its result is unknown. Never retry it.
 * - not_sent: it never left the browser.
 */
export interface LocalChunkResult {
  index: number;
  state: "confirmed" | "failed" | "uncertain" | "not_sent";
  message: string | null;
  transactionHash: string | null;
  blockHeight: number | null;
}

export interface LocalStrokeResult {
  status: "confirmed" | "partial";
  confirmedChunks: number;
  totalChunks: number;
  outcomes: FinalExecutionOutcome[];
  /** One entry per batch, in stroke order. The authority for which cells landed. */
  chunks: LocalChunkResult[];
  /** The first batch that did not confirm (a summary for status copy). */
  failingChunk: { index: number; mayHaveBroadcast: boolean; message: string } | null;
  /**
   * Block height each confirmed chunk actually executed in, resolved from the
   * transaction receipt. The caller stamps its cells at these heights instead
   * of waiting for a full board read to rediscover its own write. Best-effort:
   * a chunk whose height cannot be resolved is simply absent, and the periodic
   * full read remains the reconciler either way.
   */
  executedBlocks: Array<{ chunkIndex: number; blockHeight: number }>;
  /**
   * The same list once every lookup has finished. With `deferBlockHeights` the
   * result returns on the receipts alone (`executedBlocks` is then empty) and the
   * heights arrive here; otherwise this resolves to `executedBlocks` at once.
   */
  executedBlocksLater?: Promise<Array<{ chunkIndex: number; blockHeight: number }>>;
}

/**
 * Everything a signature needs that can be read before the price is known: the
 * key (allowance and nonce), a finalized block to sign against, the gas price.
 * Start it alongside the price quote and hand it to `signAndSendStrokeLocally`,
 * so the quote and these reads cost one round trip together instead of two.
 */
export interface SigningContext {
  key: AccessKeyAllowanceInfo;
  blockHash: string;
  /** Read in parallel; awaited only when the allowance is limited. */
  gasPrice: Promise<bigint>;
}

export function prefetchSigningContext(input: {
  accountId: string;
  networkId: string;
}): Promise<SigningContext> {
  const gasPrice = readRpc<{ gas_price: string }>("gas_price", [null]).then((p) => BigInt(p.gas_price));
  gasPrice.catch(() => undefined);
  const context = Promise.all([
    fetchDrawingSessionAllowance(input),
    provider().viewBlock({ finality: "final" }),
  ]).then(([key, block]) => ({ key, blockHash: block.header.hash, gasPrice }));
  // A prefetch whose paint is then refused (price, balance) is never awaited.
  context.catch(() => undefined);
  return context;
}

const ALLOWANCE_SHORT =
  "This drawing session has too little gas allowance for the next batch. Authorize a new session to continue.";

/** How long a sent batch is looked for by hash before it is reported as unknown. */
export interface TxWaitTiming {
  pollMs: number;
  deadlineMs: number;
}
const DEFAULT_TX_WAIT: TxWaitTiming = { pollMs: 1_000, deadlineMs: 30_000 };

/**
 * Submit a stroke's atomic batches, pipelined. Never retry or switch paths.
 *
 * 1. One read for everything the signatures need, in parallel: the key (allowance
 *    and nonce), a finalized block, and the gas price.
 * 2. Sign every batch the allowance covers, with nonces n+1, n+2, ... against
 *    that one block.
 * 3. Broadcast in nonce order. Each send waits only for the node's acknowledgement
 *    before the next leaves, so the chain sees them in order; the last one's send
 *    waits for execution directly, saving a round trip.
 * 4. Wait for every batch's result at once, by its hash.
 *
 * A stroke of k batches now costs about one execution wait instead of k.
 *
 * A send the node refuses (bad nonce, allowance, expired block) stored nothing and
 * stops any later sends. A send that fails any other way is looked up by its hash;
 * if it never shows up it is reported as uncertain, never as failed. A batch that
 * executes and fails does not stop batches already sent, so a stroke can end with
 * a hole in the middle: callers read `chunks`, never a prefix.
 */
export async function signAndSendStrokeLocally(args: {
  accountId: string;
  networkId: string;
  cells: readonly StrokeCell[];
  color: number;
  /** Paid board: `max_credits` for each draw_many chunk, in order. */
  maxCredits?: readonly number[] | null;
  /** Reads started earlier (alongside the quote); read now when absent. */
  prepared?: Promise<SigningContext>;
  /**
   * Return as soon as every receipt is known and resolve block heights in the
   * background (`executedBlocksLater`). A lone tap uses this: its UI settles on
   * the receipt instead of one more round trip.
   */
  deferBlockHeights?: boolean;
  /** Test seam: polling for a sent batch. */
  timing?: TxWaitTiming;
}): Promise<LocalStrokeResult> {
  const timing = args.timing ?? DEFAULT_TX_WAIT;
  const heightLookups: Array<Promise<void>> = [];
  const chunks = chunkCells([...args.cells]);
  const results: LocalChunkResult[] = chunks.map((_, index) => ({
    index, state: "not_sent", message: null, transactionHash: null, blockHeight: null,
  }));
  const outcomes: Array<FinalExecutionOutcome | null> = chunks.map(() => null);
  if (chunks.length === 0) return summarize(results, outcomes, heightLookups);
  const rpc = provider();

  // 1–2. Read once, sign everything the allowance covers.
  const signed: Array<{ hash: string; tx: SignedTransaction }> = [];
  try {
    const record = requireActiveRecord(args.accountId, args.networkId);
    const signer = signerFromRecord(record);
    const [{ key, blockHash: signingBlock, gasPrice }, publicKey] = await Promise.all([
      args.prepared ?? prefetchSigningContext(args),
      signer.getPublicKey(),
    ]);
    if (!key.found) {
      throw new LocalDrawError("key_missing", "Authorize a new drawing session before continuing.");
    }
    if (key.nonce === undefined) {
      throw new LocalDrawError("rpc", "The node did not report the drawing key's nonce, so no batch was signed.");
    }
    let affordable = chunks.length;
    if (key.remainingYocto !== null) {
      // Reserve prepaid gas at the current RPC price, with headroom for
      // transaction fees and the protocol's gas-price inflation margin.
      const reserve = BigInt(DRAW_GAS) * (await gasPrice) * 2n;
      const covered = BigInt(key.remainingYocto) / reserve;
      affordable = covered < BigInt(chunks.length) ? Number(covered) : chunks.length;
      if (affordable === 0) throw new LocalDrawError("allowance_exhausted", ALLOWANCE_SHORT);
    }
    const blockHash = baseDecode(signingBlock);
    for (let i = 0; i < affordable; i++) {
      const tx = createTransaction(
        args.accountId,
        publicKey,
        CONTRACT_ID,
        BigInt(key.nonce) + BigInt(i + 1),
        [actionCreators.functionCall(
          "draw_many",
          withMaxCredits(chunkArgs(chunks[i]!, args.color), args.maxCredits?.[i]),
          BigInt(DRAW_GAS),
          BigInt(DRAW_DEPOSIT),
        )],
        blockHash,
      );
      const [hash, signedTx] = await signer.signTransaction(tx);
      signed.push({ hash: baseEncode(hash), tx: signedTx });
    }
    for (let i = affordable; i < chunks.length; i++) results[i]!.message = ALLOWANCE_SHORT;
  } catch (error) {
    results[0]!.message = error instanceof Error ? error.message : String(error);
    return summarize(results, outcomes, heightLookups);
  }

  /** Turn a returned outcome into this batch's result. */
  const settle = async (index: number, outcome: FinalExecutionOutcome): Promise<void> => {
    outcomes[index] = outcome;
    const parsed = parseTxOutcome(outcome);
    const result = results[index]!;
    if (hasRecognizedTxSuccess(parsed)) {
      result.state = "confirmed";
      const lookup = resolveExecutedBlockHeight(parsed.blockHash).then((height) => {
        result.blockHeight = height;
      });
      heightLookups.push(lookup);
      if (!args.deferBlockHeights) await lookup;
    } else if (parsed.status === "failed") {
      result.state = "failed";
      result.message = parsed.failureMessage ?? "The batch failed on chain.";
    } else {
      result.state = "uncertain";
      result.message = "Batch execution is still unconfirmed.";
    }
  };
  /** A send that did not come back with an outcome: refused, or look it up by hash. */
  const recover = async (index: number, error: unknown): Promise<void> => {
    const result = results[index]!;
    const message = error instanceof Error ? error.message : String(error);
    if (isRefusedTransaction(error)) {
      result.state = "failed";
      result.message = message;
      if (isDrawingKeyLow(message)) logAllowanceRefusal(message);
      return;
    }
    try {
      await settle(index, await waitForTransaction(rpc, result.transactionHash!, args.accountId, timing));
    } catch {
      result.state = "uncertain";
      result.message = message;
    }
  };

  // 3. Broadcast in nonce order.
  const waits: Array<Promise<void>> = [];
  for (const [index, { hash, tx }] of signed.entries()) {
    results[index]!.transactionHash = hash;
    // From here a transaction may exist: never report this batch as not sent.
    results[index]!.state = "uncertain";
    if (index === signed.length - 1) {
      waits.push(
        (rpc.sendTransactionUntil(tx, "EXECUTED_OPTIMISTIC") as Promise<FinalExecutionOutcome>)
          .then((outcome) => settle(index, outcome), (error) => recover(index, error)),
      );
      break;
    }
    try {
      await rpc.sendTransactionUntil(tx, "NONE");
    } catch (error) {
      waits.push(recover(index, error));
      for (let later = index + 1; later < signed.length; later++) {
        results[later]!.message = "Not sent: an earlier batch's send failed.";
      }
      break;
    }
    waits.push(
      waitForTransaction(rpc, hash, args.accountId, timing)
        .then((outcome) => settle(index, outcome), (error) => recover(index, error)),
    );
  }
  // 4. Every result at once.
  await Promise.all(waits);
  return summarize(results, outcomes, heightLookups);
}

function executedBlocksOf(results: LocalChunkResult[]): Array<{ chunkIndex: number; blockHeight: number }> {
  return results
    .filter((r) => r.state === "confirmed" && r.blockHeight !== null)
    .map((r) => ({ chunkIndex: r.index, blockHeight: r.blockHeight! }));
}

function summarize(
  results: LocalChunkResult[],
  outcomes: Array<FinalExecutionOutcome | null>,
  heightLookups: Array<Promise<void>>,
): LocalStrokeResult {
  const firstBad = results.find((r) => r.state !== "confirmed") ?? null;
  return {
    status: firstBad ? "partial" : "confirmed",
    confirmedChunks: results.filter((r) => r.state === "confirmed").length,
    totalChunks: results.length,
    outcomes: outcomes.filter((o): o is FinalExecutionOutcome => o !== null),
    chunks: results,
    failingChunk: firstBad
      ? { index: firstBad.index, mayHaveBroadcast: firstBad.state === "uncertain", message: firstBad.message ?? "" }
      : null,
    executedBlocks: executedBlocksOf(results),
    // Lookups never reject (a failed one resolves to no height).
    executedBlocksLater: Promise.all(heightLookups).then(() => executedBlocksOf(results)),
  };
}

/**
 * The node rejected the transaction at validation, so it was never included and
 * nothing it carried can land. Anything not recognised here stays uncertain.
 */
/**
 * Record the gas behind a refusal. The chain's quoted cost has not
 * been reconciled with `DRAW_GAS` (docs/learning/traps.md), and an invalid transaction
 * never lands, so this console line is the only evidence one leaves. Best-effort: a
 * failed price read must not change what the painter sees.
 */
function logAllowanceRefusal(message: string): void {
  const quotedCostYocto = quotedRefusalCostYocto(message);
  void readRpc<{ gas_price: string }>("gas_price", [null])
    .then((price) => price.gas_price, () => null)
    .then((gasPrice) => {
      // `attachedGas` is what this code asked for, not proof of what went on the
      // wire, so also log what that gas should have cost against the chain's
      // quote. The ratio settles the open question: ~1 blames something other
      // than the gas limit, ~10 means the chain priced ten times the attached gas.
      const expectedCostYocto =
        gasPrice === null ? null : (BigInt(DRAW_GAS) * BigInt(gasPrice)).toString();
      console.error("[wall] drawing key refused:", {
        attachedGas: DRAW_GAS,
        gasPrice,
        expectedCostYocto,
        quotedCostYocto,
        quotedOverExpected: refusalCostRatio(quotedCostYocto, DRAW_GAS, gasPrice),
        message,
      });
    });
}

function isRefusedTransaction(error: unknown): boolean {
  const e = error as { type?: unknown; message?: unknown } | null;
  const text = `${typeof e?.type === "string" ? e.type : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  return /InvalidTxError|INVALID_TRANSACTION|InvalidNonce|NonceTooLarge|\bExpired\b|NotEnoughAllowance|NotEnoughBalance|InvalidSignature|AccessKeyNotFound|InvalidAccessKey|MethodNameMismatch|ReceiverMismatch/.test(text);
}

/** "Not seen yet" and "still waiting" answers: ask again until the deadline. */
function isNotYetKnown(error: unknown): boolean {
  const e = error as { type?: unknown; message?: unknown } | null;
  const text = `${typeof e?.type === "string" ? e.type : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  return /UNKNOWN_TRANSACTION|doesn't exist|does not exist|TIMEOUT|Timeout|timed out/i.test(text);
}

/** A sent transaction's outcome by hash, looked for until the deadline. */
async function waitForTransaction(
  rpc: JsonRpcProvider,
  hash: string,
  accountId: string,
  timing: TxWaitTiming,
): Promise<FinalExecutionOutcome> {
  const deadline = Date.now() + timing.deadlineMs;
  for (;;) {
    try {
      return (await rpc.txStatus(hash, accountId, "EXECUTED_OPTIMISTIC")) as FinalExecutionOutcome;
    } catch (error) {
      if (!isNotYetKnown(error) || Date.now() + timing.pollMs > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
    }
  }
}
