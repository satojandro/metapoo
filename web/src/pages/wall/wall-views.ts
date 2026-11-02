/**
 * Art / Price / Age / Turf (Phase 1 step 2).
 *
 * Four ways to colour the same live wall. They only change how the renderer paints
 * a tile; they never change the board data, the camera or what a paint costs.
 * Price uses the board's own tunables (`get_tunables`, the pricing controller's
 * session cache) with the contract's own rule: age < young window costs the young
 * rate, age < mid window the mid rate, otherwise (and blank) the base rate.
 * A failed read shows "price unavailable", never a guessed number.
 */

import { paletteColor } from "@shared/palette.ts";
import type { PixelView } from "@shared/types.ts";
import type { TilePainter } from "../../render-board";
import { emptyHexAt } from "../../render-board";
import type { WallScope } from "./wall-scope";

export type WallViewMode = "art" | "price" | "age" | "turf";

/** The repaint fields of `get_tunables`. Numbers or digit strings, as the chain sends them. */
export interface ViewTunables {
  repaint_young_ns: number | string;
  repaint_mid_ns: number | string;
  repaint_young_credits: number;
  repaint_mid_credits: number;
  repaint_base_credits: number;
}

/** Whether the viewer still has free first paints. `unknown` is never treated as free. */
export type FreeFirstState = { kind: "yes"; remaining: number } | { kind: "no" } | { kind: "unknown" };

export type Wetness = "wet" | "drying" | "dry";

const MINUTE_NS = 60_000_000_000n;
/** Shown when the board's windows aren't known yet: age only, never a price. */
const DEFAULT_YOUNG_NS = 10n * MINUTE_NS;
const DEFAULT_MID_NS = 60n * MINUTE_NS;
const DAY_NS = 24n * 60n * MINUTE_NS;

export function nowNs(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs)) * 1_000_000n;
}

function big(value: number | string): bigint {
  return typeof value === "number" ? BigInt(Math.floor(value)) : BigInt(value);
}

/** Age in ns, or null for a blank tile or an unreadable stamp. Future stamps count as 0. */
export function tileAgeNs(writtenAtNs: string | null, now: bigint): bigint | null {
  if (writtenAtNs === null || !/^\d+$/.test(writtenAtNs)) return null;
  const age = now - BigInt(writtenAtNs);
  return age < 0n ? 0n : age;
}

export function isViewTunables(value: unknown): value is ViewTunables {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  const ns = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\d+$/.test(v));
  const credits = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  return ns(t.repaint_young_ns) && ns(t.repaint_mid_ns) && credits(t.repaint_young_credits)
    && credits(t.repaint_mid_credits) && credits(t.repaint_base_credits);
}

/** What covering a tile costs now, and how wet it is. Mirrors `Tunables::cost` in the contract. */
export function repaintTier(
  writtenAtNs: string | null,
  now: bigint,
  tunables: ViewTunables,
): { credits: number; wetness: Wetness | null } {
  const age = tileAgeNs(writtenAtNs, now);
  if (age === null) return { credits: tunables.repaint_base_credits, wetness: null };
  if (age < big(tunables.repaint_young_ns)) return { credits: tunables.repaint_young_credits, wetness: "wet" };
  if (age < big(tunables.repaint_mid_ns)) return { credits: tunables.repaint_mid_credits, wetness: "drying" };
  return { credits: tunables.repaint_base_credits, wetness: "dry" };
}

/** Wet / drying / dry by the board's windows, or 10 / 60 minutes while they're unknown. */
export function wetnessOf(writtenAtNs: string | null, now: bigint, tunables: ViewTunables | null): Wetness | null {
  const age = tileAgeNs(writtenAtNs, now);
  if (age === null) return null;
  const young = tunables ? big(tunables.repaint_young_ns) : DEFAULT_YOUNG_NS;
  const mid = tunables ? big(tunables.repaint_mid_ns) : DEFAULT_MID_NS;
  return age < young ? "wet" : age < mid ? "drying" : "dry";
}

/** A blank tile is free for this viewer only when we know they have free first paints left. */
export function blankIsFree(free: FreeFirstState): boolean {
  return free.kind === "yes" && free.remaining > 0;
}

/** FNV-1a: a stable 32-bit hash, so an account keeps its colour on every visit. */
export function hashAccount(account: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < account.length; i += 1) {
    hash ^= account.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A painter's turf hue. The yellow band is skipped: yellow means "you" in Turf.
 * Saturation and lightness are fixed so every painter reads on the dark wall.
 */
export function turfHue(account: string): number {
  const raw = hashAccount(account) % 320;
  return raw < 40 ? raw : raw + 40; // 0–39, then 80–359
}

export function turfColor(account: string): string {
  // A second hash bit varies lightness, so two painters with close hues still differ.
  const lightness = 0.5 + ((hashAccount(account) >>> 11) % 3) * 0.1;
  return hslToHex(turfHue(account), 0.62, lightness);
}

/**
 * Turf colours by rank: the top painters (other than you) each get one of the ten
 * `--mp-turf-*` colours, so the biggest holders are always clearly different.
 * Painters beyond the tenth fall back to their stable hash colour. Ties rank
 * alphabetically, so the assignment is stable for the same wall.
 */
export function assignTurfColors(
  pixels: readonly PixelView[],
  viewer: string | null,
  colors: readonly string[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const pixel of pixels) {
    const artist = pixel.artistAccountId;
    if (pixel.colorIndex === null || !artist || artist === viewer) continue;
    counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = new Map<string, string>();
  ranked.forEach(([account], i) => out.set(account, colors[i] ?? turfColor(account)));
  return out;
}

export interface PainterRow {
  account: string;
  tiles: number;
  you: boolean;
  rank: number;
}

/**
 * Who holds the most wall. Ties go alphabetically so the order is stable. The viewer is
 * appended with their real rank when they're outside the top `limit`.
 */
export function topPainters(pixels: readonly PixelView[], viewer: string | null, limit = 5): PainterRow[] {
  const counts = new Map<string, number>();
  for (const pixel of pixels) {
    if (pixel.colorIndex === null || !pixel.artistAccountId) continue;
    counts.set(pixel.artistAccountId, (counts.get(pixel.artistAccountId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([account, tiles], i) => ({ account, tiles, you: account === viewer, rank: i + 1 }));
  const top = ranked.slice(0, limit);
  if (viewer && !top.some((row) => row.you)) {
    const mine = ranked.find((row) => row.you);
    if (mine) top.push(mine);
  }
  return top;
}

/* ---------- Colours (read from the design tokens, with the token values as fallback) ---------- */

export interface ViewPalette {
  wet: string;
  drying: string;
  dry: string;
  free: string;
  old: string;
  you: string;
  /** `--mp-turf-1` … `--mp-turf-10`, by rank. */
  turf: string[];
}

const TURF_FALLBACK = [
  "#73d7ee", "#ff8fa3", "#7ee081", "#b79ad0", "#ff9f5a",
  "#5f8dff", "#e86fd8", "#3fc7a5", "#ff5f5f", "#c9c4ba",
];

const FALLBACK: ViewPalette = {
  wet: "#ff9f8f",
  drying: "#f1dc5e",
  dry: "#65d5ae",
  free: "#73d7ee",
  old: "#c9c4ba",
  you: "#f1dc5e",
  turf: TURF_FALLBACK,
};

export function readViewPalette(root: Element | null = typeof document !== "undefined" ? document.documentElement : null): ViewPalette {
  if (!root || typeof getComputedStyle !== "function") return FALLBACK;
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return {
    wet: read("--mp-burn", FALLBACK.wet),
    drying: read("--mp-tag", FALLBACK.drying),
    dry: read("--mp-stake", FALLBACK.dry),
    free: read("--mp-near", FALLBACK.free),
    old: read("--mp-team", FALLBACK.old),
    you: read("--mp-tag", FALLBACK.you),
    turf: TURF_FALLBACK.map((fallback, i) => read(`--mp-turf-${i + 1}`, fallback)),
  };
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

/** Age colour: wet → drying → dry → a day old fades toward the wall. */
export function ageColor(age: bigint, tunables: ViewTunables | null, palette: ViewPalette): string {
  const young = tunables ? big(tunables.repaint_young_ns) : DEFAULT_YOUNG_NS;
  const mid = tunables ? big(tunables.repaint_mid_ns) : DEFAULT_MID_NS;
  const faded = mixHex(palette.old, "#2a2b2e", 0.45);
  const stops: Array<[bigint, string]> = [[0n, palette.wet], [young, palette.drying], [mid, palette.old], [DAY_NS, faded]];
  for (let i = 1; i < stops.length; i += 1) {
    const [t1, c1] = stops[i - 1];
    const [t2, c2] = stops[i];
    if (age <= t2) {
      const span = t2 - t1;
      const f = span > 0n ? Number(((age - t1) * 1000n) / span) / 1000 : 1;
      return mixHex(c1, c2, Math.max(0, Math.min(1, f)));
    }
  }
  return faded;
}

/* ---------- The painter the renderer uses ---------- */

export interface PainterInput {
  mode: WallViewMode;
  now: bigint;
  tunables: ViewTunables | null;
  free: FreeFirstState;
  viewer: string | null;
  palette: ViewPalette;
  /** Turf colour per painter (see `assignTurfColors`). Omitted: each painter's hash colour. */
  turf?: ReadonlyMap<string, string>;
}

/** Null means "draw the art as it is". */
export function tilePainterFor(input: PainterInput): TilePainter | null {
  const { mode, now, tunables, free, viewer, palette } = input;
  if (mode === "art") return null;
  if (mode === "price") {
    // Blank tiles stay quiet unless they're free for you: the wall shouldn't turn green.
    const blankTint = blankIsFree(free) ? palette.free : palette.dry;
    const blankMix = blankIsFree(free) ? 0.28 : 0.1;
    return {
      painted: (pixel) => {
        if (!tunables) return mixHex(palette.old, "#1c1d20", 0.6);
        const { wetness } = repaintTier(pixel.lastWriteTimestampNs, now, tunables);
        return wetness === "wet" ? palette.wet : wetness === "drying" ? palette.drying : palette.dry;
      },
      empty: (x, y) => (tunables ? mixHex(emptyHexAt(x, y), blankTint, blankMix) : null),
    };
  }
  if (mode === "age") {
    return {
      painted: (pixel) => {
        const age = tileAgeNs(pixel.lastWriteTimestampNs, now);
        return age === null ? palette.old : ageColor(age, tunables, palette);
      },
      empty: () => null,
    };
  }
  // Turf: every painter their own colour, yours in yellow.
  return {
    painted: (pixel) => {
      const artist = pixel.artistAccountId;
      if (!artist) return mixHex(palette.old, "#1c1d20", 0.6);
      return artist === viewer ? palette.you : input.turf?.get(artist) ?? turfColor(artist);
    },
    empty: () => null,
  };
}

/* ---------- Legends ---------- */

export interface LegendItem {
  label: string;
  color: string;
}

export function legendFor(input: PainterInput & { pixels: readonly PixelView[] }): {
  title: string;
  items: LegendItem[];
  note: string;
  painters: PainterRow[];
} {
  const { mode, tunables, free, palette, pixels, viewer } = input;
  if (mode === "price") {
    if (!tunables) {
      return { title: "Cost to cover", items: [], note: "Price unavailable. The wall couldn’t read its repaint prices.", painters: [] };
    }
    const credit = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;
    const items: LegendItem[] = [
      { label: `${credit(tunables.repaint_young_credits)} · wet`, color: palette.wet },
      { label: `${credit(tunables.repaint_mid_credits)} · drying`, color: palette.drying },
      { label: `${credit(tunables.repaint_base_credits)} · dry`, color: palette.dry },
      blankIsFree(free)
        ? { label: "Blank · free for you", color: mixHex("#1d1e21", palette.free, 0.28) }
        : { label: `Blank · ${credit(tunables.repaint_base_credits)}`, color: mixHex("#1d1e21", palette.dry, 0.1) },
    ];
    const note = blankIsFree(free)
      ? `You have ${free.kind === "yes" ? free.remaining : 0} free first paints for blank tiles.`
      : "Fresh paint costs more to cover, so new work gets a moment on the wall.";
    return { title: "Cost to cover", items, note, painters: [] };
  }
  if (mode === "age") {
    return {
      title: "Paint age",
      items: [
        { label: "Wet", color: palette.wet },
        { label: "Drying", color: palette.drying },
        { label: "Dry", color: palette.old },
        { label: "A day or more", color: mixHex(palette.old, "#2a2b2e", 0.45) },
      ],
      note: "Colours shift as paint dries.",
      painters: [],
    };
  }
  if (mode === "turf") {
    const painters = topPainters(pixels, viewer, 5);
    return {
      title: "Who holds the wall",
      items: viewer ? [{ label: "Your tiles", color: palette.you }] : [],
      note: painters.length ? "Tiles held now. Paint over a tile and it’s yours." : "Nobody holds any wall yet. Be first.",
      painters,
    };
  }
  return { title: "", items: [], note: "", painters: [] };
}

/* ---------- Controller ---------- */

export interface WallViewsDeps {
  scope: WallScope;
  chips: HTMLButtonElement[];
  legend: HTMLElement;
  pixels(): readonly PixelView[];
  viewer(): string | null;
  /** The board's tunables from the pricing controller's session cache; null when unavailable. */
  readTunables(): Promise<unknown>;
  /** `get_free_first_paints` for an account. Rejects when the board doesn't have it. */
  readFreeFirst(account: string): Promise<unknown>;
  render(): void;
  /** Tunables or free paints arrived, or the view changed (the Tile card follows). */
  onChange?(): void;
  /** Ms between "paint dries" re-renders. */
  tickMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface WallViews {
  mode(): WallViewMode;
  setMode(next: WallViewMode): void;
  /** For the renderer. Null in Art. */
  painter(): TilePainter | null;
  tunables(): ViewTunables | null;
  free(): FreeFirstState;
  /** Board pixels or the wallet changed: refresh legend (and free paints on wallet change). */
  refresh(): void;
  onWalletChanged(): void;
  /** Read tunables and the viewer's free paints if not known yet (cached, rate-limited). */
  prime(): void;
  dispose(): void;
}

const FREE_REFRESH_MS = 60_000;

export function parseFreeFirst(value: unknown): FreeFirstState {
  if (!value || typeof value !== "object") return { kind: "unknown" };
  const v = value as Record<string, unknown>;
  if (typeof v.remaining !== "number" || typeof v.active !== "boolean") return { kind: "unknown" };
  return v.active && v.remaining > 0 ? { kind: "yes", remaining: v.remaining } : { kind: "no" };
}

export function createWallViews(deps: WallViewsDeps): WallViews {
  const { scope, chips, legend } = deps;
  const now = deps.now ?? Date.now;
  let mode: WallViewMode = "art";
  let tunables: ViewTunables | null = null;
  let tunablesTriedAt: number | null = null;
  let tunablesInFlight = false;
  /** The Tile card asked for prices: keep trying until the board answers. */
  let primed = false;
  let free: FreeFirstState = { kind: "unknown" };
  let freeFor: string | null = null;
  let freeReadAt = 0;
  let freeMissing = false;
  let palette = readViewPalette();

  /** Turf colours are ranked once per wall and viewer, not per tile. */
  let turfCache: { pixels: readonly PixelView[]; viewer: string | null; size: number; map: Map<string, string> } | null = null;
  function turfColors(): Map<string, string> {
    const pixels = deps.pixels();
    const viewer = deps.viewer();
    if (!turfCache || turfCache.pixels !== pixels || turfCache.viewer !== viewer || turfCache.size !== pixels.length) {
      turfCache = { pixels, viewer, size: pixels.length, map: assignTurfColors(pixels, viewer, palette.turf) };
    }
    return turfCache.map;
  }

  function painterInput(): PainterInput {
    return {
      mode,
      now: nowNs(now()),
      tunables,
      free,
      viewer: deps.viewer(),
      palette,
      turf: mode === "turf" ? turfColors() : undefined,
    };
  }

  function renderLegend(): void {
    legend.replaceChildren();
    legend.hidden = mode === "art";
    if (mode === "art") return;
    const data = legendFor({ ...painterInput(), pixels: deps.pixels() });
    const title = document.createElement("p");
    title.className = "mp-eyebrow";
    title.textContent = data.title;
    legend.append(title);
    if (data.items.length) {
      const list = document.createElement("ul");
      list.className = "wall-legend-items";
      for (const item of data.items) {
        const li = document.createElement("li");
        const sw = document.createElement("i");
        sw.style.background = item.color;
        sw.setAttribute("aria-hidden", "true");
        li.append(sw, document.createTextNode(item.label));
        list.append(li);
      }
      legend.append(list);
    }
    if (data.painters.length) {
      const list = document.createElement("ol");
      list.className = "wall-turf-list";
      for (const row of data.painters) {
        const li = document.createElement("li");
        if (row.you) li.dataset.you = "true";
        const sw = document.createElement("i");
        sw.style.background = row.you ? palette.you : turfColors().get(row.account) ?? turfColor(row.account);
        sw.setAttribute("aria-hidden", "true");
        const rank = document.createElement("span");
        rank.className = "wall-turf-rank";
        rank.textContent = `${row.rank}`;
        const name = document.createElement("span");
        name.className = "wall-turf-name";
        name.textContent = row.you ? `${row.account} (you)` : row.account;
        const tiles = document.createElement("span");
        tiles.className = "wall-turf-tiles";
        tiles.textContent = `${row.tiles} tile${row.tiles === 1 ? "" : "s"}`;
        li.append(rank, sw, name, tiles);
        list.append(li);
      }
      legend.append(list);
    }
    if (data.note) {
      const note = document.createElement("p");
      note.className = "wall-legend-note";
      note.textContent = data.note;
      legend.append(note);
    }
  }

  function syncChips(): void {
    for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.wallView === mode));
  }

  async function ensureTunables(): Promise<void> {
    // Read once per session; after a failure, try again at most once a minute.
    if (tunables || tunablesInFlight) return;
    if (tunablesTriedAt !== null && now() - tunablesTriedAt < FREE_REFRESH_MS) return;
    tunablesInFlight = true;
    tunablesTriedAt = now();
    try {
      const value = await deps.readTunables();
      if (scope.isDisposed()) return;
      tunables = isViewTunables(value) ? value : null;
      // Null without an error: the board's schema isn't known yet (or it has no paid
      // pricing). Nothing was read, so the next board update may ask again.
      if (value === null) tunablesTriedAt = null;
    } catch {
      tunables = null;
    }
    tunablesInFlight = false;
    if (!scope.isDisposed()) update();
  }

  async function ensureFree(force = false): Promise<void> {
    const account = deps.viewer();
    if (!account) {
      free = { kind: "unknown" };
      freeFor = null;
      return;
    }
    if (freeMissing) return;
    if (!force && freeFor === account && now() - freeReadAt < FREE_REFRESH_MS) return;
    freeFor = account;
    freeReadAt = now();
    try {
      const value = await deps.readFreeFirst(account);
      if (scope.isDisposed() || deps.viewer() !== account) return;
      free = parseFreeFirst(value);
    } catch (error) {
      if (/MethodNotFound|MethodResolveError/i.test(error instanceof Error ? error.message : String(error))) freeMissing = true;
      free = { kind: "unknown" };
    }
    if (!scope.isDisposed()) update();
  }

  function update(): void {
    syncChips();
    renderLegend();
    deps.render();
    deps.onChange?.();
  }

  function setMode(next: WallViewMode): void {
    if (next === mode) return;
    mode = next;
    palette = readViewPalette();
    turfCache = null;
    update();
    if (mode === "price" || mode === "age") void ensureTunables();
    if (mode === "price") void ensureFree();
  }

  for (const chip of chips) {
    chip.disabled = false;
    chip.removeAttribute("title");
    scope.listen(chip, "click", () => {
      const view = chip.dataset.wallView as WallViewMode | undefined;
      if (view === "art" || view === "price" || view === "age" || view === "turf") setMode(view);
    });
  }

  // Wet paint dries: keep Price and Age honest without re-reading the board.
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
  const clearTimer = deps.clearInterval ?? ((handle: unknown) => window.clearInterval(handle as number));
  const timer = setTimer(() => {
    if (scope.isDisposed() || mode === "art" || mode === "turf") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (mode === "price") void ensureFree();
    if (!tunables) void ensureTunables();
    update();
  }, deps.tickMs ?? 15_000);
  scope.onDispose(() => clearTimer(timer));

  syncChips();
  renderLegend();

  return {
    mode: () => mode,
    setMode,
    painter: () => tilePainterFor(painterInput()),
    tunables: () => tunables,
    free: () => free,
    refresh: () => {
      if (!tunables && (primed || mode === "price" || mode === "age")) void ensureTunables();
      if (mode !== "art") renderLegend();
    },
    onWalletChanged: () => {
      free = { kind: "unknown" };
      freeFor = null;
      if (mode === "price") void ensureFree(true);
      else if (mode !== "art") update();
    },
    prime: () => {
      primed = true;
      void ensureTunables();
      void ensureFree();
    },
    dispose: () => clearTimer(timer),
  };
}

/** Colour name for a palette index, or null. */
export function paletteName(index: number | null): string | null {
  if (index === null) return null;
  return paletteColor(index)?.name ?? null;
}
