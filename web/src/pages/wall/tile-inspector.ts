/**
 * The Tile card (Phase 1 step 3): who painted a tile, how long ago, what covering
 * it costs now and "Paint over this". It describes the hovered tile while a mouse is
 * over the wall, and the selected tile otherwise. `#tile-x-y` deep links still open
 * the wall on a tile; the card no longer offers a Copy link button (owner, 7 Nov).
 *
 * Read-only. Every fact comes from data the page already has: the wall's pixel
 * cache (colour, painter, write time), the pricing controller's last quote for
 * the tile, and the board's tunables. Wet and drying paint also says when it gets
 * cheaper. Whether a tile earns TOILET is not shown: no view the page reads says
 * whether a tile's latest paint was free.
 */

import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import { accountExplorerUrl } from "../../app/revenue-panel";
import type { Cell } from "../../selection";
import { shortAccount } from "../../shared/short-account";
import type { WallScope } from "./wall-scope";
import {
  blankIsFree,
  nowNs,
  repaintTier,
  tileAgeNs,
  wetnessOf,
  type FreeFirstState,
  type ViewTunables,
  type Wetness,
} from "./wall-views";

/** `#tile-12-80` → { x: 12, y: 80 }. Anything else, or off the wall, is ignored. */
export function parseTileHash(hash: string | null | undefined): Cell | null {
  const match = /^#tile-(\d{1,3})-(\d{1,3})$/.exec(hash ?? "");
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return null;
  return { x, y };
}

export function tileLink(base: string, cell: Cell): string {
  return `${base.split("#")[0]}#tile-${cell.x}-${cell.y}`;
}

export function formatAgo(ageNs: bigint): string {
  const minutes = Number(ageNs / 60_000_000_000n);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export interface InspectorInput {
  cell: Cell;
  pixel: PixelView | null | undefined;
  viewer: string | null;
  now: bigint;
  tunables: ViewTunables | null;
  free: FreeFirstState;
  /** The pricing controller's last quote for this tile (account-specific), if fresh. */
  knownCost: number | undefined;
  network: string;
  pageUrl: string;
  /** False until the wall has been read once: a blank tile might just not be loaded yet. */
  loaded?: boolean;
}

export interface InspectorModel {
  /** The wall isn't read yet: show that instead of facts that could be wrong. */
  loading: boolean;
  colour: { name: string; hex: string } | null;
  painter: { account: string; you: boolean; href: string | null } | null;
  ago: string | null;
  wetness: Wetness | null;
  cost: string;
  /** "1 credit in 42 min": when wet or drying paint gets cheaper to cover. Null otherwise. */
  cheaper: string | null;
  link: string;
}

const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

export function inspectorModel(input: InspectorInput): InspectorModel {
  const { cell, pixel, viewer, now, tunables, free, knownCost, network, pageUrl } = input;
  if (input.loaded === false && !(pixel && pixel.colorIndex !== null)) {
    return { loading: true, colour: null, painter: null, ago: null, wetness: null, cost: "", cheaper: null, link: tileLink(pageUrl, cell) };
  }
  const painted = !!pixel && pixel.colorIndex !== null;
  const swatch = painted ? paletteColor(pixel!.colorIndex!) : null;
  const artist = painted ? pixel!.artistAccountId : null;
  const age = painted ? tileAgeNs(pixel!.lastWriteTimestampNs, now) : null;

  let cost: string;
  if (knownCost === 0 || (!painted && blankIsFree(free))) {
    cost = free.kind === "yes" ? `Free for you · ${free.remaining} free first paint${free.remaining === 1 ? "" : "s"} left` : "Free for you";
  } else if (knownCost !== undefined) {
    cost = credits(knownCost);
  } else if (tunables) {
    cost = credits(repaintTier(painted ? pixel!.lastWriteTimestampNs : null, now, tunables).credits);
  } else {
    cost = "Price unavailable";
  }

  const isFree = knownCost === 0 || (!painted && blankIsFree(free));
  const cheaper = painted && !isFree && tunables && age !== null ? cheaperIn(age, tunables) : null;

  return {
    loading: false,
    colour: swatch ? { name: swatch.name, hex: swatch.hex } : null,
    painter: artist ? { account: artist, you: artist === viewer, href: accountExplorerUrl(network, artist) } : null,
    ago: age === null ? null : formatAgo(age),
    wetness: painted ? wetnessOf(pixel!.lastWriteTimestampNs, now, tunables) : null,
    cost,
    cheaper,
    link: tileLink(pageUrl, cell),
  };
}

/** The next, lower price and how long until it applies, from the board's own windows. */
export function cheaperIn(ageNs: bigint, tunables: ViewTunables): string | null {
  const young = BigInt(tunables.repaint_young_ns);
  const mid = BigInt(tunables.repaint_mid_ns);
  let leftNs: bigint;
  let next: number;
  let current: number;
  if (ageNs < young) {
    leftNs = young - ageNs;
    next = tunables.repaint_mid_credits;
    current = tunables.repaint_young_credits;
  } else if (ageNs < mid) {
    leftNs = mid - ageNs;
    next = tunables.repaint_base_credits;
    current = tunables.repaint_mid_credits;
  } else {
    return null;
  }
  if (next >= current) return null;
  const minutes = Math.max(1, Math.ceil(Number(leftNs) / 60_000_000_000));
  return `${credits(next)} in ${minutes} min`;
}

/* ---------- DOM ---------- */

export interface TileInspectorDeps {
  scope: WallScope;
  /** The Tile card; gets `data-filled` so the plain summary steps back for sighted users. */
  card: HTMLElement;
  host: HTMLElement;
  selected(): Cell | null;
  /**
   * The tile under a fine pointer, if any. While set, the card describes it instead
   * of the selection, so a tile can be inspected without tapping (which may paint).
   * Read from the pixel cache only: hovering costs no RPC.
   */
  hovered?(): Cell | null;
  cachedPixel(cell: Cell): PixelView | null | undefined;
  viewer(): string | null;
  tunables(): ViewTunables | null;
  free(): FreeFirstState;
  knownCost(cell: Cell): number | undefined;
  network: string;
  /** Whether the wall has been read once. Omitted means yes. */
  loaded?(): boolean;
  /** Make sure tunables (and free paints) are read; cheap, cached. */
  prime(): void;
  paintOver(cell: Cell): void;
  pageUrl?: () => string;
  now?: () => number;
  tickMs?: number;
}

export interface TileInspector {
  render(): void;
}

export function createTileInspector(deps: TileInspectorDeps): TileInspector {
  const { scope, card, host } = deps;
  const pageUrl = deps.pageUrl ?? (() => window.location.href);
  const now = deps.now ?? Date.now;
  let lastPrimed: string | null = null;
  /** The model last drawn: board polls re-render only when something changed. */
  let lastDrawn: string | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function row(label: string, value: Node | string): HTMLElement {
    const wrap = el("div", "tile-row");
    wrap.append(el("dt", undefined, label));
    const dd = el("dd");
    dd.append(value);
    wrap.append(dd);
    return wrap;
  }

  function render(): void {
    if (scope.isDisposed()) return;
    const cell = deps.hovered?.() ?? deps.selected();
    if (!cell) {
      host.hidden = true;
      host.replaceChildren();
      card.dataset.filled = "false";
      lastDrawn = null;
      return;
    }
    const key = `${cell.x},${cell.y}`;
    if (key !== lastPrimed) {
      lastPrimed = key;
      deps.prime();
    }
    const model = inspectorModel({
      cell,
      pixel: deps.cachedPixel(cell),
      viewer: deps.viewer(),
      now: nowNs(now()),
      tunables: deps.tunables(),
      free: deps.free(),
      knownCost: deps.knownCost(cell),
      network: deps.network,
      pageUrl: pageUrl(),
      loaded: deps.loaded ? deps.loaded() : true,
    });

    const drawn = JSON.stringify(model);
    if (drawn === lastDrawn && !host.hidden) return;
    lastDrawn = drawn;

    if (model.loading) {
      host.replaceChildren(el("p", "tile-loading", "Reading the wall…"));
      host.hidden = false;
      card.dataset.filled = "true";
      return;
    }

    const list = el("dl", "tile-facts");
    const colour = el("span", "tile-colour");
    if (model.colour) {
      const sw = el("i", "tile-swatch");
      sw.style.background = model.colour.hex;
      sw.setAttribute("aria-hidden", "true");
      colour.append(sw, document.createTextNode(model.colour.name));
    } else {
      colour.textContent = "Blank. Nobody has painted it yet.";
    }
    list.append(row("Colour", colour));

    if (model.painter) {
      // A 64-character implicit id printed whole ran across three lines in the
      // card (owner, 11 Nov). Show the shared short form; keep the whole id in
      // `title` and in the label, so it is still there to read or copy.
      const who = el("span", "tile-painter");
      const short = shortAccount(model.painter.account);
      const full = model.painter.account;
      if (model.painter.href) {
        const link = el("a", undefined, short);
        link.href = model.painter.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = full;
        link.setAttribute("aria-label", `Painted by ${full}. Opens the account in a block explorer.`);
        who.append(link);
      } else {
        who.textContent = short;
        who.title = full;
      }
      if (model.painter.you) who.append(el("span", "tile-you", "you"));
      list.append(row("Painted by", who));
    }

    if (model.ago) {
      const when = el("span", "tile-when", model.ago);
      if (model.wetness) {
        const pill = el("span", "tile-pill", model.wetness);
        pill.dataset.wetness = model.wetness;
        when.append(pill);
      }
      list.append(row("When", when));
    }

    list.append(row("Cover it for", el("span", "tile-cost", model.cost)));
    if (model.cheaper) list.append(row("Cheaper", el("span", "tile-cheaper", model.cheaper)));

    const actions = el("div", "tile-actions");
    const paintOver = el("button", "mp-btn mp-btn-primary tile-paint-over", model.colour ? "Paint over this" : "Paint this tile");
    paintOver.type = "button";
    scope.listen(paintOver, "click", () => deps.paintOver(cell));
    actions.append(paintOver);

    host.replaceChildren(list, actions);
    host.hidden = false;
    card.dataset.filled = "true";
  }

  // Wet paint dries while the card is open.
  const timer = window.setInterval(() => {
    if (!scope.isDisposed() && (deps.hovered?.() ?? deps.selected()) && document.visibilityState !== "hidden") render();
  }, deps.tickMs ?? 15_000);
  scope.onDispose(() => window.clearInterval(timer));

  return { render };
}
