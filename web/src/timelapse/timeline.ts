/**
 * The draw log compiled for replay (TIMELAPSE, return/growth spec §4.3).
 *
 * A position is a number of paints applied: 0 is the wall before the log's first paint,
 * `length` is the wall after its last. Scrubbing is a seek to a position, and seeking
 * backwards must not replay from zero, so the timeline keeps a **checkpoint** of the whole
 * wall every `CHECKPOINT_EVERY` paints (16 KB each: a million paints is 4 MB). A seek copies
 * the nearest checkpoint at or before the target and applies at most `CHECKPOINT_EVERY` paints
 * forward; stepping forward from where the replay already is applies only the difference.
 *
 * Pure: no DOM, no clock.
 */
import { isPaletteIndex } from "@shared/palette.ts";
import type { HistoryHead } from "./history-client";
import type { HistoryRecord } from "./history-wire";

/** The largest wall there is (`shared/board.json`): the grid every state is stored on. */
export const GRID = 128;
export const CHECKPOINT_EVERY = 4096;

export interface Expansion {
  /** Paints applied before the wall grew. */
  at: number;
  from: number;
  to: number;
  block: number;
  atMs: number;
}

/** A stroke: paints that share a block and a time. */
export interface Frame {
  /** Position of its first paint. */
  start: number;
  block: number;
  atMs: number;
}

export interface Timeline {
  /** Paints in the log. */
  readonly length: number;
  /** Colour index of paint `i`, and where. */
  readonly xs: Uint8Array;
  readonly ys: Uint8Array;
  readonly colors: Uint8Array;
  readonly frames: readonly Frame[];
  readonly expansions: readonly Expansion[];
  /** The wall's side before the first paint, and the largest it reaches. */
  readonly startSide: number;
  readonly maxSide: number;
  /**
   * False when the log does not start at the board's first paint: position 0 is then a
   * blank wall that was not really blank, and the page has to say so.
   */
  readonly fromGenesis: boolean;
  /** `checkpoints[k]` is the wall after `k * CHECKPOINT_EVERY` paints. */
  readonly checkpoints: readonly Uint8Array[];
}

function clampSide(side: number): number {
  return Math.min(GRID, Math.max(1, Math.floor(side)));
}

/**
 * Build a timeline from decoded records. Paints with a colour or a place this page cannot
 * draw are dropped (the server never sends one; a corrupted page must not crash the replay).
 */
export function buildTimeline(records: readonly HistoryRecord[], head: Pick<HistoryHead, "complete" | "initialSide" | "side">): Timeline {
  let total = 0;
  for (const r of records) if (r.kind === "paints") total += r.tiles.length / 3;
  const xs = new Uint8Array(total);
  const ys = new Uint8Array(total);
  const colors = new Uint8Array(total);
  const frames: Frame[] = [];
  const expansions: Expansion[] = [];
  let n = 0;
  for (const r of records) {
    if (r.kind === "expand") {
      expansions.push({ at: n, from: clampSide(r.from), to: clampSide(r.to), block: r.block, atMs: r.atMs });
      continue;
    }
    const start = n;
    for (let i = 0; i + 2 < r.tiles.length; i += 3) {
      const x = r.tiles[i]!;
      const y = r.tiles[i + 1]!;
      const color = r.tiles[i + 2]!;
      if (x >= GRID || y >= GRID || !isPaletteIndex(color)) continue;
      xs[n] = x;
      ys[n] = y;
      colors[n] = color;
      n += 1;
    }
    if (n > start) frames.push({ start, block: r.block, atMs: r.atMs });
  }

  // Where the wall's side starts. A certified log knows; otherwise the first expansion's
  // `from` is the side the log began at, and with no expansion the wall never changed size.
  const fromGenesis = head.complete && head.initialSide !== null;
  let startSide = clampSide(fromGenesis ? head.initialSide! : (expansions[0]?.from ?? head.side));
  // A paint outside every side the log explains (an expansion logged by nobody): show it
  // rather than hide it, by starting at a side that holds it.
  let side = startSide;
  let e = 0;
  let widest = 0;
  for (let i = 0; i < n; i += 1) {
    while (e < expansions.length && expansions[e]!.at <= i) side = expansions[e++]!.to;
    const need = Math.max(xs[i]!, ys[i]!) + 1;
    if (need > side && need > widest) widest = need;
  }
  if (widest > 0) startSide = clampSide(Math.max(startSide, widest > startSide ? head.side : startSide, widest));
  let maxSide = startSide;
  for (const x of expansions) maxSide = Math.max(maxSide, x.to);

  const checkpoints: Uint8Array[] = [];
  const state = new Uint8Array(GRID * GRID);
  for (let i = 0; i <= n; i += 1) {
    if (i % CHECKPOINT_EVERY === 0) checkpoints.push(state.slice());
    if (i < n) state[ys[i]! * GRID + xs[i]!] = colors[i]! + 1;
  }

  return {
    length: n,
    xs: xs.subarray(0, n),
    ys: ys.subarray(0, n),
    colors: colors.subarray(0, n),
    frames,
    expansions,
    startSide,
    maxSide,
    fromGenesis,
    checkpoints,
  };
}

/** The wall's side after `position` paints. */
export function sideAt(timeline: Timeline, position: number): number {
  let side = timeline.startSide;
  for (const x of timeline.expansions) {
    if (x.at > position) break;
    // An expansion sitting exactly at `position` has happened once the paint before it has.
    if (x.at === position && position === 0) break;
    side = Math.max(side, x.to);
  }
  return side;
}

/** The stroke that produced the wall at `position` (the last one applied), or null at 0. */
export function frameAt(timeline: Timeline, position: number): Frame | null {
  const frames = timeline.frames;
  if (position <= 0 || frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.start < position) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo]!;
}

/** Paints applied through the end of `block`: the position a shared link opens at. */
export function positionAtBlock(timeline: Timeline, block: number): number {
  const frames = timeline.frames;
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.block <= block) lo = mid + 1;
    else hi = mid;
  }
  return lo >= frames.length ? timeline.length : frames[lo]!.start;
}

export interface Replay {
  /** `GRID × GRID`, 0 = never painted, else colour index + 1. Do not write to it. */
  readonly state: Uint8Array;
  readonly position: number;
  readonly side: number;
  /** Move to `position` (clamped). Returns how many paints it had to apply. */
  seek(position: number): number;
}

export function createReplay(timeline: Timeline): Replay {
  const state = new Uint8Array(GRID * GRID);
  let position = 0;

  function apply(from: number, to: number): void {
    const { xs, ys, colors } = timeline;
    for (let i = from; i < to; i += 1) state[ys[i]! * GRID + xs[i]!] = colors[i]! + 1;
  }

  return {
    state,
    get position() {
      return position;
    },
    get side() {
      return sideAt(timeline, position);
    },
    seek(target) {
      const to = Math.min(timeline.length, Math.max(0, Math.floor(Number.isFinite(target) ? target : 0)));
      const checkpoint = Math.floor(to / CHECKPOINT_EVERY);
      let from = position;
      // Backwards, or forwards past a nearer checkpoint: start from the checkpoint.
      if (to < position || checkpoint * CHECKPOINT_EVERY > position) {
        state.set(timeline.checkpoints[checkpoint]!);
        from = checkpoint * CHECKPOINT_EVERY;
      }
      apply(from, to);
      position = to;
      return to - from;
    },
  };
}
