/**
 * /money buyback ledger (toilet-round spec §K4, §F4): NEAR the board sent to the buyback
 * account, mPOO the buyback account sent back, and NEAR waiting on the buyback account.
 *
 * The totals come from the board's own events (`contracts/paid-board/src/revenue.rs`):
 *
 *   EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"near_distributed",
 *     "data":[{"amount","team_account","team","buyback_account","buyback","status":"scheduled"}]}
 *   EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"near_distribution_leg_failed",
 *     "data":[{"account","amount"}]}
 *   EVENT_JSON:{"standard":"mpoo_payments","version":"1.0.0","event":"mpoo_revenue_received",
 *     "data":[{"sender_id","amount"}]}
 *
 * `near_distributed` is logged before the transfers leave ("scheduled"). A leg that fails
 * refunds the board and is sent again by a later split, so a failed buyback leg is
 * subtracted here or that NEAR would be counted twice.
 *
 * Two `LedgerSource`s, chosen per read by `createPreferredLedgerSource`:
 *
 * - the board's own running totals, `get_buyback_totals()` (TR-B), exact and all-time;
 * - for boards without that view (MethodNotFound), the public NearBlocks receipt index
 *   (which board receipts to look at) plus archival RPC (their logs), since NEAR RPC has
 *   no event index. It may be incomplete and says so.
 *
 * Any other failure makes the figure unavailable, never zero, and never silently swaps
 * an exact source for a partial one.
 */

import { parseChainJson } from "../chain-json";
import { rpcHeaders } from "../config";
import { isMethodNotFound, type View } from "./revenue-panel";

export const PAYMENTS_EVENT_STANDARD = "mpoo_payments";
export const PAYMENTS_EVENT_VERSION = "1.0.0";

export type LedgerEvent =
  | {
      kind: "near_distributed";
      txHash: string;
      receiptId: string;
      amount: bigint;
      team: bigint;
      buyback: bigint;
      teamAccount: string;
      buybackAccount: string;
    }
  | { kind: "near_leg_failed"; txHash: string; receiptId: string; account: string; amount: bigint }
  | { kind: "mpoo_revenue_received"; txHash: string; receiptId: string; senderId: string; amount: bigint };

const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const TRACKED = new Set(["near_distributed", "near_distribution_leg_failed", "mpoo_revenue_received"]);

function u128(data: Record<string, unknown>, key: string, event: string): bigint {
  const value = data[key];
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${event}: ${key} is not a U128 string`);
  return BigInt(value);
}

function account(data: Record<string, unknown>, key: string, event: string): string {
  const value = data[key];
  if (typeof value !== "string" || !ACCOUNT_ID.test(value)) throw new Error(`${event}: ${key} is not an account id`);
  return value;
}

type ParsedEvent =
  | Omit<Extract<LedgerEvent, { kind: "near_distributed" }>, "txHash" | "receiptId">
  | Omit<Extract<LedgerEvent, { kind: "near_leg_failed" }>, "txHash" | "receiptId">
  | Omit<Extract<LedgerEvent, { kind: "mpoo_revenue_received" }>, "txHash" | "receiptId">;

/**
 * One log line → the ledger events it carries. Lines that are not board payment events,
 * or are payment events the ledger doesn't count, give `[]`. A ledger event in a shape
 * this page doesn't know throws: an undercount presented as a total is worse than
 * "unavailable".
 */
export function parseLedgerLog(log: string): ParsedEvent[] {
  if (!log.startsWith("EVENT_JSON:")) return [];
  let body: unknown;
  try {
    body = parseChainJson(log.slice("EVENT_JSON:".length));
  } catch {
    return [];
  }
  if (!body || typeof body !== "object") return [];
  const { standard, version, event, data } = body as Record<string, unknown>;
  if (standard !== PAYMENTS_EVENT_STANDARD || typeof event !== "string" || !TRACKED.has(event)) return [];
  if (version !== PAYMENTS_EVENT_VERSION) throw new Error(`${event}: unknown event version ${String(version)}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${event}: data is not a non-empty array`);
  return data.map((item): ParsedEvent => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${event}: data item is not an object`);
    const d = item as Record<string, unknown>;
    if (event === "near_distributed") {
      const amount = u128(d, "amount", event);
      const team = u128(d, "team", event);
      const buyback = u128(d, "buyback", event);
      if (team + buyback !== amount) throw new Error("near_distributed: team + buyback differs from amount");
      if (d.status !== "scheduled") throw new Error(`near_distributed: unknown status ${String(d.status)}`);
      return {
        kind: "near_distributed", amount, team, buyback,
        teamAccount: account(d, "team_account", event), buybackAccount: account(d, "buyback_account", event),
      };
    }
    if (event === "near_distribution_leg_failed") {
      return { kind: "near_leg_failed", account: account(d, "account", event), amount: u128(d, "amount", event) };
    }
    return { kind: "mpoo_revenue_received", senderId: account(d, "sender_id", event), amount: u128(d, "amount", event) };
  });
}

/**
 * Ledger events in an RPC `tx` / `EXPERIMENTAL_tx_status` result. Only receipts the board
 * executed count, and only ones that succeeded: a failed receipt's state is rolled back,
 * whatever it logged.
 */
export function eventsFromTxStatus(result: unknown, board: string, txHash: string): LedgerEvent[] {
  const receipts = (result as { receipts_outcome?: unknown } | null)?.receipts_outcome;
  if (!Array.isArray(receipts)) throw new Error("tx status: no receipts_outcome");
  const events: LedgerEvent[] = [];
  for (const receipt of receipts as Array<Record<string, unknown>>) {
    const outcome = receipt?.outcome as { executor_id?: unknown; logs?: unknown; status?: unknown } | undefined;
    if (!outcome || outcome.executor_id !== board || !Array.isArray(outcome.logs)) continue;
    const status = outcome.status as Record<string, unknown> | undefined;
    if (!status || typeof status !== "object" || "Failure" in status) continue;
    const receiptId = typeof receipt.id === "string" ? receipt.id : "";
    for (const log of outcome.logs) {
      if (typeof log !== "string") continue;
      for (const parsed of parseLedgerLog(log)) events.push({ ...parsed, txHash, receiptId } as LedgerEvent);
    }
  }
  return events;
}

export interface LedgerTotals {
  /** NEAR (yocto) the board sent to the buyback account, failed legs taken out. */
  nearToBuyback: bigint;
  /** `near_distributed` events counted; null when the source keeps only sums. */
  nearDistributions: number | null;
  /** mPOO (1e-18) the buyback account sent back and the board accepted. */
  mpooReturned: bigint;
  /** `mpoo_revenue_received` events counted; null when the source keeps only sums. */
  mpooReturns: number | null;
}

/**
 * Sum the ledger. A failed leg is matched to the `near_distributed` of the same
 * transaction whose buyback leg it is (same account and amount); a failed team leg
 * doesn't touch the buyback total.
 */
export function aggregateLedger(events: readonly LedgerEvent[]): LedgerTotals {
  const seen = new Set<string>();
  const unique = events.filter(e => {
    const key = `${e.txHash}|${e.receiptId}|${e.kind}|${e.amount}|${"account" in e ? e.account : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const totals = { nearToBuyback: 0n, nearDistributions: 0, mpooReturned: 0n, mpooReturns: 0 };
  // Buyback legs still unmatched by a failure, per transaction.
  const openLegs = new Map<string, Array<{ account: string; amount: bigint }>>();
  for (const e of unique) {
    if (e.kind === "near_distributed") {
      totals.nearToBuyback += e.buyback;
      totals.nearDistributions += 1;
      const legs = openLegs.get(e.txHash) ?? [];
      legs.push({ account: e.buybackAccount, amount: e.buyback });
      openLegs.set(e.txHash, legs);
    } else if (e.kind === "mpoo_revenue_received") {
      totals.mpooReturned += e.amount;
      totals.mpooReturns += 1;
    }
  }
  for (const e of unique) {
    if (e.kind !== "near_leg_failed") continue;
    const legs = openLegs.get(e.txHash);
    const i = legs?.findIndex(l => l.account === e.account && l.amount === e.amount) ?? -1;
    if (legs && i >= 0) {
      totals.nearToBuyback -= legs[i].amount;
      legs.splice(i, 1);
    }
  }
  return totals;
}

/** What a source read. */
export interface LedgerHistory {
  /** "board": the board's own running totals, exact. "index": events found through a public index. */
  origin: "board" | "index";
  /** e.g. "NearBlocks receipt index + archival RPC logs". */
  label: string;
  totals: LedgerTotals;
  /** False when history exists that wasn't read: the totals are lower bounds. */
  complete: boolean;
  /** Board transactions whose logs were read; null for the board's own totals. */
  transactions: number | null;
  /** Block time (ms) the index has reached; null when the source reads the chain head itself. */
  indexedThroughMs: number | null;
}

/** Where the totals come from. */
export interface LedgerSource {
  scan(): Promise<LedgerHistory>;
  /** Which kind of source the last scan used, success or not (sets the re-read pace). */
  readonly lastTried?: LedgerHistory["origin"] | null;
}

export interface LedgerSnapshot {
  buybackAccount: string;
  /** Null when no source exists for this network or its read failed. */
  history: LedgerHistory | null;
  /** Why `history` is null, in words fit for the page; null for an unexplained failure. */
  historyError: string | null;
  /** The kind of source this read used or tried; null when unknown. */
  tried: LedgerHistory["origin"] | null;
  /** NEAR (yocto) on the buyback account; null when that read failed. */
  waiting: bigint | null;
}

/** A failure the page can explain as it is (no index on this network, index stalled). */
export class LedgerUnavailable extends Error {}

/** Both reads, each allowed to fail on its own. */
export async function loadBuybackLedger(
  source: LedgerSource | null,
  readBalance: (account: string) => Promise<bigint>,
  buybackAccount: string,
): Promise<LedgerSnapshot> {
  const [scan, balance] = await Promise.allSettled([
    source ? source.scan() : Promise.reject(new LedgerUnavailable("There’s no public event index for this network.")),
    readBalance(buybackAccount),
  ]);
  return {
    buybackAccount,
    history: scan.status === "fulfilled" ? scan.value : null,
    tried: scan.status === "fulfilled" ? scan.value.origin : source?.lastTried ?? null,
    historyError: scan.status === "rejected" && scan.reason instanceof LedgerUnavailable ? scan.reason.message : null,
    waiting: balance.status === "fulfilled" ? balance.value : null,
  };
}

/**
 * `get_buyback_totals()` → `{"near_to_buyback": "<yocto>", "mpoo_returned": "<1e-18>"}`.
 * Both decimal strings (U128); a number, a sign or a missing field is refused.
 */
export function parseBuybackTotals(raw: unknown): { nearToBuyback: bigint; mpooReturned: bigint } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("get_buyback_totals: not an object");
  const r = raw as Record<string, unknown>;
  const read = (key: string): bigint => {
    const value = r[key];
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`get_buyback_totals: ${key} is not a decimal U128 string`);
    return BigInt(value);
  };
  return { nearToBuyback: read("near_to_buyback"), mpooReturned: read("mpoo_returned") };
}

export const BOARD_TOTALS_LABEL = "board’s own running totals (get_buyback_totals)";
export const INDEX_LABEL = "NearBlocks receipt index + archival RPC logs";

/**
 * The board's running totals. Exact and all-time: `near_to_buyback` counts only NEAR that
 * reached the buyback account, so failed and resent legs are already out. Errors propagate
 * as they are (a MethodNotFound is how the caller tells an older board).
 */
export function createBoardTotalsSource(view: View, board: string): LedgerSource {
  return {
    async scan() {
      const t = parseBuybackTotals(await view(board, "get_buyback_totals"));
      return {
        origin: "board", label: BOARD_TOTALS_LABEL, complete: true, transactions: null, indexedThroughMs: null,
        totals: { nearToBuyback: t.nearToBuyback, nearDistributions: null, mpooReturned: t.mpooReturned, mpooReturns: null },
      };
    },
  };
}

/**
 * The board's totals when the board has them; the index only for a board deployed before
 * `get_buyback_totals` existed. Any other failure of the view is reported, never covered
 * by the partial index. Checked on every read, so an upgraded board switches on its own.
 */
export function createPreferredLedgerSource(board: LedgerSource, fallback: LedgerSource | null): LedgerSource {
  let lastTried: LedgerHistory["origin"] | null = null;
  return {
    get lastTried() {
      return lastTried;
    },
    async scan() {
      lastTried = "board";
      try {
        return await board.scan();
      } catch (error) {
        if (!isMethodNotFound(error)) throw new LedgerUnavailable("Couldn’t read the board’s buyback totals.");
      }
      lastTried = "index";
      if (!fallback) throw new LedgerUnavailable("This board keeps no buyback totals, and there’s no public event index for this network.");
      return fallback.scan();
    },
  };
}

/** An index this far behind still gives true lower bounds. */
export const INDEX_LAG_OK_MS = 60 * 60_000;
/** Beyond this, the index is treated as stopped: a stalled index would hide a stalled buyback. */
export const INDEX_LAG_MAX_MS = 24 * 60 * 60_000;

/** Public NearBlocks API for a network, or null where there is none. */
export function nearblocksApiBase(network: string): string | null {
  if (network === "mainnet") return "https://api.nearblocks.io";
  if (network === "testnet") return "https://api-testnet.nearblocks.io";
  return null;
}

/** Public archival RPC: ordinary RPC nodes forget transactions after a few epochs. */
export function archivalRpcUrl(network: string): string | null {
  if (network === "mainnet") return "https://archival-rpc.mainnet.near.org";
  if (network === "testnet") return "https://archival-rpc.testnet.near.org";
  return null;
}

/** True when an `ft_on_transfer` receipt's args carry the board's `{"revenue":{}}` message. */
export function isRevenueTransferArgs(args: unknown): boolean | null {
  if (typeof args !== "string") return null;
  try {
    const parsed = JSON.parse(args) as { msg?: unknown };
    if (typeof parsed?.msg !== "string") return null;
    const msg = JSON.parse(parsed.msg) as unknown;
    return !!msg && typeof msg === "object" && !Array.isArray(msg)
      && Object.keys(msg).length === 1 && JSON.stringify((msg as Record<string, unknown>).revenue) === "{}";
  } catch {
    return null;
  }
}

export interface IndexedSourceOptions {
  network: string;
  board: string;
  /** The board's mPOO token: the only predecessor of a real `ft_on_transfer`. */
  mpooToken: string | null;
  rpcUrl?: string;
  fetch?: typeof fetch;
  /** Index pages per method (100 receipts each). */
  maxPages?: number;
  /** Transactions whose logs are read per scan; the rest leave the scan incomplete. */
  maxTransactions?: number;
  timeoutMs?: number;
  /** Wall clock (ms), to tell how far the index is behind. */
  now?: () => number;
}

/**
 * NearBlocks lists the board's `distribute_near` and `ft_on_transfer` receipts; an archival
 * RPC returns each transaction's logs. Revenue transfers are told apart from mPOO credit
 * purchases by their `{"revenue":{}}` message, so purchases are never fetched. Logs are
 * immutable once final, so each transaction is read once per source.
 */
export function createIndexedLedgerSource(options: IndexedSourceOptions): LedgerSource | null {
  const base = nearblocksApiBase(options.network);
  const rpc = options.rpcUrl ?? archivalRpcUrl(options.network);
  if (!base || !rpc) return null;
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const maxPages = options.maxPages ?? 3;
  const maxTransactions = options.maxTransactions ?? 60;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? (() => Date.now());
  const { board } = options;
  const cache = new Map<string, LedgerEvent[]>();

  async function getJson(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Newest first. `more` is true when the index has older receipts than were read. */
  async function listHashes(method: "distribute_near" | "ft_on_transfer"): Promise<{ hashes: string[]; more: boolean }> {
    const hashes: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const url = `${base}/v1/account/${encodeURIComponent(board)}/txns?method=${method}&per_page=100&order=desc`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const body = (await getJson(url)) as { txns?: unknown; cursor?: unknown };
      if (!Array.isArray(body?.txns)) throw new Error("Invalid NearBlocks response");
      for (const row of body.txns as Array<Record<string, unknown>>) {
        const hash = row.transaction_hash;
        if (row.receiver_account_id !== board || typeof hash !== "string" || !TX_HASH.test(hash)) continue;
        if ((row.receipt_outcome as { status?: unknown } | undefined)?.status === false) continue;
        const actions = Array.isArray(row.actions) ? (row.actions as Array<Record<string, unknown>>) : [];
        const calls = actions.filter(a => a?.method === method);
        if (calls.length === 0) continue;
        if (method === "ft_on_transfer") {
          if (options.mpooToken && row.predecessor_account_id !== options.mpooToken) continue;
          // Unreadable args are fetched rather than guessed: only a clear "not revenue" is skipped.
          if (calls.every(a => isRevenueTransferArgs(a.args) === false)) continue;
        }
        hashes.push(hash);
      }
      cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
      if (body.txns.length < 100 || !cursor) return { hashes, more: false };
    }
    return { hashes, more: true };
  }

  async function readTx(hash: string): Promise<LedgerEvent[]> {
    const cached = cache.get(hash);
    if (cached) return cached;
    const body = (await getJson(rpc!, {
      method: "POST",
      headers: rpcHeaders(rpc ?? undefined),
      body: JSON.stringify({
        jsonrpc: "2.0", id: "ledger", method: "tx",
        // An archival node finds the transaction by hash; the sender only routes the lookup.
        params: { tx_hash: hash, sender_account_id: board, wait_until: "FINAL" },
      }),
    })) as { result?: unknown; error?: { message?: string; data?: unknown } };
    if (body?.error) throw new Error(`tx ${hash}: ${body.error.message ?? ""} ${JSON.stringify(body.error.data ?? "")}`);
    const events = eventsFromTxStatus(body?.result, board, hash);
    cache.set(hash, events);
    return events;
  }

  /** Block time (ms) of the newest block the index has processed. */
  async function indexHead(): Promise<number> {
    const body = (await getJson(`${base}/v1/blocks/latest?limit=1`)) as { blocks?: Array<{ block_timestamp?: unknown }> };
    const ns = body?.blocks?.[0]?.block_timestamp;
    if (typeof ns !== "string" || !/^\d+$/.test(ns)) throw new Error("Invalid NearBlocks block response");
    return Number(BigInt(ns) / 1_000_000n);
  }

  return {
    async scan() {
      // The index head first: a stopped index isn't worth paging through (its API is rate-limited).
      const head = await indexHead();
      const lag = now() - head;
      if (lag > INDEX_LAG_MAX_MS) {
        throw new LedgerUnavailable(`The public event index stopped at ${new Date(head).toUTCString()}, so it can’t show recent splits.`);
      }
      const lists = await Promise.all([listHashes("distribute_near"), listHashes("ft_on_transfer")]);
      const all = [...new Set(lists.flatMap(l => l.hashes))];
      const hashes = all.slice(0, maxTransactions);
      const events: LedgerEvent[] = [];
      // A few at a time: this shares the public RPC's rate limit with the rest of the page.
      for (let i = 0; i < hashes.length; i += 4) {
        for (const batch of await Promise.all(hashes.slice(i, i + 4).map(readTx))) events.push(...batch);
      }
      const complete = !lists.some(l => l.more) && all.length <= maxTransactions && lag <= INDEX_LAG_OK_MS;
      return {
        origin: "index", label: INDEX_LABEL, totals: aggregateLedger(events), complete,
        transactions: hashes.length, indexedThroughMs: head,
      };
    },
  };
}

/** Labelled example for the mock preview. */
export function exampleLedger(buybackAccount: string): LedgerSnapshot {
  return {
    buybackAccount,
    history: {
      totals: {
        nearToBuyback: 164_250_000_000_000_000_000_000_000n,
        nearDistributions: null,
        mpooReturned: 1_204_880_000_000_000_000_000_000n,
        mpooReturns: null,
      },
      origin: "board",
      complete: true,
      transactions: null,
      indexedThroughMs: null,
      label: "example",
    },
    historyError: null,
    tried: "board",
    waiting:3_120_000_000_000_000_000_000_000n,
  };
}
