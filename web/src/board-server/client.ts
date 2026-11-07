/**
 * Browser client for the board server (`ops/board-server/`, a port of Berry Fast).
 *
 * Mirrors Berry Fast's `frontend/src/hooks/useBoard.ts`:
 * 1. the region blob cached in IndexedDB;
 * 2. `GET /api/regions?coords=0,0` for its `last_updated`;
 * 3. the blob (and the per-tile `written_at_ns`) fetched only when the server's is newer;
 * 4. WebSocket draws applied to the cached copy, with reconnect, backoff and `catch_up`.
 *
 * This module reads board state only. Prices, credits, quotes and claims stay chain reads
 * in the wall; nothing here touches money. It never talks to the chain either: the wall's
 * trust check does that (`pages/wall/board-controller.ts`).
 */
import type { PixelView } from "@shared/types.ts";
import { parseChainJson } from "../chain-json";
import {
  decodeRegionBlob,
  isRegionBlob,
  isWrittenAtBlob,
  paletteIndexOfHex,
  readWrittenAtNs,
  writeBlobPixel,
  writeWrittenAtNs,
} from "./region-blob";
import { indexedDbRegionStore, type CachedRegion, type RegionStore } from "./region-store";
import { isPaletteIndex } from "@shared/palette.ts";

export interface BoardServerHealth {
  status: string;
  lastProcessedBlock: number | null;
  lastAppliedBlock: number | null;
  queueLength: number;
  side: number | null;
}

/** One tile of a pushed draw, normalised for the wall's pixel cache. */
export interface ServerDrawPixel extends PixelView {
  colorIndex: number;
  ownerId: number;
  free: boolean;
  credits: number;
  previousAccountId: string | null;
}

export interface ServerDraw {
  signer: string;
  blockHeight: number;
  blockTimestampMs: number;
  receiptId: string;
  /** In applied order: a tile listed twice ends with the last entry. */
  pixels: ServerDrawPixel[];
}

export interface ServerBoardExpanded {
  from: number;
  to: number;
  blockHeight: number;
  blockTimestampMs: number;
}

/** The region as the wall uses it: painted tiles with artist names and write times. */
export interface ServerRegion {
  pixels: PixelView[];
  lastUpdatedMs: number;
  /** Height of the last applied write, when the server said. */
  lastBlock: number | null;
  /** False when `written_at_ns` is missing, so tile ages (and price estimates) are unknown. */
  hasWrittenAt: boolean;
  /** `x-board-side`, when sent. */
  side: number | null;
  fromCache: boolean;
}

export interface BoardServerHandlers {
  onOpen?(): void;
  onClose?(): void;
  onDraw?(draw: ServerDraw): void;
  onExpanded?(event: ServerBoardExpanded): void;
}

export interface BoardServerClient {
  readonly baseUrl: string;
  loadRegion(): Promise<ServerRegion>;
  health(): Promise<BoardServerHealth>;
  /** Open the socket and keep it open (reconnecting) until `close()`. */
  connect(handlers: BoardServerHandlers): void;
  isOpen(): boolean;
  /** Drop the socket and open a new one (it catches up from the last message seen). */
  reconnect(): void;
  /**
   * Close the socket on purpose (hidden or idle tab) and stop reconnecting until `resume()`.
   * The server counts open sockets as viewers and polls the chain only while it has one.
   * `onClose` still fires if the socket was open; the caller knows it asked for this.
   */
  pause(): void;
  /** Reopen after `pause()`; the new socket sends `catch_up` like any reconnect. */
  resume(): void;
  isPaused(): boolean;
  /**
   * Tell the server this tab just painted, so its indexer looks now instead of at its next
   * poll (up to 30 s) and other viewers see the paint in seconds. Fire-and-forget: it carries
   * no data, a failure changes nothing, and calls within `HINT_MIN_GAP_MS` are dropped, so a
   * stroke of many cells sends one.
   */
  hint(): void;
  close(): void;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
};
export type SocketFactory = (url: string) => SocketLike;

export interface BoardServerOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
  socketFactory?: SocketFactory;
  store?: RegionStore;
  /** Reconnect delay before the first retry; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** HTTP timeout for every request to the server. */
  timeoutMs?: number;
  /** Clock for the hint throttle; tests inject one. */
  now?: () => number;
}

/** Matches the server's limit (`common/src/demand.rs` `HINT_MIN_GAP_MS`). */
export const HINT_MIN_GAP_MS = 2_000;

const REGION_KEY = "0,0";
/** Berry Fast keeps 2 h of draws for catch-up; ask a little less back when nothing was seen. */
const DEFAULT_CATCH_UP_MS = 2 * 60_000;
const DEDUPE_LIMIT = 5_000;
const ACCOUNT_CONCURRENCY = 6;
/** IndexedDB writes are batched: a busy wall would otherwise write 98 KB per draw. */
const PERSIST_DELAY_MS = 2_000;

export function boardServerSocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, "ws")}/ws`;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asDigits(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

/** Parse a pushed message. `parseChainJson` keeps every digit of `written_at_ns`. */
export function parseServerMessage(text: string):
  | { type: "draw"; draw: ServerDraw }
  | { type: "board_expanded"; event: ServerBoardExpanded }
  | null {
  let raw: Record<string, unknown>;
  try {
    raw = parseChainJson(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const blockHeight = asNumber(raw.block_height);
  const blockTimestampMs = asNumber(raw.block_timestamp_ms);
  if (blockHeight === null || blockTimestampMs === null) return null;
  if (raw.type === "board_expanded") {
    const from = asNumber(raw.from);
    const to = asNumber(raw.to);
    if (from === null || to === null) return null;
    return { type: "board_expanded", event: { from, to, blockHeight, blockTimestampMs } };
  }
  if (raw.type !== "draw" || !Array.isArray(raw.pixels) || typeof raw.receipt_id !== "string") return null;
  const pixels: ServerDrawPixel[] = [];
  for (const entry of raw.pixels as Record<string, unknown>[]) {
    if (!entry || typeof entry !== "object") continue;
    const x = asNumber(entry.x);
    const y = asNumber(entry.y);
    const ownerId = asNumber(entry.owner_id);
    const color = asNumber(entry.color);
    const colorIndex = color !== null && isPaletteIndex(color)
      ? color
      : typeof entry.rgb === "string" ? paletteIndexOfHex(entry.rgb) : null;
    const accountId = typeof entry.account_id === "string" ? entry.account_id : null;
    if (x === null || y === null || ownerId === null || colorIndex === null || !accountId) continue;
    pixels.push({
      x, y, colorIndex, ownerId,
      artistAccountId: accountId,
      lastWriteTimestampNs: asDigits(entry.written_at_ns),
      free: entry.free === true,
      credits: asNumber(entry.credits) ?? 0,
      previousAccountId: typeof entry.previous_account_id === "string" ? entry.previous_account_id : null,
    });
  }
  return {
    type: "draw",
    draw: {
      signer: typeof raw.signer === "string" ? raw.signer : "",
      blockHeight,
      blockTimestampMs,
      receiptId: raw.receipt_id,
      pixels,
    },
  };
}

export function createBoardServerClient(options: BoardServerOptions): BoardServerClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const store = options.store ?? indexedDbRegionStore();
  const regionKey = `${baseUrl}|region|${REGION_KEY}`;
  const accountKey = (id: number) => `${baseUrl}|account|${id}`;
  const accounts = new Map<number, string>();
  const backoffBase = options.backoffMs ?? 1_000;
  const backoffMax = options.maxBackoffMs ?? 30_000;

  let region: CachedRegion | null = null;
  let lastSeenTimestampMs: number | null = null;
  const seen = new Set<string>();
  let socket: SocketLike | null = null;
  let open = false;
  let closed = true;
  /** Deliberately disconnected by `pause()`: no socket and no reconnect timer until `resume()`. */
  let paused = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let handlers: BoardServerHandlers = {};

  async function get(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await (options.fetcher ?? fetch)(`${baseUrl}${path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Board server HTTP ${response.status} for ${path}.`);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchRegionMeta(): Promise<number> {
    const body = (await (await get(`/api/regions?coords=${REGION_KEY}`)).json()) as unknown;
    const row = Array.isArray(body) ? (body as Record<string, unknown>[]).find((r) => r?.rx === 0 && r?.ry === 0) : null;
    const lastUpdated = asNumber(row?.last_updated);
    if (lastUpdated === null) throw new Error("Board server /api/regions did not report region 0,0.");
    return lastUpdated;
  }

  async function fetchRegion(): Promise<{ region: CachedRegion; side: number | null }> {
    const [blob, written] = await Promise.all([
      get(`/api/region/${REGION_KEY.replace(",", "/")}`),
      get(`/api/region/${REGION_KEY.replace(",", "/")}/written-at`).catch(() => null),
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isRegionBlob(bytes)) throw new Error(`Board server region is ${bytes.byteLength} bytes.`);
    const lastUpdatedMs = asNumber(blob.headers.get("x-last-updated")) ?? 0;
    const lastBlock = asNumber(blob.headers.get("x-last-block"));
    const side = asNumber(blob.headers.get("x-board-side"));
    let writtenAt: Uint8Array | null = null;
    if (written) {
      const candidate = new Uint8Array(await written.arrayBuffer());
      // Both halves must describe the same write, or the ages belong to other paint.
      if (isWrittenAtBlob(candidate) && asNumber(written.headers.get("x-last-updated")) === lastUpdatedMs) {
        writtenAt = candidate;
      }
    }
    return { region: { bytes, writtenAt, lastUpdatedMs, lastBlock }, side };
  }

  async function resolveAccounts(ids: number[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !accounts.has(id));
    let next = 0;
    async function worker(): Promise<void> {
      while (next < missing.length) {
        const id = missing[next++]!;
        const cached = await store.getAccount(accountKey(id));
        if (cached) { accounts.set(id, cached); continue; }
        try {
          const name = (await (await get(`/api/account/${id}`)).text()).trim();
          if (name) {
            accounts.set(id, name);
            void store.putAccount(accountKey(id), name);
          }
        } catch {
          // Unknown id: the tile shows without a painter rather than with a wrong one.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, missing.length) }, worker));
  }

  async function loadRegion(): Promise<ServerRegion> {
    const cached = region ?? (await store.getRegion(regionKey));
    const serverUpdated = await fetchRegionMeta();
    let side: number | null = null;
    let fromCache = false;
    if (cached && cached.writtenAt && cached.lastUpdatedMs >= serverUpdated) {
      region = cached;
      fromCache = true;
    } else {
      const fetched = await fetchRegion();
      region = fetched.region;
      side = fetched.side;
      void store.putRegion(regionKey, region);
    }
    const current = region;
    if (lastSeenTimestampMs === null || current.lastUpdatedMs > lastSeenTimestampMs) {
      lastSeenTimestampMs = current.lastUpdatedMs;
    }
    const blobPixels = decodeRegionBlob(current.bytes);
    await resolveAccounts(blobPixels.map((p) => p.ownerId));
    return {
      pixels: blobPixels.map((p) => ({
        x: p.x,
        y: p.y,
        colorIndex: p.colorIndex,
        artistAccountId: accounts.get(p.ownerId) ?? null,
        lastWriteTimestampNs: readWrittenAtNs(current.writtenAt, p.x, p.y),
      })),
      lastUpdatedMs: current.lastUpdatedMs,
      lastBlock: current.lastBlock,
      hasWrittenAt: current.writtenAt !== null,
      side,
      fromCache,
    };
  }

  async function health(): Promise<BoardServerHealth> {
    const body = (await (await get("/api/health")).json()) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status : "",
      lastProcessedBlock: asNumber(body.last_processed_block),
      lastAppliedBlock: asNumber(body.last_applied_block),
      queueLength: asNumber(body.queue_length) ?? 0,
      side: asNumber(body.side),
    };
  }

  function schedulePersist(): void {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (region) void store.putRegion(regionKey, region);
    }, PERSIST_DELAY_MS);
  }

  function remember(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > DEDUPE_LIMIT) seen.delete(seen.values().next().value!);
    return true;
  }

  function noteTimestamp(ms: number): void {
    if (lastSeenTimestampMs === null || ms > lastSeenTimestampMs) lastSeenTimestampMs = ms;
  }

  function onMessage(text: string): void {
    const message = parseServerMessage(text);
    if (!message) return;
    if (message.type === "board_expanded") {
      const event = message.event;
      if (!remember(`expanded:${event.blockHeight}:${event.to}`)) return;
      noteTimestamp(event.blockTimestampMs);
      handlers.onExpanded?.(event);
      return;
    }
    const draw = message.draw;
    // catch_up is inclusive of `since`, so a replay can repeat a draw already applied.
    if (!remember(draw.receiptId)) return;
    noteTimestamp(draw.blockTimestampMs);
    for (const pixel of draw.pixels) {
      accounts.set(pixel.ownerId, pixel.artistAccountId!);
      if (region) {
        // Two draws in one block can be replayed out of order; never let an older write
        // overwrite a newer tile (unknown times still apply: there is nothing to compare).
        const existing = readWrittenAtNs(region.writtenAt, pixel.x, pixel.y);
        const incoming = pixel.lastWriteTimestampNs;
        const stale = existing !== null && incoming !== null && BigInt(incoming) < BigInt(existing);
        if (!stale) {
          writeBlobPixel(region.bytes, pixel.x, pixel.y, pixel.colorIndex, pixel.ownerId);
          writeWrittenAtNs(region.writtenAt, pixel.x, pixel.y, incoming);
        }
      }
    }
    if (region && draw.blockTimestampMs >= region.lastUpdatedMs) {
      region.lastUpdatedMs = draw.blockTimestampMs;
      region.lastBlock = Math.max(region.lastBlock ?? 0, draw.blockHeight);
      schedulePersist();
    }
    handlers.onDraw?.(draw);
  }

  function openSocket(): void {
    if (closed || paused) return;
    const factory: SocketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    let ws: SocketLike;
    try {
      ws = factory(boardServerSocketUrl(baseUrl));
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      open = true;
      attempts = 0;
      const since = lastSeenTimestampMs ?? Date.now() - DEFAULT_CATCH_UP_MS;
      try {
        ws.send(JSON.stringify({ type: "catch_up", since_timestamp_ms: since }));
      } catch {
        // A socket that cannot send will close; onclose reconnects.
      }
      handlers.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (typeof event.data === "string") onMessage(event.data);
    };
    ws.onerror = () => {
      // onclose follows; reconnect there.
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      const wasOpen = open;
      open = false;
      if (wasOpen) handlers.onClose?.();
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (closed || paused || reconnectTimer !== null) return;
    const delay = Math.min(backoffMax, backoffBase * 2 ** Math.min(attempts, 10));
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function dropSocket(): void {
    const ws = socket;
    socket = null;
    const wasOpen = open;
    open = false;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
    }
    if (wasOpen) handlers.onClose?.();
  }

  let lastHintMs = -Infinity;
  function hint(): void {
    const now = (options.now ?? Date.now)();
    if (now - lastHintMs < HINT_MIN_GAP_MS) return;
    lastHintMs = now;
    void (options.fetcher ?? fetch)(`${baseUrl}/api/hint`, { method: "POST" }).catch(() => {
      // Only timing depends on it: the indexer's regular poll still finds the paint.
    });
  }

  return {
    baseUrl,
    loadRegion,
    health,
    hint,
    connect(next) {
      handlers = next;
      if (!closed) return;
      closed = false;
      openSocket();
    },
    isOpen: () => open,
    reconnect() {
      if (closed || paused) return;
      dropSocket();
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      scheduleReconnect();
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      attempts = 0;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      dropSocket();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      attempts = 0;
      openSocket();
    },
    isPaused: () => paused,
    close() {
      closed = true;
      paused = false;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
        if (region) void store.putRegion(regionKey, region);
      }
      dropSocket();
    },
  };
}
