/**
 * Repaint prices for a schema-4 (paid) board.
 *
 * The contract decides the credit cost. This file reads `get_cell_cost`,
 * `get_cell_costs`, and `get_tunables` and prints what they say. It does not
 * keep a copy of the 1 / 2 / 4 tier table. If a read fails, the page says "price unavailable"
 * and refuses to submit — it never guesses "1 credit".
 *
 * Quote traffic must stay small. A 64-cell stroke used to fire ~129 RPCs
 * (tunables + get_cell_cost + get_pixel per cell). Session-cached tunables,
 * wall-cache timestamps, de-duplicated cells, and one `get_cell_costs` call
 * per ≤64 cells keep that off the buy-credits endpoint (issue #26).
 * Hover and a one-cell place still use `get_cell_cost`.
 */

import { viewFunction } from "../../contract";

/** Exact words shown when a price read fails. Do not paraphrase in the UI. */
export const PRICE_UNAVAILABLE = "price unavailable";

export interface CellRef {
  x: number;
  y: number;
}

/**
 * The two tunable fields the legend sentence is allowed to use.
 * Costs for individual cells still come from `get_cell_cost`, not from these.
 */
export interface RepaintTunables {
  repaint_mid_ns: number | string;
  repaint_base_credits: number;
}

export interface QuotedCell {
  cell: CellRef;
  credits: number;
  writtenAtNs: string | null;
  line: string;
}

export type RepaintQuote =
  | {
      ok: true;
      legend: string;
      cells: QuotedCell[];
      strokeText: string;
      totalCredits: number;
    }
  | { ok: false; message: typeof PRICE_UNAVAILABLE };

/**
 * `get_cell_costs` rejects with StrokeTooLarge above this.
 * Same cap as the contract's MAX_DRAW_BATCH / draw_many.
 */
const MAX_COST_BATCH = 64;

/** How the page asks the chain. Tests pass a fake; the wall uses `chainRepaintReaders`. */
export interface RepaintReaders {
  /** One cell. Hover and selection. Batching a single cell buys nothing. */
  cellCost(cell: CellRef): Promise<number>;
  /** One stroke chunk, at most MAX_COST_BATCH cells. Backed by `get_cell_costs`. */
  cellCosts(cells: CellRef[]): Promise<number[]>;
  tunables(): Promise<RepaintTunables>;
  pixel(cell: CellRef): Promise<{ writtenAtNs: string | null }>;
  credits(accountId: string): Promise<bigint | null>;
}

const MINUTE_NS = 60_000_000_000n;
const HOUR_NS = 60n * MINUTE_NS;

/**
 * One sentence for the default view.
 * "An hour" and "1 credit" are how the chain's own numbers are spoken,
 * not a second copy of the pricing rule.
 */
export function repaintLegend(tunables: RepaintTunables): string {
  const wait = formatWait(BigInt(tunables.repaint_mid_ns));
  const base = tunables.repaint_base_credits;
  const unit = base === 1 ? "credit" : "credits";
  return `Fresh cells cost more to repaint. Wait ${wait} and it is ${base} ${unit} again.`;
}

function formatWait(ns: bigint): string {
  if (ns === HOUR_NS) {
    return "an hour";
  }
  if (ns > 0n && ns % HOUR_NS === 0n) {
    const hours = ns / HOUR_NS;
    return hours === 1n ? "an hour" : `${hours} hours`;
  }
  if (ns > 0n && ns % MINUTE_NS === 0n) {
    const minutes = ns / MINUTE_NS;
    return minutes === 1n ? "a minute" : `${minutes} minutes`;
  }
  return `${ns / MINUTE_NS} min`;
}

/** Hover / selection line. `credits` must already be the chain's answer. */
export function formatCellPrice(input: {
  credits: number;
  writtenAtNs: string | null;
  nowNs: bigint;
}): string {
  const unit = input.credits === 1 ? "credit" : "credits";
  if (input.writtenAtNs === null) {
    return `unpainted · ${input.credits} ${unit}`;
  }
  const written = BigInt(input.writtenAtNs);
  const age = input.nowNs > written ? input.nowNs - written : 0n;
  const minutes = age / MINUTE_NS;
  return `repaint ${minutes} min ago · ${input.credits} ${unit}`;
}

/** Shown before Place paint or a drag is sent. */
export function formatStrokeTotal(cellCount: number, credits: number): string {
  const cells = cellCount === 1 ? "1 cell" : `${cellCount} cells`;
  const unit = credits === 1 ? "credit" : "credits";
  return `this stroke: ${cells} · ${credits} ${unit}`;
}

/**
 * Can this tap be painted without waiting for a price read?
 *
 * The contract enforces affordability itself (`draw` takes no max_cost), so this
 * is a courtesy check against values already on screen: the cached dock balance
 * and the last quoted cost for the cell. Unknown values must never block a
 * paint — blocking on a value we do not have is what made direct paint feel
 * dead, and it put a network read inside the core gesture.
 */
export function tapAffordability(input: {
  credits: bigint | null;
  creditsKnown: boolean;
  knownCost: number | undefined;
}): { allowed: true } | { allowed: false; needed: number } {
  if (!input.creditsKnown) {
    return { allowed: true };
  }
  // A null balance means "never registered", which is zero credits, not unknown.
  const needed = input.knownCost ?? 1;
  const have = input.credits ?? 0n;
  return have < BigInt(needed) ? { allowed: false, needed } : { allowed: true };
}

/**
 * Null from `get_credits` means the account was never registered, so they
 * have zero credits to spend. A balance that covers the total returns null
 * (no shortfall). Otherwise the sentence that must appear before any wallet call.
 */
export function creditShortfall(have: bigint | null, need: number): string | null {
  const balance = have ?? 0n;
  if (balance >= BigInt(need)) {
    return null;
  }
  const needUnit = need === 1 ? "credit" : "credits";
  const haveUnit = balance === 1n ? "credit" : "credits";
  return `This stroke needs ${need} ${needUnit} and this account has ${balance} ${haveUnit}. Nothing was submitted.`;
}

function wholeCredit(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Keep first occurrence of each (x, y). A stroke that revisits a cell still paints once. */
export function uniqueCells(cells: readonly CellRef[]): CellRef[] {
  const seen = new Set<string>();
  const out: CellRef[] = [];
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(cell);
  }
  return out;
}

/**
 * Read every unique cell's price. One failed read fails the whole quote so a
 * stroke cannot show a mix of real prices and a guessed 1.
 */
export async function quoteRepaint(input: {
  readers: RepaintReaders;
  cells: CellRef[];
  nowNs: bigint;
}): Promise<RepaintQuote> {
  let tunables: RepaintTunables;
  try {
    tunables = await input.readers.tunables();
    if (!wholeCredit(tunables.repaint_base_credits)) {
      return { ok: false, message: PRICE_UNAVAILABLE };
    }
    // Reading the threshold proves the view actually returned the legend fields.
    BigInt(tunables.repaint_mid_ns);
  } catch {
    return { ok: false, message: PRICE_UNAVAILABLE };
  }

  const cells = uniqueCells(input.cells);
  let rows: QuotedCell[];
  try {
    if (cells.length <= 1) {
      // Hover, selection, and a one-cell place. One `get_cell_cost`.
      rows = await mapInBatches(cells, 8, async (cell) => {
        const [credits, pixel] = await Promise.all([
          input.readers.cellCost(cell),
          input.readers.pixel(cell),
        ]);
        return quotedRow(cell, credits, pixel.writtenAtNs, input.nowNs);
      });
    } else {
      // A drag can be up to 256 cells before draw_many splits it. The view
      // rejects more than 64, so the quote is chunked and the prices summed.
      rows = [];
      for (let index = 0; index < cells.length; index += MAX_COST_BATCH) {
        const chunk = cells.slice(index, index + MAX_COST_BATCH);
        const costs = await input.readers.cellCosts(chunk);
        if (!Array.isArray(costs) || costs.length !== chunk.length) {
          throw new Error(PRICE_UNAVAILABLE);
        }
        const pixels = await Promise.all(chunk.map((cell) => input.readers.pixel(cell)));
        for (let i = 0; i < chunk.length; i++) {
          const cell = chunk[i]!;
          const pixel = pixels[i]!;
          rows.push(quotedRow(cell, costs[i]!, pixel.writtenAtNs, input.nowNs));
        }
      }
    }
  } catch {
    return { ok: false, message: PRICE_UNAVAILABLE };
  }

  const totalCredits = rows.reduce((sum, row) => sum + row.credits, 0);
  return {
    ok: true,
    legend: repaintLegend(tunables),
    cells: rows,
    strokeText: rows.length > 0 ? formatStrokeTotal(rows.length, totalCredits) : "",
    totalCredits,
  };
}

function quotedRow(
  cell: CellRef,
  credits: number,
  writtenAtNs: string | null,
  nowNs: bigint,
): QuotedCell {
  if (!wholeCredit(credits)) {
    throw new Error(PRICE_UNAVAILABLE);
  }
  if (writtenAtNs !== null && !/^\d+$/.test(writtenAtNs)) {
    throw new Error(PRICE_UNAVAILABLE);
  }
  return {
    cell,
    credits,
    writtenAtNs,
    line: formatCellPrice({ credits, writtenAtNs, nowNs }),
  };
}

async function mapInBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const slice = items.slice(index, index + size);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

export interface RepaintChrome {
  legend: HTMLElement;
  badge: HTMLElement;
  strokeTotal: HTMLElement;
  submit: HTMLButtonElement;
}

/** Paint a failed read. Submit stays disabled so a guess cannot be sent. */
export function showPriceUnavailable(chrome: RepaintChrome): void {
  chrome.legend.hidden = true;
  chrome.legend.textContent = "";
  chrome.badge.textContent = PRICE_UNAVAILABLE;
  chrome.badge.dataset.state = "unavailable";
  chrome.strokeTotal.textContent = PRICE_UNAVAILABLE;
  chrome.strokeTotal.dataset.state = "unavailable";
  chrome.submit.disabled = true;
}

/** Paint a successful quote into the default view (never inside `<details>`). */
export function showRepaintQuote(chrome: RepaintChrome, quote: Extract<RepaintQuote, { ok: true }>): void {
  chrome.legend.hidden = false;
  chrome.legend.textContent = quote.legend;
  const badge = quote.cells[0]?.line ?? "";
  chrome.badge.textContent = badge;
  chrome.badge.dataset.state = badge ? "ready" : "";
  chrome.strokeTotal.textContent = quote.strokeText;
  chrome.strokeTotal.dataset.state = quote.strokeText ? "ready" : "";
  chrome.submit.disabled = false;
}

export interface ChainRepaintReaders extends RepaintReaders {
  /** Drop the session tunables cache (e.g. after a manual Refresh). */
  clearTunablesCache(): void;
}

export interface ChainRepaintReaderOptions {
  /**
   * Prefer the wall's pixel cache for `written_at_ns`. Missing cells are
   * treated as unpainted (`null`) — do not fall back to a per-cell `get_pixel`.
   */
  writtenAtNsFromCache?: (cell: CellRef) => string | null;
}

/** Live readers. Schema 2 never calls these — only a paid board has the methods. */
export function chainRepaintReaders(
  options: ChainRepaintReaderOptions = {},
): ChainRepaintReaders {
  let cachedTunables: RepaintTunables | null = null;
  return {
    async cellCost(cell) {
      const cost = await viewFunction<number | string>("get_cell_cost", {
        x: cell.x,
        y: cell.y,
      });
      const credits = typeof cost === "number" ? cost : Number(cost);
      if (!wholeCredit(credits)) {
        throw new Error(PRICE_UNAVAILABLE);
      }
      return credits;
    },
    async cellCosts(cells) {
      const costs = await viewFunction<number[]>("get_cell_costs", { cells });
      if (!Array.isArray(costs) || costs.length !== cells.length) {
        throw new Error(PRICE_UNAVAILABLE);
      }
      return costs.map((c) => (wholeCredit(Number(c)) ? Number(c) : Number.NaN));
    },
    async tunables() {
      if (cachedTunables) {
        return cachedTunables;
      }
      const next = await viewFunction<RepaintTunables>("get_tunables");
      cachedTunables = next;
      return next;
    },
    async pixel(cell) {
      // Prefer the wall pixel cache. Never re-fetch get_pixel per cell during a
      // quote — that doubled stroke RPCs and starved buy-credits (issue #26).
      if (options.writtenAtNsFromCache) {
        return { writtenAtNs: options.writtenAtNsFromCache(cell) };
      }
      return { writtenAtNs: null };
    },
    async credits(accountId) {
      const balance = await viewFunction<string | number | null>("get_credits", {
        account_id: accountId,
      });
      if (balance === null) {
        return null;
      }
      return BigInt(balance);
    },
    clearTunablesCache() {
      cachedTunables = null;
    },
  };
}
