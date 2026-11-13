/**
 * Who covered an account's tiles, and how many, since a time (spec AWAY-A, §1.2).
 *
 * `GET {VITE_BOARD_SERVER_URL}/api/account-covers?account=<id>&since_ms=<ms>` answers
 * `{ count, by: [{ account, tiles }], first: { x, y } | null }`. The server keeps the cover
 * events; this module only reads them, and never talks to the chain or touches money.
 *
 * The "While you were away" card prints these numbers, and it must never print a number the
 * page cannot back. So every way this can go wrong — no server configured, a network error,
 * a timeout, a non-2xx, a body that is not exactly the shape above — reads as `null`
 * ("unavailable"), and the card falls back to this browser's memory. It never throws.
 */

export interface AccountCoverer {
  account: string;
  tiles: number;
}

export interface AccountCovers {
  /** Tiles of this account covered by someone else since `since_ms`. */
  count: number;
  /** Who covered them, most tiles first. */
  by: AccountCoverer[];
  /** A covered tile to show on the wall; null exactly when `count` is 0. */
  first: { x: number; y: number } | null;
}

export interface AccountCoversOptions {
  /** `VITE_BOARD_SERVER_URL`. Empty means no server: every read is `null` and no request is made. */
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type ReadAccountCovers = (account: string, sinceMs: number) => Promise<AccountCovers | null>;

export const ACCOUNT_COVERS_TIMEOUT_MS = 5_000;

/** Tile coordinates are small non-negative integers; anything else is not a tile. */
const MAX_COORD = 1_000_000;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function coord(value: unknown): number | null {
  const n = count(value);
  return n !== null && n < MAX_COORD ? n : null;
}

/**
 * Validate a response body. Anything that does not hold together is `null`, not a partial
 * answer: a count with no `first`, a coverer credited with more tiles than were covered, or a
 * blank account name would all put a number on screen that nothing backs.
 */
export function parseAccountCovers(body: unknown): AccountCovers | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const total = count(raw.count);
  if (total === null || !Array.isArray(raw.by)) return null;

  const by: AccountCoverer[] = [];
  let credited = 0;
  for (const entry of raw.by as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const tiles = count(row.tiles);
    if (typeof row.account !== "string" || row.account.trim() === "" || tiles === null || tiles === 0) return null;
    credited += tiles;
    by.push({ account: row.account, tiles });
  }
  // Each covered tile has one coverer, so the coverers cannot add up to more than the count.
  if (credited > total) return null;
  if (total === 0 && by.length > 0) return null;
  // The contract says "sorted by tiles desc"; sort anyway so the card never names the wrong one.
  by.sort((a, b) => b.tiles - a.tiles || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));

  let first: AccountCovers["first"] = null;
  if (raw.first !== null && raw.first !== undefined) {
    if (typeof raw.first !== "object") return null;
    const cell = raw.first as Record<string, unknown>;
    const x = coord(cell.x);
    const y = coord(cell.y);
    if (x === null || y === null) return null;
    first = { x, y };
  }
  if ((total === 0) !== (first === null)) return null;
  return { count: total, by, first };
}

/** A reader for the configured server, or `null` when `VITE_BOARD_SERVER_URL` is unset. */
export function createAccountCoversReader(options: AccountCoversOptions): ReadAccountCovers | null {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return null;
  return async (account, sinceMs) => {
    if (!account || !Number.isFinite(sinceMs) || sinceMs < 0) return null;
    const query = new URLSearchParams({ account, since_ms: String(Math.floor(sinceMs)) });
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // The deadline covers the body as well as the headers, and holds even for a fetcher
    // that ignores the abort signal.
    const deadline = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, options.timeoutMs ?? ACCOUNT_COVERS_TIMEOUT_MS);
    });
    const read = (async () => {
      const response = await (options.fetcher ?? fetch)(`${baseUrl}/api/account-covers?${query}`, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return parseAccountCovers(await response.json());
    })();
    try {
      return await Promise.race([read, deadline]);
    } catch {
      // Network error, abort or a body that is not JSON: unavailable, not zero.
      return null;
    } finally {
      clearTimeout(timeout);
      read.catch(() => undefined);
    }
  };
}
