/**
 * The Look-mode invite card (Phase 1 step 4). Real counts only: painted tiles,
 * tiles never painted, and paint that is wet right now. When the wall is nearly
 * blank it says so and leads with the free first paints, if the board offers them.
 * Nothing here draws on the wall, and an unknown number is never shown as a guess.
 */

import { BOARD_HEIGHT, BOARD_WIDTH, type PixelView } from "@shared/types.ts";
import type { WallScope } from "./wall-scope";
import { blankIsFree, nowNs, repaintTier, type FreeFirstState, type ViewTunables } from "./wall-views";

export const WALL_TILES = BOARD_WIDTH * BOARD_HEIGHT;
/** Under 2% painted (fewer than 328 of 16,384 tiles) reads as "almost blank". */
export const NEARLY_EMPTY_SHARE = 0.02;

export interface WallStats {
  painted: number;
  neverPainted: number;
  /** Tiles painted inside the board's young window. Null while the window is unknown. */
  wetNow: number | null;
  nearlyEmpty: boolean;
}

export function wallStats(pixels: readonly PixelView[], now: bigint, tunables: ViewTunables | null): WallStats {
  let painted = 0;
  let wet = 0;
  for (const pixel of pixels) {
    if (pixel.colorIndex === null) continue;
    painted += 1;
    if (tunables && repaintTier(pixel.lastWriteTimestampNs, now, tunables).wetness === "wet") wet += 1;
  }
  painted = Math.min(painted, WALL_TILES);
  return {
    painted,
    neverPainted: WALL_TILES - painted,
    wetNow: tunables ? wet : null,
    nearlyEmpty: painted < WALL_TILES * NEARLY_EMPTY_SHARE,
  };
}

/**
 * Free first paints per account, from the board's own tunables, while the wall is
 * still filling. A tile can't be unpainted, so a wall with blank tiles hasn't had
 * its first fill yet. Null when the board doesn't say, or offers none.
 */
export function freeFirstOffer(tunables: unknown, stats: WallStats): number | null {
  if (!tunables || typeof tunables !== "object") return null;
  const value = (tunables as Record<string, unknown>).free_first_paints_per_account;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return stats.neverPainted > 0 ? value : null;
}

export interface InviteModel {
  eyebrow: string;
  title: string;
  accent: string;
  body: string;
  /** Null until the wall has been read once. */
  stats: WallStats | null;
  free: string | null;
  action: string;
}

const count = (n: number) => n.toLocaleString("en-US");

export function inviteModel(input: {
  loaded: boolean;
  stats: WallStats;
  offer: number | null;
  viewerFree: FreeFirstState;
  connected: boolean;
}): InviteModel {
  const { loaded, stats, offer, viewerFree, connected } = input;
  let free: string | null = null;
  if (connected && blankIsFree(viewerFree) && viewerFree.kind === "yes") {
    free = `You have ${viewerFree.remaining} free first paint${viewerFree.remaining === 1 ? "" : "s"} left. Blank tiles cost you nothing.`;
  } else if (connected && viewerFree.kind === "no") {
    free = null;
  } else if (offer !== null) {
    free = `Your first ${offer} tiles are free while the wall fills up.`;
  }

  if (loaded && stats.nearlyEmpty) {
    return {
      eyebrow: "The wall",
      title: "The wall is almost blank.",
      accent: "Get on it first.",
      body: stats.painted === 0
        ? "Nobody has painted here yet. The first mark on the wall could be yours."
        : `Only ${count(stats.painted)} of ${count(WALL_TILES)} tiles have paint so far. Whoever shows up now decides what the wall becomes.`,
      stats,
      free,
      action: "Start painting",
    };
  }
  return {
    eyebrow: "The wall",
    title: "Leave your mark.",
    accent: "Cover someone else’s.",
    body: "Everything here was painted by someone. Tap a tile to see who. Fresh paint costs more to cover, so new work gets a moment on the wall.",
    stats: loaded ? stats : null,
    free,
    action: "Start painting",
  };
}

export interface WallInviteDeps {
  scope: WallScope;
  card: HTMLElement;
  pixels(): readonly PixelView[];
  loaded(): boolean;
  tunables(): ViewTunables | null;
  viewerFree(): FreeFirstState;
  connected(): boolean;
  now?: () => number;
}

export interface WallInvite {
  render(): void;
}

/**
 * Fills the invite card's text, counts and free line. The card's Start painting
 * button stays where the template put it (its handler belongs to the modes).
 */
export function createWallInvite(deps: WallInviteDeps): WallInvite {
  const { scope, card } = deps;
  const now = deps.now ?? Date.now;
  const eyebrow = card.querySelector<HTMLElement>(".mp-eyebrow");
  const heading = card.querySelector<HTMLElement>("h3");
  const body = card.querySelector<HTMLElement>(".wall-invite-body");
  const statsHost = card.querySelector<HTMLElement>(".wall-stats");
  const freeLine = card.querySelector<HTMLElement>(".wall-invite-free");
  let lastDrawn: string | null = null;

  function render(): void {
    if (scope.isDisposed()) return;
    const loaded = deps.loaded();
    const tunables = deps.tunables();
    const stats = wallStats(deps.pixels(), nowNs(now()), tunables);
    const model = inviteModel({
      loaded,
      stats,
      offer: freeFirstOffer(tunables, stats),
      viewerFree: deps.viewerFree(),
      connected: deps.connected(),
    });
    const drawn = JSON.stringify(model);
    if (drawn === lastDrawn) return;
    lastDrawn = drawn;

    card.dataset.state = loaded ? (stats.nearlyEmpty ? "nearly-empty" : "normal") : "loading";
    if (eyebrow) eyebrow.textContent = model.eyebrow;
    if (heading) {
      const em = document.createElement("em");
      em.textContent = model.accent;
      heading.replaceChildren(document.createTextNode(`${model.title} `), em);
    }
    if (body) body.textContent = model.body;
    if (statsHost) {
      const cell = (label: string, value: string) => {
        const wrap = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        wrap.append(dt, dd);
        return wrap;
      };
      const s = model.stats;
      statsHost.replaceChildren(
        cell("Painted", s ? count(s.painted) : "…"),
        cell("Never painted", s ? count(s.neverPainted) : "…"),
        // Wet paint needs the board's own window; without it, say nothing rather than guess.
        cell("Wet now", s && s.wetNow !== null ? count(s.wetNow) : "…"),
      );
      statsHost.setAttribute("aria-busy", String(!s));
    }
    if (freeLine) {
      freeLine.textContent = model.free ?? "";
      freeLine.hidden = model.free === null;
    }
  }

  return { render };
}
