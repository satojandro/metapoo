/**
 * Reads the wall's draw log from the board server (TIMELAPSE, return/growth spec §4.3).
 *
 * Two routes (`ops/board-server/server/src/history_api.rs`):
 *
 * - `GET /api/history/head`: what the log holds and **where it starts**. `complete` is true
 *   only once the server's backfill has certified the log from the deploy block; until then
 *   it starts wherever logging began, and the page must say so.
 * - `GET /api/history?epoch=&after=`: pages of up to 20,000 tiles in a compact binary. Every
 *   full page is immutable and comes from the browser's HTTP cache on a second visit; only
 *   the last, partial page is fetched again. So a load is `1 + ceil(tiles / 20,000)`
 *   requests, and after the first visit usually two.
 *
 * Nothing here is ever invented: no server configured, a network error, a timeout, a non-2xx
 * or a body that does not decode all read as "unavailable". It never throws.
 */
import { decodeHistoryPage, type HistoryRecord } from "./history-wire";

export interface HistoryMoment {
  block: number;
  atMs: number;
}

export interface HistoryHead {
  epoch: number;
  /** The log is certified to start at the board's deploy block. */
  complete: boolean;
  startBlock: number | null;
  /** The board's side at the deploy block; known only when `complete`. */
  initialSide: number | null;
  /** Stream rows: tiles painted plus expansions. */
  entries: number;
  first: HistoryMoment | null;
  last: HistoryMoment | null;
  /** The board's side now. */
  side: number;
}

export interface HistoryLog {
  head: HistoryHead;
  records: HistoryRecord[];
  /** Requests made for this load, the head included. */
  requests: number;
}

export interface HistoryReaderOptions {
  /** `VITE_BOARD_SERVER_URL`. Empty means no server: `createHistoryReader` returns null. */
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface HistoryReader {
  readHead(signal?: AbortSignal): Promise<HistoryHead | null>;
  /** The whole log, oldest first, or null when any part of it could not be read. */
  loadLog(onProgress?: (rowsLoaded: number, head: HistoryHead) => void, signal?: AbortSignal): Promise<HistoryLog | null>;
}

export const HISTORY_TIMEOUT_MS = 15_000;
/** A log that keeps answering "more" past this many pages is not one this page should trust. */
export const MAX_HISTORY_PAGES = 2_000;

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function moment(value: unknown): HistoryMoment | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const block = whole(raw.block);
  const atMs = whole(raw.at_ms);
  return block === null || atMs === null ? undefined : { block, atMs };
}

/** Validate a head body. Anything that does not hold together is null, not a partial answer. */
export function parseHistoryHead(body: unknown): HistoryHead | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const epoch = whole(raw.epoch);
  const entries = whole(raw.entries);
  const side = whole(raw.side);
  const first = moment(raw.first);
  const last = moment(raw.last);
  if (epoch === null || entries === null || side === null || side < 1 || side > 128) return null;
  if (typeof raw.complete !== "boolean" || first === undefined || last === undefined) return null;
  // An empty log has no first entry and a log with entries has both ends.
  if ((entries === 0) !== (first === null) || (first === null) !== (last === null)) return null;
  const startBlock = raw.start_block === null ? null : whole(raw.start_block);
  const initialSide = raw.initial_side === null ? null : whole(raw.initial_side);
  // "Complete" is a claim about where the log starts; without the where, it is not believed.
  if (raw.complete && (startBlock === null || initialSide === null || initialSide < 1 || initialSide > 128)) return null;
  return { epoch, complete: raw.complete, startBlock, initialSide, entries, first, last, side };
}

/** A reader for the configured server, or null when `VITE_BOARD_SERVER_URL` is unset. */
export function createHistoryReader(options: HistoryReaderOptions): HistoryReader | null {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return null;
  const timeoutMs = options.timeoutMs ?? HISTORY_TIMEOUT_MS;

  /** One GET with a deadline that covers the body too. Null on any failure. */
  async function get<T>(path: string, read: (response: Response) => Promise<T | null>, signal?: AbortSignal): Promise<{ status: number; value: T | null } | null> {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await (options.fetcher ?? fetch)(`${baseUrl}${path}`, { signal: controller.signal });
      return { status: response.status, value: response.ok ? await read(response) : null };
    })();
    try {
      return await Promise.race([request, deadline]);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      request.catch(() => undefined);
    }
  }

  async function readHead(signal?: AbortSignal): Promise<HistoryHead | null> {
    const answer = await get("/api/history/head", async (r) => parseHistoryHead(await r.json()), signal);
    return answer?.value ?? null;
  }

  async function loadOnce(
    onProgress: ((rows: number, head: HistoryHead) => void) | undefined,
    signal: AbortSignal | undefined,
    counter: { requests: number },
  ): Promise<HistoryLog | "stale" | null> {
    counter.requests += 1;
    const head = await readHead(signal);
    if (!head) return null;
    const records: HistoryRecord[] = [];
    let rows = 0;
    let after: string | null = null;
    if (head.entries > 0) {
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const query: string = `?epoch=${head.epoch}${after ? `&after=${after}` : ""}`;
        counter.requests += 1;
        const answer = await get(`/api/history${query}`, async (r) => decodeHistoryPage(await r.arrayBuffer()), signal);
        if (answer?.status === 409) return "stale";
        const decoded = answer?.value;
        if (!decoded) return null;
        records.push(...decoded.records);
        rows += decoded.rows;
        onProgress?.(rows, head);
        if (!decoded.more) return { head, records, requests: counter.requests };
        // A full page with no cursor cannot be followed.
        if (!decoded.next || decoded.next === after) return null;
        after = decoded.next;
      }
      return null;
    }
    return { head, records, requests: counter.requests };
  }

  return {
    readHead,
    async loadLog(onProgress, signal) {
      const counter = { requests: 0 };
      // 409: the server's backfill rewrote the log while we were reading it. Start again
      // from the new head, once; a second 409 is something else.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await loadOnce(onProgress, signal, counter);
        if (result !== "stale") return result;
      }
      return null;
    },
  };
}
