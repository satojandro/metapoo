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
import { topPainters, type ViewTunables } from "./wall-views";

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

/** The earning sentence in three parts, so the amount can be set in bold. */
export function earnParts(perTileDay: bigint | null): [string, string, string] | null {
  if (perTileDay === null) return null;
  return ["Every tile you hold earns ", `${formatToilet(perTileDay)} TOILET a day`, " until someone paints over it."];
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

export interface HolderRow {
  account: string;
  tiles: number;
  rank: number;
  you: boolean;
  /** Null while the earning rate is unknown. */
  perDay: string | null;
}

export function holderRows(
  pixels: readonly PixelView[],
  viewer: string | null,
  perTileDay: bigint | null,
  limit = 5,
): HolderRow[] {
  return topPainters(pixels, viewer, limit).map((row) => ({
    ...row,
    perDay: perTileDay === null ? null : formatToilet(perTileDay * BigInt(row.tiles)),
  }));
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
  rules: HTMLElement;
  pixels(): readonly PixelView[];
  stats(): WallStats | null;
  viewer(): string | null;
  /** The board's raw tunables (repaint and happy-hour fields), or null. */
  tunables(): unknown;
  /** One painter's Turf colour, so this list matches the Turf view. */
  colorOf(account: string, you: boolean): string;
  readEmission(): Promise<unknown>;
  now?: () => number;
}

export interface WallStory {
  render(): void;
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

  let perTileDay: bigint | null = null;
  let lastDrawn: string | null = null;

  // The earning rate changes rarely: one read per visit is enough.
  void deps.readEmission().then(
    (raw) => {
      if (scope.isDisposed()) return;
      perTileDay = perTileDayFrom(raw);
      render();
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
    const rows = holderRows(deps.pixels(), deps.viewer(), perTileDay);
    const model = {
      painted: stats?.painted ?? null,
      happy: happyHourLine(schedule, stats, now()),
      earn: earnLine(perTileDay),
      rows,
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
          if (row.perDay !== null) {
            const day = document.createElement("span");
            day.className = "wall-holder-day";
            day.textContent = `${row.perDay}/day`;
            day.title = `${row.perDay} TOILET a day at today’s rate`;
            li.append(day);
          }
          return li;
        }),
      );
    }
    holders.hidden = stats === null;
    if (holderNote) {
      holderNote.textContent = rows.length
        ? perTileDay !== null
          ? "TOILET a day at today’s rate. Paint over a tile and its earnings are yours."
          : "Tiles held now. Paint over a tile and it’s yours."
        : "Nobody holds any wall yet. Be first.";
    }

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
  return { render };
}
