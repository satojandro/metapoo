import type { PixelView } from "@shared/types.ts";
import { CONTRACT_ID, RPC_URL } from "./config";

/**
 * Talks to the game contract with free "view" calls (reads) over JSON-RPC.
 *
 * A view call does not need a wallet. Anyone can read the board description
 * or one pixel. Change methods like `draw` go through the wallet instead
 * (see `submit-draw.ts`).
 */

/** Raw JSON shape returned by the Rust contract's `get_board`. */
export interface ChainBoardView {
  schema_version: number;
  width: number;
  height: number;
  origin: string;
  overwrite_rule: string;
  sponsorship_enabled: boolean;
  palette: Array<{ index: number; name: string; hex: string }>;
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

/**
 * Call a view method on the configured contract.
 * `args` becomes JSON, then base64, which is what NEAR's RPC expects.
 */
export async function viewFunction<T>(
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isContractConfigured()) {
    throw new Error(
      "No contract id is configured. Set VITE_CONTRACT_ID in web/.env.",
    );
  }

  const argsBase64 = bytesToBase64(
    new TextEncoder().encode(JSON.stringify(args)),
  );

  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "metapoo-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
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
    result?: { result?: number[]; error?: string; logs?: string[] };
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

export async function getBoard(): Promise<ChainBoardView> {
  return viewFunction<ChainBoardView>("get_board", {});
}

export async function getPixel(x: number, y: number): Promise<PixelView> {
  const raw = await viewFunction<ChainPixelView>("get_pixel", { x, y });
  return mapChainPixel(raw);
}

/**
 * After a successful transaction, re-read the cell until it matches or we
 * give up. Confirmation for the UI means "the chain view shows the new cell",
 * not only "the wallet returned a hash".
 */
export async function confirmPixelAfterDraw(options: {
  x: number;
  y: number;
  colorIndex: number;
  artistAccountId: string;
  attempts?: number;
  delayMs?: number;
}): Promise<PixelView | null> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 400;

  for (let i = 0; i < attempts; i += 1) {
    const pixel = await getPixel(options.x, options.y);
    if (
      pixelMatchesDraw(
        pixel,
        options.x,
        options.y,
        options.colorIndex,
        options.artistAccountId,
      )
    ) {
      return pixel;
    }
    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
