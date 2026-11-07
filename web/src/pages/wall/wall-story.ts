/**
 * The wall's story: what the other pages explain, said once on the wall itself
 * (owner, 7 Nov: "we are hiding a lot of the design and useful info elsewhere").
 *
 * - In the invite card: how full the wall is, when happy hour is, and what a held
 *   tile earns in TOILET.
 * - "Who holds the wall": the Turf ranking, always visible in Look mode, with each
 *   holder's TOILET per day.
 * - Below the wall: three short rule cards that lead to How it works, TOILET and
 *   Where the money goes.
 *
 * Live reads only. A number the board hasn't confirmed is left out, never guessed.
 * Nothing here paints, selects, or touches the camera.
 */

import { wallTiles, type PixelView } from "@shared/types.ts";
import {
  minutesText,
  nextHappyHourStart,
  parseHappyHour,
  utcClock,
  weekdayName,
  type HappyHourSchedule,
} from "../../app/how-it-works";
import { MPOO_SPLIT } from "../../app/revenue-panel";
import { parseEmission, perCellDay } from "../../app/toilet";
import type { WallScope } from "./wall-scope";
import type { WallStats } from "./wall-invite";
import { formatAgo } from "./tile-inspector";
import { topPainters, type PainterRow, type ViewTunables } from "./wall-views";

const count = (n: number) => n.toLocaleString("en-US");

/** 1e-18 units → whole TOILET as a float, for display only. */
function toiletFloat(units: bigint): number {
  return Number(units / 10n ** 15n) / 1000;
}

/** "86.4", "1,212", "18.3k", "1.2M". Display only; never used for arithmetic. */
export function formatToilet(units: bigint): string {
  const value = toiletFloat(units);
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trim(value / 1_000)}k`;
  if (value >= 100) return count(Math.round(value));
  return trim(value);
}

function trim(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/** TOILET a held tile earns per day, from `get_toilet_emission`. Null: unknown or switched off. */
export function perTileDayFrom(raw: unknown): bigint | null {
  try {
    const perDay = perCellDay(parseEmission(raw));
    return perDay > 0n ? perDay : null;
  } catch {
    return null;
  }
}

/**
 * The earning sentence in three parts, so the amount can be set in bold. Only paint
 * paid with credits earns: a free first paint holds the tile but earns nothing until
 * someone repaints it with credits (emission.rs, `free_paint_earns_nothing`).
 */
export function earnParts(perTileDay: bigint | null): [string, string, string] | null {
  if (perTileDay === null) return null;
  return [
    "Every tile you paint with credits earns ",
    `${formatToilet(perTileDay)} TOILET a day`,
    " until someone paints over it. Free tiles earn nothing.",
  ];
}

/**
 * What a stroke's credit-paid tiles can earn. "Up to": a tile you already hold
 * with paid paint is already earning, and the rate can change.
 */
export function strokeEarnLine(paidCells: number, perTileDay: bigint | null): string | null {
  if (perTileDay === null || paidCells <= 0) return null;
  const total = formatToilet(perTileDay * BigInt(paidCells));
  return `Earns up to ${total} TOILET a day while ${paidCells === 1 ? "it survives" : "they survive"}`;
}

export function earnLine(perTileDay: bigint | null): string | null {
  return earnParts(perTileDay)?.join("") ?? null;
}

export function happyHourLine(
  schedule: HappyHourSchedule | null,
  stats: WallStats | null,
  nowMs: number,
): string | null {
  if (!schedule) return null;
  if (!schedule.enabled) {
    // The board turns happy hour on after the first fill; before that, say when.
    return stats && stats.neverPainted > 0 ? "Happy hour starts once the wall is full." : null;
  }
  const startMs = nextHappyHourStart(nowMs, schedule.weekday, schedule.startS, schedule.lengthS);
  if (nowMs >= startMs) {
    const left = Math.max(1, Math.ceil((startMs + schedule.lengthS * 1000 - nowMs) / 60_000));
    return `Happy hour is on: dry tiles are free for ${left} more minute${left === 1 ? "" : "s"}.`;
  }
  return `Next happy hour: ${weekdayName(schedule.weekday)} ${utcClock(schedule.startS)}.`;
}

/**
 * Who holds the most wall. Tiles only, no TOILET figure: a holder's free-painted
 * tiles earn nothing, and no view the page reads says which tiles those are.
 */
export function holderRows(pixels: readonly PixelView[], viewer: string | null, limit = 5): PainterRow[] {
  return topPainters(pixels, viewer, limit);
}

export interface RecentStroke {
  artist: string;
  tiles: number;
  /** Newest paint in the stroke. */
  atNs: bigint;
  /** Where to look: the tile nearest the stroke's middle. */
  cell: { x: number; y: number };
}

/** Paint by one artist with gaps under this counts as one stroke. */
const STROKE_GAP_NS = 5n * 60_000_000_000n;

/**
 * The latest strokes, newest first, from the pixel cache's painter and paint time.
 * Only the latest paint on each tile is known, so a stroke that was since covered
 * shrinks or drops out. The card says so.
 */
export function recentStrokes(pixels: readonly PixelView[], limit = 4): RecentStroke[] {
  const writes: Array<{ x: number; y: number; artist: string; at: bigint }> = [];
  for (const p of pixels) {
    if (p.colorIndex === null || !p.artistAccountId || !p.lastWriteTimestampNs) continue;
    if (!/^\d+$/.test(p.lastWriteTimestampNs)) continue;
    writes.push({ x: p.x, y: p.y, artist: p.artistAccountId, at: BigInt(p.lastWriteTimestampNs) });
  }
  writes.sort((a, b) => (a.at === b.at ? 0 : a.at > b.at ? -1 : 1));

  type Group = { artist: string; newest: bigint; oldest: bigint; cells: Array<{ x: number; y: number }> };
  const groups: Group[] = [];
  const open = new Map<string, Group>();
  for (const w of writes) {
    const current = open.get(w.artist);
    if (current && current.oldest - w.at <= STROKE_GAP_NS) {
      current.oldest = w.at;
      current.cells.push({ x: w.x, y: w.y });
      continue;
    }
    // Enough strokes, and this write can only start an older one: stop.
    if (groups.length >= limit && !current) break;
    const group: Group = { artist: w.artist, newest: w.at, oldest: w.at, cells: [{ x: w.x, y: w.y }] };
    groups.push(group);
    open.set(w.artist, group);
  }
  return groups.slice(0, limit).map((g) => {
    const mx = g.cells.reduce((s, c) => s + c.x, 0) / g.cells.length;
    const my = g.cells.reduce((s, c) => s + c.y, 0) / g.cells.length;
    let best = g.cells[0]!;
    let bestD = Infinity;
    for (const c of g.cells) {
      const d = (c.x - mx) ** 2 + (c.y - my) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return { artist: g.artist, tiles: g.cells.length, atNs: g.newest, cell: best };
  });
}

export interface RuleCard {
  key: "wet" | "earn" | "money";
  title: string;
  body: string;
  href: string;
  link: string;
}

export function ruleCards(tunables: ViewTunables | null): RuleCard[] {
  const credit = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;
  const wet = tunables
    ? `Paint less than ${minutesText(tunables.repaint_young_ns)} old costs ${credit(tunables.repaint_young_credits)} to cover, ` +
      `less than ${minutesText(tunables.repaint_mid_ns)} old ${credit(tunables.repaint_mid_credits)}, ` +
      `and dry paint ${credit(tunables.repaint_base_credits)}. New work gets a moment on the wall.`
    : "Fresh paint costs more to cover, so new work gets a moment on the wall before someone wipes it.";
  return [
    { key: "wet", title: "Wet paint costs more", body: wet, href: "/how-it-works", link: "How painting works" },
    {
      key: "earn",
      title: "Tiles earn TOILET",
      body: `Tiles you hold earn TOILET every second they survive. Stake it to share ${MPOO_SPLIT.stakers}% of the mPOO the stall takes in.`,
      href: "/toilet",
      link: "What TOILET is for",
    },
    {
      key: "money",
      title: "The stall runs itself",
      body: "Credits pay the contract, not a person. It sends the money out on a fixed schedule, and every change is a public transaction.",
      href: "/money",
      link: "Where the money goes",
    },
  ];
}

/* ---------- DOM ---------- */

export interface WallStoryDeps {
  scope: WallScope;
  /** The invite card's meter, happy-hour and earn lines. */
  invite: HTMLElement;
  holders: HTMLElement;
  /** The "Right now" card: latest strokes, each a button that shows it on the wall. */
  recent: HTMLElement;
  rules: HTMLElement;
  /** The paint footer's earnings line, under the stroke total. */
  strokeEarn: HTMLElement;
  pixels(): readonly PixelView[];
  stats(): WallStats | null;
  viewer(): string | null;
  /** The board's raw tunables (repaint and happy-hour fields), or null. */
  tunables(): unknown;
  /** One painter's Turf colour, so this list matches the Turf view. */
  colorOf(account: string, you: boolean): string;
  readEmission(): Promise<unknown>;
  /** Move the wall to a tile (the `#tile-x-y` path: select, zoom, show). */
  flyTo(cell: { x: number; y: number }): void;
  now?: () => number;
}

export interface WallStory {
  render(): void;
  /** The paint footer's latest quote: credit-paid tiles in the stroke, or null. */
  onQuote(paidCells: number | null): void;
}

export function createWallStory(deps: WallStoryDeps): WallStory {
  const { scope, invite, holders, rules } = deps;
  const now = deps.now ?? Date.now;
  const meter = invite.querySelector<HTMLElement>("[data-wall-meter]");
  const meterFill = invite.querySelector<HTMLElement>("[data-wall-meter] i");
  const meterLabel = invite.querySelector<HTMLElement>("[data-wall-meter-label]");
  const happy = invite.querySelector<HTMLElement>("[data-wall-happy]");
  const earn = invite.querySelector<HTMLElement>("[data-wall-earn]");
  const holderList = holders.querySelector<HTMLElement>("[data-wall-holders]");
  const holderNote = holders.querySelector<HTMLElement>("[data-wall-holders-note]");

  const recentList = deps.recent.querySelector<HTMLElement>("[data-wall-recent]");
  const { strokeEarn } = deps;
  let perTileDay: bigint | null = null;
  let paidInStroke: number | null = null;
  let lastDrawn: string | null = null;

  function renderStrokeEarn(): void {
    const line = paidInStroke === null ? null : strokeEarnLine(paidInStroke, perTileDay);
    strokeEarn.textContent = line ?? "";
    strokeEarn.hidden = line === null;
  }

  // The earning rate changes rarely: one read per visit is enough.
  void deps.readEmission().then(
    (raw) => {
      if (scope.isDisposed()) return;
      perTileDay = perTileDayFrom(raw);
      render();
      renderStrokeEarn();
    },
    () => undefined,
  );

  function setLine(node: HTMLElement | null, text: string | null): void {
    if (!node) return;
    node.textContent = text ?? "";
    node.hidden = text === null;
  }

  function render(): void {
    if (scope.isDisposed()) return;
    const stats = deps.stats();
    const raw = deps.tunables();
    const schedule = raw && typeof raw === "object" ? parseHappyHour(raw as Record<string, unknown>) : null;
    const tunables = (raw ?? null) as ViewTunables | null;
    const rows = holderRows(deps.pixels(), deps.viewer());
    const model = {
      painted: stats?.painted ?? null,
      happy: happyHourLine(schedule, stats, now()),
      earn: earnLine(perTileDay),
      rows,
      recent: recentStrokes(deps.pixels()).map((r) => ({ ...r, atNs: r.atNs.toString() })),
      // Minutes, so "3 min ago" moves on without a board change.
      minute: Math.floor(now() / 60_000),
      rules: ruleCards(tunables),
    };
    const drawn = JSON.stringify(model);
    if (drawn === lastDrawn) return;
    lastDrawn = drawn;

    if (meter && meterFill && meterLabel) {
      const total = wallTiles();
      if (model.painted === null) {
        meter.hidden = true;
      } else {
        meter.hidden = false;
        const pct = total ? (model.painted / total) * 100 : 0;
        meterFill.style.width = `${Math.min(100, pct)}%`;
        meter.setAttribute("aria-label", `${count(model.painted)} of ${count(total)} tiles painted`);
        meterLabel.textContent = `${count(model.painted)} / ${count(total)} painted · ${pct < 1 && pct > 0 ? "<1" : Math.round(pct)}%`;
      }
    }
    setLine(happy, model.happy);
    if (earn) {
      const parts = earnParts(perTileDay);
      if (parts) {
        const strong = document.createElement("b");
        strong.textContent = parts[1];
        earn.replaceChildren(document.createTextNode(parts[0]), strong, document.createTextNode(parts[2]));
      } else {
        earn.replaceChildren();
      }
      earn.hidden = parts === null;
    }

    if (holderList) {
      holderList.replaceChildren(
        ...rows.map((row) => {
          const li = document.createElement("li");
          if (row.you) li.dataset.you = "true";
          const rank = document.createElement("span");
          rank.className = "wall-turf-rank";
          rank.textContent = `${row.rank}`;
          const sw = document.createElement("i");
          sw.style.background = deps.colorOf(row.account, row.you);
          sw.setAttribute("aria-hidden", "true");
          const name = document.createElement("span");
          name.className = "wall-turf-name";
          name.textContent = row.you ? `${row.account} (you)` : row.account;
          const tiles = document.createElement("span");
          tiles.className = "wall-turf-tiles";
          tiles.textContent = `${count(row.tiles)} tile${row.tiles === 1 ? "" : "s"}`;
          li.append(rank, sw, name, tiles);
          return li;
        }),
      );
    }
    holders.hidden = stats === null;
    if (holderNote) {
      holderNote.textContent = rows.length
        ? "Tiles held now. Paint over a tile and it’s yours."
        : "Nobody holds any wall yet. Be first.";
    }

    if (recentList) {
      const nowNsValue = BigInt(Math.floor(now())) * 1_000_000n;
      recentList.replaceChildren(
        ...model.recent.map((stroke) => {
          const li = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "wall-recent-item";
          button.title = `Show it on the wall (${stroke.cell.x}, ${stroke.cell.y})`;
          const sw = document.createElement("i");
          sw.style.background = deps.colorOf(stroke.artist, stroke.artist === deps.viewer());
          sw.setAttribute("aria-hidden", "true");
          const what = document.createElement("span");
          what.className = "wall-recent-what";
          const who = document.createElement("b");
          who.textContent = stroke.artist === deps.viewer() ? "You" : stroke.artist;
          what.append(who, document.createTextNode(` painted ${count(stroke.tiles)} tile${stroke.tiles === 1 ? "" : "s"}`));
          const when = document.createElement("time");
          const age = nowNsValue - BigInt(stroke.atNs);
          when.textContent = formatAgo(age < 0n ? 0n : age);
          button.append(sw, what, when);
          // Plain listener: the button is replaced on the next render and goes with it.
          button.addEventListener("click", () => deps.flyTo(stroke.cell));
          li.append(button);
          return li;
        }),
      );
    }
    deps.recent.hidden = stats === null || model.recent.length === 0;

    rules.replaceChildren(
      ...model.rules.map((card) => {
        const article = document.createElement("article");
        article.className = "wall-rule";
        article.dataset.rule = card.key;
        const h = document.createElement("h3");
        h.textContent = card.title;
        const p = document.createElement("p");
        p.textContent = card.body;
        const a = document.createElement("a");
        a.href = card.href;
        a.textContent = `${card.link} →`;
        article.append(h, p, a);
        return article;
      }),
    );
  }

  // Happy hour opens and closes on the clock, not on a board change.
  const timer = window.setInterval(() => {
    if (document.visibilityState !== "hidden") render();
  }, 30_000);
  scope.onDispose(() => window.clearInterval(timer));

  render();
  renderStrokeEarn();
  return {
    render,
    onQuote(paidCells) {
      paidInStroke = paidCells;
      renderStrokeEarn();
    },
  };
}
