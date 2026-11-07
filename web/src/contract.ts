import { readRpcFetch } from "./read-rpc";
import type { PixelView, PixelsPageView } from "@shared/types.ts";
import { CONTRACT_ID, RPC_URL, rpcHeaders } from "./config";
import { loadAllPaintedPixels } from "./load-board";

/**
 * Talks to the game contract with free "view" calls (reads) over JSON-RPC.
 *
 * A view call does not need a wallet. Anyone can read the board description
 * or one pixel. Change methods like `draw` go through the wallet instead
 * (see `submit-draw.ts`).
 */

/** Default page size for `get_pixels`. The contract clamps at 256. */
export const PIXELS_PAGE_LIMIT = 256;

/** Bound how long we wait on RPC so a hung node cannot freeze the page. */
export const RPC_TIMEOUT_MS = 20_000;

/**
 * Raw JSON shape returned by the Rust contract's `get_board`.
 * Free boards (schema 2) return the core fields only.
 * Paid boards (schema 3) also report snake_case pressure / ledger markers.
 */
export interface ChainBoardView {
  schema_version: number;
  width: number;
  height: number;
  origin: string;
  overwrite_rule: string;
  sponsorship_enabled: boolean;
  palette: Array<{ index: number; name: string; hex: string }>;
  /** Paid schema 3: pricing schedule id (e.g. pressure-v1-fixture). */
  pricing_version?: string;
  /** Paid schema 3: pressure config object from the board contract. */
  pressure?: Record<string, unknown>;
  /** Paid schema 3: ledger unit label (e.g. TOILET). */
  ledger_unit?: string;
  chain_id?: string;
  board_account_id?: string;
  board_epoch?: string;
  palette_version?: string;
  revision?: string;
  paint_token_account_id?: string;
  writes_paused?: boolean;
  overwrite_policy?: string;
}

/** Raw JSON shape returned by `get_pixel`. Field names are snake_case on chain. */
export interface ChainPixelView {
  x: number;
  y: number;
  color: number | null;
  artist: string | null;
  /**
   * Nanoseconds. May arrive as a number or as a string depending on the RPC
   * JSON encoder. We always store it as a string in page types.
   */
  written_at_ns: number | string | null;
}

/** One painted cell from `get_pixels` (color/artist are always present). */
export interface ChainPaintedPixelView {
  x: number;
  y: number;
  color: number;
  artist: string;
  written_at_ns: number | string;
}

/** Raw JSON page from `get_pixels`. */
export interface ChainPixelsPage {
  pixels: ChainPaintedPixelView[];
  from_index: number;
  limit: number;
  total: number;
  next_from_index: number | null;
}

export function isContractConfigured(): boolean {
  return CONTRACT_ID.length > 0;
}

/**
 * Map a chain pixel into the page type in `shared/types.ts`.
 * `color` on chain → `colorIndex` on the page.
 */
export function mapChainPixel(raw: ChainPixelView): PixelView {
  return {
    x: raw.x,
    y: raw.y,
    colorIndex: raw.color,
    artistAccountId: raw.artist,
    lastWriteTimestampNs:
      raw.written_at_ns === null || raw.written_at_ns === undefined
        ? null
        : String(raw.written_at_ns),
  };
}

/** Map a painted cell from `get_pixels` (non-null fields on chain). */
export function mapPaintedPixel(raw: ChainPaintedPixelView): PixelView {
  return {
    x: raw.x,
    y: raw.y,
    colorIndex: raw.color,
    artistAccountId: raw.artist,
    lastWriteTimestampNs: String(raw.written_at_ns),
  };
}

export function mapPixelsPage(raw: ChainPixelsPage): PixelsPageView {
  return {
    pixels: raw.pixels.map(mapPaintedPixel),
    fromIndex: raw.from_index,
    limit: raw.limit,
    total: raw.total,
    nextFromIndex: raw.next_from_index,
  };
}

/** True when the read pixel matches what we tried to paint. */
export function pixelMatchesDraw(
  pixel: PixelView,
  x: number,
  y: number,
  colorIndex: number,
  artistAccountId: string,
): boolean {
  return (
    pixel.x === x &&
    pixel.y === y &&
    pixel.colorIndex === colorIndex &&
    pixel.artistAccountId === artistAccountId
  );
}

/** Where to read chain state from. Prefer one block for a multi-page walk. */
export type ViewBlockRef =
  | { kind: "finality"; finality: "optimistic" | "near-final" | "final" }
  | { kind: "block"; blockId: number | string };

export const DEFAULT_VIEW_BLOCK: ViewBlockRef = {
  kind: "finality",
  finality: "optimistic",
};

/**
 * Call a view method on the configured contract.
 * `args` becomes JSON, then base64, which is what NEAR's RPC expects.
 */
export async function viewFunction<T>(
  methodName: string,
  args: Record<string, unknown> = {},
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<T> {
  if (!isContractConfigured()) {
    throw new Error(
      "No contract id is configured. Set VITE_CONTRACT_ID in web/.env.",
    );
  }

  const argsBase64 = bytesToBase64(
    new TextEncoder().encode(JSON.stringify(args)),
  );

  const blockParams =
    block.kind === "block"
      ? { block_id: block.blockId }
      : { finality: block.finality };

  const response = await fetchWithTimeout(RPC_URL, {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "metapoo-view",
      method: "query",
      params: {
        request_type: "call_function",
        ...blockParams,
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: argsBase64,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} while calling ${methodName}.`);
  }

  const body = (await response.json()) as {
    result?: {
      result?: number[];
      error?: string;
      logs?: string[];
      block_height?: number;
    };
    error?: { message?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }
  if (body.result?.error) {
    throw new Error(String(body.result.error));
  }
  if (!body.result?.result) {
    throw new Error(`Empty RPC result for ${methodName}.`);
  }

  const text = new TextDecoder().decode(Uint8Array.from(body.result.result));
  return JSON.parse(text) as T;
}

export interface ViewResult<T> {
  data: T;
  /** Block height reported by the RPC query result, when present. */
  blockHeight: number | null;
}

/** Like viewFunction, but also returns the RPC block_height when available. */
export async function viewFunctionWithMeta<T>(
  methodName: string,
  args: Record<string, unknown> = {},
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<ViewResult<T>> {
  if (!isContractConfigured()) {
    throw new Error(
      "No contract id is configured. Set VITE_CONTRACT_ID in web/.env.",
    );
  }

  const argsBase64 = bytesToBase64(
    new TextEncoder().encode(JSON.stringify(args)),
  );

  const blockParams =
    block.kind === "block"
      ? { block_id: block.blockId }
      : { finality: block.finality };

  const response = await fetchWithTimeout(RPC_URL, {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "metapoo-view",
      method: "query",
      params: {
        request_type: "call_function",
        ...blockParams,
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: argsBase64,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} while calling ${methodName}.`);
  }

  const body = (await response.json()) as {
    result?: {
      result?: number[];
      error?: string;
      logs?: string[];
      block_height?: number;
    };
    error?: { message?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }
  if (body.result?.error) {
    throw new Error(String(body.result.error));
  }
  if (!body.result?.result) {
    throw new Error(`Empty RPC result for ${methodName}.`);
  }

  const text = new TextDecoder().decode(Uint8Array.from(body.result.result));
  const blockHeight =
    typeof body.result.block_height === "number"
      ? body.result.block_height
      : block.kind === "block" && typeof block.blockId === "number"
        ? block.blockId
        : null;
  return { data: JSON.parse(text) as T, blockHeight };
}

/**
 * Latest finalized block height from the configured RPC.
 * Used so every page of a full board load shares one block_id.
 *
 * `final`, not `optimistic`: an optimistic height can be a block the answering node
 * has not stored, and pinning `get_pixels` to it fails `UNKNOWN_BLOCK` (2026-11-06).
 * One block of extra staleness costs nothing; a missing block costs the whole load.
 */
export async function fetchLatestBlockHeight(): Promise<number> {
  const response = await fetchWithTimeout(RPC_URL, {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "metapoo-block",
      method: "block",
      params: { finality: "final" },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} while reading block height.`);
  }

  const body = (await response.json()) as {
    result?: { header?: { height?: number } };
    error?: { message?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }
  const height = body.result?.header?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) {
    throw new Error("RPC block response did not include a numeric height.");
  }
  return height;
}

export async function getBoard(
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<ChainBoardView> {
  return viewFunction<ChainBoardView>("get_board", {}, block);
}

export async function getPixel(
  x: number,
  y: number,
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<PixelView> {
  const raw = await viewFunction<ChainPixelView>("get_pixel", { x, y }, block);
  return mapChainPixel(raw);
}

/**
 * get_pixel plus the RPC block height from that same response.
 * Never substitutes a later tip height — that could stamp older paint as newer.
 */
export async function getPixelWithBlock(
  x: number,
  y: number,
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<{ pixel: PixelView; blockHeight: number }> {
  const meta = await viewFunctionWithMeta<ChainPixelView>(
    "get_pixel",
    { x, y },
    block,
  );
  const blockHeight =
    meta.blockHeight ??
    (block.kind === "block" && typeof block.blockId === "number"
      ? block.blockId
      : null);
  if (blockHeight === null) {
    throw new Error(
      "RPC get_pixel response did not include block_height; refusing to invent a newer tip.",
    );
  }
  return { pixel: mapChainPixel(meta.data), blockHeight };
}

export async function getPixelsPage(
  fromIndex: number,
  limit: number = PIXELS_PAGE_LIMIT,
  block: ViewBlockRef = DEFAULT_VIEW_BLOCK,
): Promise<PixelsPageView> {
  const raw = await viewFunction<ChainPixelsPage>(
    "get_pixels",
    {
      from_index: fromIndex,
      limit,
    },
    block,
  );
  return mapPixelsPage(raw);
}

export interface PaintedBoardSnapshot {
  pixels: PixelView[];
  blockHeight: number;
  /**
   * `get_board_version` at `blockHeight`, or null when the board has no such view
   * (boards deployed before it). Pass it back as `knownVersion` on the next read.
   */
  version?: number | null;
  unchanged?: false;
}

/** The board's version at `blockHeight` equals the caller's: every cell is as they have it. */
export interface UnchangedBoard {
  unchanged: true;
  blockHeight: number;
  version: number;
}

export type BoardRead = PaintedBoardSnapshot | UnchangedBoard;

/**
 * Whether this page's board answers `get_board_version`. Learned once per page:
 * a board without the view gets the full walk every time, with no failed call first.
 */
let boardVersionView: "unknown" | "yes" | "no" = "unknown";

/** Tests only: forget what was learned about the configured board. */
export function resetBoardVersionSupport(): void {
  boardVersionView = "unknown";
}

function isMissingView(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /MethodNotFound|MethodResolveError|method .*not found/i.test(text);
}

/**
 * The board server's trust check: one `get_board_version` read, and the block it was
 * read at. A board without the view answers with `version: null` and the latest final
 * block instead, still one request, so the check can still measure the server's lag.
 */
export async function readBoardVersion(): Promise<{ version: number | null; blockHeight: number }> {
  if (boardVersionView !== "no") {
    try {
      const read = await viewFunctionWithMeta<number>("get_board_version");
      if (typeof read.data !== "number" || !Number.isSafeInteger(read.data)) {
        throw new Error("get_board_version did not return a whole number.");
      }
      boardVersionView = "yes";
      if (read.blockHeight !== null) return { version: read.data, blockHeight: read.blockHeight };
      return { version: read.data, blockHeight: await fetchLatestBlockHeight() };
    } catch (error) {
      if (!isMissingView(error)) throw error;
      boardVersionView = "no";
    }
  }
  return { version: null, blockHeight: await fetchLatestBlockHeight() };
}

/**
 * Read the board, or learn that it has not changed.
 *
 * With `knownVersion` (the `version` of the copy the caller holds), one
 * `get_board_version` call decides: same version → `{ unchanged: true }` and nothing
 * else is read. Otherwise every painted cell is downloaded pinned to the block that
 * version was read at, so the version and the pixels describe the same moment. That
 * block replaces the separate `block` request the walk used to start with.
 *
 * Without `knownVersion` (first load, Refresh) the walk always runs.
 * A board without the view falls back to the plain walk, every time.
 */
/** A walk stopped by its caller (`isCancelled`), not a read failure. */
export class WalkCancelled extends Error {
  constructor() {
    super("Board walk cancelled.");
    this.name = "WalkCancelled";
  }
}

export async function fetchAllPaintedPixels(
  options: {
    knownVersion?: number | null;
    pageLimit?: number;
    /**
     * Checked before every request after the first. True: stop with `WalkCancelled`, reading
     * nothing more. The wall passes its scope's `isDisposed`, so leaving the page ends a walk
     * instead of letting it read every remaining page for nobody.
     */
    isCancelled?: () => boolean;
  } = {},
): Promise<BoardRead> {
  const pageLimit = options.pageLimit ?? PIXELS_PAGE_LIMIT;
  const stopIfCancelled = () => {
    if (options.isCancelled?.()) throw new WalkCancelled();
  };
  let blockHeight: number | null = null;
  let version: number | null = null;
  if (boardVersionView !== "no") {
    try {
      const read = await viewFunctionWithMeta<number>("get_board_version");
      if (typeof read.data !== "number" || !Number.isSafeInteger(read.data)) {
        throw new Error("get_board_version did not return a whole number.");
      }
      boardVersionView = "yes";
      version = read.data;
      blockHeight = read.blockHeight;
    } catch (error) {
      if (!isMissingView(error)) throw error;
      boardVersionView = "no";
    }
  }
  if (
    version !== null &&
    blockHeight !== null &&
    options.knownVersion != null &&
    options.knownVersion === version
  ) {
    return { unchanged: true, blockHeight, version };
  }
  stopIfCancelled();
  if (blockHeight === null) {
    // No version view, or an RPC that left out block_height: pin the walk the old way,
    // and do not pair a version with pixels from a different block.
    blockHeight = await fetchLatestBlockHeight();
    version = null;
  }
  const block: ViewBlockRef = { kind: "block", blockId: blockHeight };
  const pixels = await loadAllPaintedPixels((fromIndex, limit) => {
    stopIfCancelled();
    return getPixelsPage(fromIndex, limit, block);
  }, pageLimit);
  return { pixels, blockHeight, version };
}

export type PixelConfirmKind =
  | "confirmed"
  | "confirmation_delayed"
  | "overwritten";

export interface PixelConfirmResult {
  kind: PixelConfirmKind;
  /** Latest read of the cell (may be empty on delay). */
  pixel: PixelView | null;
  /** Block height from the same RPC response as `pixel`, when a read succeeded. */
  observedBlockHeight: number | null;
}

/**
 * After a successful transaction, re-read the cell until it matches, shows a
 * different artist (Open wall overwrite), or we time out as delayed.
 * Wallet success is tracked separately — a mismatch is not automatic failure.
 * The returned block height is from the confirming get_pixel response only.
 */
export async function confirmPixelAfterDraw(options: {
  x: number;
  y: number;
  colorIndex: number;
  artistAccountId: string;
  attempts?: number;
  delayMs?: number;
}): Promise<PixelConfirmResult> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 400;
  let last: PixelView | null = null;
  let lastBlock: number | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const { pixel, blockHeight } = await getPixelWithBlock(options.x, options.y);
    last = pixel;
    lastBlock = blockHeight;
    if (
      pixelMatchesDraw(
        pixel,
        options.x,
        options.y,
        options.colorIndex,
        options.artistAccountId,
      )
    ) {
      return { kind: "confirmed", pixel, observedBlockHeight: blockHeight };
    }
    if (
      pixel.colorIndex !== null &&
      pixel.artistAccountId !== null &&
      pixel.artistAccountId !== options.artistAccountId
    ) {
      // Another account already credits this cell — treat as overwritten,
      // not as a failed transaction.
      return { kind: "overwritten", pixel, observedBlockHeight: blockHeight };
    }
    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return {
    kind: "confirmation_delayed",
    pixel: last,
    observedBlockHeight: lastBlock,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = JSON.parse(String(init.body));
    // Board polling waits behind prices, balances and confirmations.
    const background = body.method === "block"
      || body.params?.method_name === "get_pixels"
      || body.params?.method_name === "get_board_version";
    return await readRpcFetch(url, { ...init, signal: controller.signal }, background ? 1 : 0);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`RPC timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
