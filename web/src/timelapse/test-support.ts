/**
 * Test helpers for the timelapse: a seeded synthetic log (with an expansion), a straight
 * re-implementation of "apply every paint from zero" to compare the replay against, and the
 * server's wire format encoded in TypeScript so a stub server can serve it.
 */
import type { HistoryHead } from "./history-client";
import type { HistoryRecord } from "./history-wire";
import { GRID } from "./timeline";

export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  paints: number;
  /** Grow 64 → 96 after this many paints (and 96 → 128 after `expandAgainAt`, if given). */
  expandAt?: number;
  expandAgainAt?: number;
  seed?: number;
  startBlock?: number;
  startMs?: number;
}

/** Strokes of 1–40 tiles walking the wall, a few blocks apart, with overpainting. */
export function syntheticRecords(options: SyntheticOptions): HistoryRecord[] {
  const random = mulberry(options.seed ?? 7);
  const records: HistoryRecord[] = [];
  let block = options.startBlock ?? 223_113_576;
  let atMs = options.startMs ?? 1_762_000_000_000;
  let side = 64;
  let done = 0;
  while (done < options.paints) {
    for (const [at, to] of [[options.expandAt, 96], [options.expandAgainAt, 128]] as const) {
      if (at !== undefined && done >= at && side < to && side === to - 32) {
        block += 3;
        atMs += 1_800;
        records.push({ kind: "expand", block, atMs, from: side, to });
        side = to;
      }
    }
    const gap = random() < 0.02 ? 40_000 + Math.floor(random() * 90_000) : 1 + Math.floor(random() * 60);
    block += gap;
    atMs += gap * 600;
    let n = Math.min(options.paints - done, 1 + Math.floor(random() * 40));
    // Do not paint past the point where the wall grows: the expansion has to land between strokes.
    for (const at of [options.expandAt, options.expandAgainAt]) if (at !== undefined && done < at) n = Math.min(n, at - done);
    const tiles = new Uint8Array(n * 3);
    let x = Math.floor(random() * side);
    let y = Math.floor(random() * side);
    const color = Math.floor(random() * 16);
    for (let i = 0; i < n; i += 1) {
      tiles.set([x, y, random() < 0.1 ? Math.floor(random() * 16) : color], i * 3);
      const step = Math.floor(random() * 4);
      x = Math.min(side - 1, Math.max(0, x + (step === 0 ? 1 : step === 1 ? -1 : 0)));
      y = Math.min(side - 1, Math.max(0, y + (step === 2 ? 1 : step === 3 ? -1 : 0)));
    }
    records.push({ kind: "paints", block, atMs, tiles });
    done += n;
  }
  return records;
}

export function headFor(records: readonly HistoryRecord[], over: Partial<HistoryHead> = {}): HistoryHead {
  let entries = 0;
  let side = 64;
  for (const r of records) {
    if (r.kind === "expand") {
      entries += 1;
      side = r.to;
    } else entries += r.tiles.length / 3;
  }
  const first = records[0];
  const last = records.at(-1);
  return {
    epoch: 1_762_000_000_000,
    complete: true,
    startBlock: first ? first.block - 10 : 1,
    initialSide: 64,
    entries,
    first: first ? { block: first.block, atMs: first.atMs } : null,
    last: last ? { block: last.block, atMs: last.atMs } : null,
    side,
    ...over,
  };
}

/** The wall after `position` paints, by applying every paint from zero. The oracle. */
export function replayFromZero(records: readonly HistoryRecord[], position: number): Uint8Array {
  const state = new Uint8Array(GRID * GRID);
  let n = 0;
  for (const r of records) {
    if (r.kind !== "paints") continue;
    for (let i = 0; i < r.tiles.length && n < position; i += 3, n += 1) {
      state[r.tiles[i + 1]! * GRID + r.tiles[i]!] = r.tiles[i + 2]! + 1;
    }
  }
  return state;
}

function varint(out: number[], value: number): void {
  let v = value;
  while (v >= 128) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** `history_wire.rs` `encode_page`, for stub servers. `next` is `[position, index]`. */
export function encodeHistoryPage(records: readonly HistoryRecord[], next: readonly [number, number] | null, more: boolean): Uint8Array {
  const body: number[] = [];
  let rows = 0;
  let block = 0;
  let atMs = 0;
  for (const r of records) {
    body.push(r.kind === "expand" ? 2 : 1);
    varint(body, r.block - block);
    const d = r.atMs - atMs;
    varint(body, d >= 0 ? d * 2 : -d * 2 - 1);
    block = r.block;
    atMs = r.atMs;
    if (r.kind === "expand") {
      varint(body, r.from);
      varint(body, r.to);
      rows += 1;
    } else {
      varint(body, r.tiles.length / 3);
      body.push(...r.tiles);
      rows += r.tiles.length / 3;
    }
  }
  const header: number[] = [0x4d, 0x50, 0x48, 0x31, more ? 1 : 0];
  varint(header, rows);
  varint(header, next?.[0] ?? 0);
  varint(header, next?.[1] ?? 0);
  return Uint8Array.from([...header, ...body]);
}

/** Cut `records` into pages of at most `limit` rows, as the server would. */
export function paginate(records: readonly HistoryRecord[], limit: number): Uint8Array[] {
  const pages: HistoryRecord[][] = [[]];
  let rows = 0;
  for (const r of records) {
    if (r.kind === "expand") {
      if (rows >= limit) (pages.push([]), (rows = 0));
      pages.at(-1)!.push(r);
      rows += 1;
      continue;
    }
    let offset = 0;
    while (offset < r.tiles.length) {
      if (rows >= limit) (pages.push([]), (rows = 0));
      const take = Math.min((limit - rows) * 3, r.tiles.length - offset);
      pages.at(-1)!.push({ ...r, tiles: r.tiles.subarray(offset, offset + take) });
      offset += take;
      rows += take / 3;
    }
  }
  return pages.map((page, i) => {
    const last = i === pages.length - 1;
    // If the last page is exactly full the server says "more" and the next page is empty.
    return encodeHistoryPage(page, [1_000_000 * (i + 1), 0], !last);
  });
}
