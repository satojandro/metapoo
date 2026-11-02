/**
 * The Tile card (Phase 1 step 3): who painted a tile, how long ago, what covering
 * it costs now, "Paint over this" and a shareable `#tile-x-y` link.
 *
 * Read-only. Every fact comes from data the page already has: the wall's pixel
 * cache (colour, painter, write time), the pricing controller's last quote for
 * the tile, and the board's tunables. Whether a tile earns TOILET is not shown:
 * no view the page reads says whether a tile's latest paint was free.
 */

import { paletteColor } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import { accountExplorerUrl } from "../../app/revenue-panel";
import type { Cell } from "../../selection";
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
}

export interface InspectorModel {
  colour: { name: string; hex: string } | null;
  painter: { account: string; you: boolean; href: string | null } | null;
  ago: string | null;
  wetness: Wetness | null;
  cost: string;
  link: string;
}

const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

export function inspectorModel(input: InspectorInput): InspectorModel {
  const { cell, pixel, viewer, now, tunables, free, knownCost, network, pageUrl } = input;
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

  return {
    colour: swatch ? { name: swatch.name, hex: swatch.hex } : null,
    painter: artist ? { account: artist, you: artist === viewer, href: accountExplorerUrl(network, artist) } : null,
    ago: age === null ? null : formatAgo(age),
    wetness: painted ? wetnessOf(pixel!.lastWriteTimestampNs, now, tunables) : null,
    cost,
    link: tileLink(pageUrl, cell),
  };
}

/* ---------- DOM ---------- */

export interface TileInspectorDeps {
  scope: WallScope;
  /** The Tile card; gets `data-filled` so the plain summary steps back for sighted users. */
  card: HTMLElement;
  host: HTMLElement;
  selected(): Cell | null;
  cachedPixel(cell: Cell): PixelView | null | undefined;
  viewer(): string | null;
  tunables(): ViewTunables | null;
  free(): FreeFirstState;
  knownCost(cell: Cell): number | undefined;
  network: string;
  /** Make sure tunables (and free paints) are read; cheap, cached. */
  prime(): void;
  paintOver(cell: Cell): void;
  pageUrl?: () => string;
  now?: () => number;
  copy?: (text: string) => Promise<void>;
  tickMs?: number;
}

export interface TileInspector {
  render(): void;
}

export function createTileInspector(deps: TileInspectorDeps): TileInspector {
  const { scope, card, host } = deps;
  const pageUrl = deps.pageUrl ?? (() => window.location.href);
  const now = deps.now ?? Date.now;
  const copy = deps.copy ?? ((text: string) => navigator.clipboard.writeText(text));
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
    const cell = deps.selected();
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
    });

    const drawn = JSON.stringify(model);
    if (drawn === lastDrawn && !host.hidden) return;
    lastDrawn = drawn;

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
      const who = el("span", "tile-painter");
      if (model.painter.href) {
        const link = el("a", undefined, model.painter.account);
        link.href = model.painter.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        who.append(link);
      } else {
        who.textContent = model.painter.account;
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

    const actions = el("div", "tile-actions");
    const paintOver = el("button", "mp-btn mp-btn-primary tile-paint-over", model.colour ? "Paint over this" : "Paint this tile");
    paintOver.type = "button";
    scope.listen(paintOver, "click", () => deps.paintOver(cell));
    const copyButton = el("button", "mp-btn tile-copy", "Copy link");
    copyButton.type = "button";
    const copied = el("p", "tile-copied");
    copied.setAttribute("role", "status");
    scope.listen(copyButton, "click", () => {
      copy(model.link).then(
        () => {
          copied.textContent = "Link copied.";
        },
        () => {
          // Clipboard refused: show the link selected so it can be copied by hand.
          const field = el("input", "tile-link-field");
          field.type = "text";
          field.readOnly = true;
          field.value = model.link;
          field.setAttribute("aria-label", "Link to this tile");
          copied.replaceChildren(field);
          field.focus();
          field.select();
        },
      );
    });
    actions.append(paintOver, copyButton);

    host.replaceChildren(list, actions, copied);
    host.hidden = false;
    card.dataset.filled = "true";
  }

  // Wet paint dries while the card is open.
  const timer = window.setInterval(() => {
    if (!scope.isDisposed() && deps.selected() && document.visibilityState !== "hidden") render();
  }, deps.tickMs ?? 15_000);
  scope.onDispose(() => window.clearInterval(timer));

  return { render };
}
