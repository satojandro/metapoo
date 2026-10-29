/**
 * Repaint prices for a schema-4 (paid) board.
 *
 * The contract decides the credit cost. This file only reads `get_cell_cost`
 * and `get_tunables` and prints what they say. It does not keep a copy of the
 * 1 / 2 / 4 tier table. If a read fails, the page says "price unavailable"
 * and refuses to submit — it never guesses "1 credit".
 */

import { getPixel, viewFunction } from "../../contract";

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

/** How the page asks the chain. Tests pass a fake; the wall uses `chainRepaintReaders`. */
export interface RepaintReaders {
  cellCost(cell: CellRef): Promise<number>;
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

/**
 * Read every cell's price. One failed read fails the whole quote so a stroke
 * cannot show a mix of real prices and a guessed 1.
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

  let rows: QuotedCell[];
  try {
    rows = await mapInBatches(input.cells, 8, async (cell) => {
      const [credits, pixel] = await Promise.all([
        input.readers.cellCost(cell),
        input.readers.pixel(cell),
      ]);
      if (!wholeCredit(credits)) {
        throw new Error(PRICE_UNAVAILABLE);
      }
      if (pixel.writtenAtNs !== null && !/^\d+$/.test(pixel.writtenAtNs)) {
        throw new Error(PRICE_UNAVAILABLE);
      }
      return {
        cell,
        credits,
        writtenAtNs: pixel.writtenAtNs,
        line: formatCellPrice({
          credits,
          writtenAtNs: pixel.writtenAtNs,
          nowNs: input.nowNs,
        }),
      };
    });
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

/** Live readers. Schema 2 never calls these — only a paid board has the methods. */
export function chainRepaintReaders(): RepaintReaders {
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
    async tunables() {
      return viewFunction<RepaintTunables>("get_tunables");
    },
    async pixel(cell) {
      const view = await getPixel(cell.x, cell.y);
      return { writtenAtNs: view.lastWriteTimestampNs };
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
  };
}
