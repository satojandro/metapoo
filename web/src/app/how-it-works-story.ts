/**
 * The hero's sample wall: a scripted day of painting, vandalism and repainting.
 * Sample art only. It never reads or writes the real wall.
 */

import { PALETTE } from "@shared/palette.ts";

export type StoryPixel = [x: number, y: number, color: number];
export interface StoryEvent { at: number; say: string; px: () => StoryPixel[] }

const C = Object.fromEntries(PALETTE.map((c) => [c.name, c.index])) as Record<string, number>;
const SIZE = 128;

const FONT: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"], C: ["###", "#..", "#..", "#..", "###"], D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"], G: ["###", "#..", "#.#", "#.#", "###"], H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"], L: ["#..", "#..", "#..", "#..", "###"], M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"], O: ["###", "#.#", "#.#", "#.#", "###"], P: ["###", "#.#", "###", "#..", "#.."],
  R: ["##.", "#.#", "##.", "#.#", "#.#"], S: ["###", "#..", "###", "..#", "###"], T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"], W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"], Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  " ": ["..", "..", "..", "..", ".."],
};

export function text(str: string, x0: number, y0: number, color: number, s = 1): StoryPixel[] {
  const px: StoryPixel[] = [];
  let x = x0;
  for (const ch of str) {
    const g = FONT[ch];
    if (!g) continue;
    for (let r = 0; r < 5; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === "#")
      for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) px.push([x + c * s + b, y0 + r * s + a, color]);
    x += (g[0].length + 1) * s;
  }
  return px;
}

function sprite(rows: string[], map: Record<string, number>, x0: number, y0: number, s = 1): StoryPixel[] {
  const px: StoryPixel[] = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    const color = map[ch];
    if (color === undefined) return;
    for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) px.push([x0 + c * s + b, y0 + r * s + a, color]);
  }));
  return px;
}

const POO = [
  ".......RR.......", "......RCCR......", ".....RCCCR......", "....RRCCCCRR....", "...RCCCCCCCCR...",
  "...RCWKCCWKCR...", "..RRCCCCCCCCRR..", ".RCCCKCCCCKCCCR.", ".RCCCCKKKKCCCCR.", "RRRRRRRRRRRRRRRR",
];
const HEART = [
  ".BBB...BBB.", "BBPBB.BBBBB", "BPPBBBBBBBB", "BBBBBBBBBBB", ".BBBBBBBBB.", "..BBBBBBB..", "...BBBBB...", "....BBB....", ".....B.....",
];
const SMILE = [
  "....MMMMM....", "..MMMMMMMMM..", ".MMMMMMMMMMM.", ".MMMKMMMKMMM.", "MMMMKMMMKMMMM", "MMMMMMMMMMMMM",
  "MMKMMMMMMMKMM", ".MMKMMMMMKMM.", ".MMMKKKKKMMM.", "..MMMMMMMMM..", "....MMMMM....",
];

function sunset(x0: number, y0: number, w: number, h: number): StoryPixel[] {
  const px: StoryPixel[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const hill = h * 0.72 + Math.sin(x / 4) * 2.2 + Math.sin(x / 9 + 1) * 1.6;
    const dx = x - w * 0.62, dy = y - h * 0.62, sun = dx * dx + dy * dy < (w * 0.2) ** 2;
    let c = y < h * 0.3 ? C.Bruise : y < h * 0.5 ? C.Grape : y < h * 0.62 ? C.Cone : C.Marigold;
    if (sun) c = C.Nicotine;
    if (y > hill) c = y > hill + 4 ? C.Moss : C.Bile;
    px.push([x0 + x, y0 + y, c]);
  }
  return px;
}

function scribble(x0: number, y0: number, w: number, h: number, color: number, seed: number): StoryPixel[] {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const seen = new Set<number>();
  const px: StoryPixel[] = [];
  let x = x0, y = y0 + h * 0.5, dir = 1;
  for (let i = 0; i < 900 && px.length < 340; i++) {
    x += dir * (1 + r() * 1.5);
    y += (r() - 0.5) * 5;
    if (x > x0 + w || x < x0) { dir = -dir; y += 3 + r() * 4; }
    if (y < y0) y = y0;
    if (y > y0 + h) y = y0 + r() * h;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const X = Math.round(x) + a, Y = Math.round(y) + b, k = X * 999 + Y;
      if (!seen.has(k) && X >= 0 && X < SIZE && Y >= 0 && Y < SIZE) { seen.add(k); px.push([X, Y, color]); }
    }
  }
  return px;
}

function cross(x0: number, y0: number, w: number, h: number, color: number): StoryPixel[] {
  const px: StoryPixel[] = [];
  for (let i = 0; i <= w; i++) {
    const a = Math.round(y0 + (i / w) * h), b = Math.round(y0 + h - (i / w) * h);
    for (const t of [0, 1]) { px.push([x0 + i, a + t, color]); px.push([x0 + i, b + t, color]); }
  }
  return px;
}

const poo = (x: number, y: number) => sprite(POO, { R: C.Rust, C: C.Clay, W: C.Paper, K: C.Ink }, x, y, 3);

/** A day on the sample wall. `at` is sample minutes after midnight. */
export const STORY: StoryEvent[] = [
  { at: 9 * 60 + 2, say: "Someone wrote GM.", px: () => text("GM", 6, 8, C.Marigold, 4) },
  { at: 9 * 60 + 14, say: "Someone drew a poo. Obviously.", px: () => poo(40, 34) },
  { at: 9 * 60 + 31, say: "A heart appeared in the corner.", px: () => sprite(HEART, { B: C.Brick, P: C.Bubblegum }, 96, 8, 2) },
  { at: 10 * 60 + 5, say: "A sunset went up in the bottom left.", px: () => sunset(4, 78, 32, 30) },
  { at: 10 * 60 + 9, say: "A vandal scribbled over the poo. It was 55 minutes old: 2 credits a tile.", px: () => scribble(38, 32, 52, 34, C.Bile, 11) },
  { at: 10 * 60 + 12, say: "The poo came back. Its fans paid 4 credits a tile to cover wet paint.", px: () => poo(40, 34) },
  { at: 10 * 60 + 40, say: "META POO WAS HERE.", px: () => text("META POO WAS HERE", 42, 70, C.Paper, 1) },
  { at: 11 * 60 + 18, say: "Someone crossed out the heart.", px: () => cross(95, 7, 24, 19, C.Ink) },
  { at: 11 * 60 + 55, say: "The heart came back pinker.", px: () => sprite(HEART, { B: C.Bubblegum, P: C.Paper }, 96, 8, 2) },
  { at: 13 * 60 + 3, say: "GM was four hours old. A smiley took it for 1 credit a tile.", px: () => sprite(SMILE, { M: C.Marigold, K: C.Ink }, 6, 4, 2) },
  { at: 13 * 60 + 20, say: "Someone signed it: WASH YOUR HANDS.", px: () => text("WASH YOUR HANDS", 46, 116, C.Bleach, 1) },
  { at: 14 * 60 + 2, say: "Someone wrote GN in the empty corner.", px: () => text("GN", 96, 34, C.Bleach, 3) },
];

/** Practice-wall seed: an old poo, a recent River wave, a fresh Bubblegum tag (sample minutes). */
export function practiceSeed(cols: number, rows: number): Array<{ color: number | null; at: number | null }> {
  const cells = Array.from({ length: cols * rows }, () => ({ color: null as number | null, at: null as number | null }));
  const put = (x: number, y: number, color: number, at: number) => {
    if (x >= 0 && x < cols && y >= 0 && y < rows) cells[y * cols + x] = { color, at };
  };
  ["......RR......", ".....RCCR.....", "....RCCCCR....", "...RRCCCCRR...", "..RCCCCCCCCR..", ".RRRRRRRRRRRR."]
    .forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === "R") put(x + 1, y + 3, C.Rust, -90);
      if (ch === "C") put(x + 1, y + 3, C.Clay, -90);
    }));
  [[10, 0], [11, 1], [12, 1], [13, 0], [14, 1], [15, 2], [9, 1], [8, 2]].forEach(([x, y]) => put(x, y, C.River, -25));
  [[1, 0], [2, 0], [3, 0], [2, 1], [2, 2], [5, 0], [5, 1], [5, 2], [6, 1]].forEach(([x, y]) => put(x, y, C.Bubblegum, -3));
  return cells;
}
