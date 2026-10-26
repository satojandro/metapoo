/**
 * Stroke painting (Berry Club drag-to-paint).
 *
 * A drag in paint mode accumulates a stroke of cells; pointerup submits the
 * whole stroke as `draw_many` calls of up to MAX_BATCH cells each, so one
 * wallet approval (or one session-signed transaction) paints a whole gesture
 * instead of one approval per pixel.
 *
 * Pure module: no DOM, no network. The mount feeds it cells as pointermove
 * samples and takes chunks out at pointerup.
 *
 * Two correctness rules:
 * - consecutive move samples can skip cells on a fast flick, so intermediate
 *   cells are interpolated along a straight line (Bresenham) — a stroke must
 *   never arrive with holes the finger actually crossed;
 * - the stroke is capped at MAX_STROKE_CELLS; longer drags stop extending and
 *   report truncation so the caller can tell the user honestly.
 */

export interface StrokeCell {
  x: number;
  y: number;
}

/** One transaction per this many cells — mirrors the contract's MAX_DRAW_BATCH. */
export const MAX_BATCH = 64;

/**
 * Safety cap on one gesture. Longer drags are truncated instead of producing
 * an unbounded rain of transactions and storage cost for one finger flick.
 */
export const MAX_STROKE_CELLS = 256;

export interface StrokeState {
  /** Ordered, de-duplicated cells since strokeBegin. */
  cells: StrokeCell[];
  /** True once the cap stopped further extension. */
  truncated: boolean;
}

/** Cell-key width for de-duplication (board is BOARD_WIDTH wide). */
const KEY_WIDTH = 128;

function same(a: StrokeCell, b: StrokeCell): boolean {
  return a.x === b.x && a.y === b.y;
}

function key(c: StrokeCell): number {
  return c.y * KEY_WIDTH + c.x;
}

/** Bresenham cells strictly between a and b (b included, a excluded). */
export function lineCells(a: StrokeCell, b: StrokeCell): StrokeCell[] {
  const out: StrokeCell[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (!(x0 === x1 && y0 === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    out.push({ x: x0, y: y0 });
  }
  return out;
}

export function strokeBegin(cell: StrokeCell): StrokeState {
  return { cells: [cell], truncated: false };
}

/**
 * Extends the stroke to a new sample, interpolating any cells the pointer
 * moved across between samples. Cells already present are skipped (visiting
 * your own stroke twice paints once).
 */
export function strokeExtend(state: StrokeState, cell: StrokeCell): StrokeState {
  if (state.truncated) {
    return state;
  }
  const last = state.cells[state.cells.length - 1];
  if (!last || same(last, cell)) {
    return state;
  }
  const segment = lineCells(last, cell);
  const seen = new Set(state.cells.map(key));
  const next = segment.filter((c) => !seen.has(key(c)));
  const room = MAX_STROKE_CELLS - state.cells.length;
  if (next.length > room) {
    return {
      cells: [...state.cells, ...next.slice(0, room)],
      truncated: true,
    };
  }
  return { cells: [...state.cells, ...next], truncated: false };
}

/**
 * Slices the final stroke into transactions. The contract stores every cell
 * of one call atomically, so chunk boundaries are where a partial failure
 * could leave half a stroke; callers must say so in the result text.
 */
export function chunkCells(
  cells: StrokeCell[],
  maxBatch: number = MAX_BATCH,
): StrokeCell[][] {
  const out: StrokeCell[][] = [];
  for (let i = 0; i < cells.length; i += maxBatch) {
    out.push(cells.slice(i, i + maxBatch));
  }
  return out;
}

/** DrawCell JSON for the contract call. */
export function chunkArgs(chunk: StrokeCell[], color: number): {
  cells: Array<{ x: number; y: number; color: number }>;
} {
  return { cells: chunk.map((c) => ({ x: c.x, y: c.y, color })) };
}
