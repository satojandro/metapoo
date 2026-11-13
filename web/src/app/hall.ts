/**
 * Hall of Fame data (return/growth spec §4.1).
 *
 * `hall.json` is curated by hand: `ops/hall/snapshot.mjs` writes the PNG into
 * `web/public/hall/` and prints the entry; a human fills in the title and the
 * painters and commits both. There is no admin UI.
 *
 * Owner, 11 Nov: the page becomes one real menu item once it has three entries —
 * no "SOON" placeholders. Until then /hall exists but nothing links to it.
 */

import raw from "./hall.json";
import { buildHref } from "./routes";

export interface HallEntry {
  /** Slug, unique. Also the PNG's file name. */
  id: string;
  title: string;
  /** YYYY-MM-DD, the day the still was taken. */
  date: string;
  /** Block height the still was read at. */
  block: number;
  painters: string[];
  /** Tile the "See it on the wall" link centres on. */
  x: number;
  y: number;
  zoom: number;
  /** Served path under web/public, e.g. "/hall/first-fill.png". */
  image: string;
}

/** Entries needed before /hall is linked from the menu. */
export const HALL_MENU_MIN = 3;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why an entry is not usable, or null when it is. */
export function hallEntryProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !SLUG.test(e.id)) return "id must be a lowercase slug";
  if (typeof e.title !== "string" || e.title.trim() === "" || e.title === "TODO") return "title is missing";
  if (typeof e.date !== "string" || !DATE.test(e.date) || Number.isNaN(Date.parse(e.date))) return "date must be YYYY-MM-DD";
  if (!Number.isSafeInteger(e.block) || (e.block as number) <= 0) return "block must be a positive integer";
  if (!Array.isArray(e.painters) || e.painters.length === 0) return "painters is empty";
  if (e.painters.some((p) => typeof p !== "string" || p.trim() === "" || p === "TODO")) return "a painter is missing";
  for (const key of ["x", "y"] as const) {
    if (!Number.isInteger(e[key]) || (e[key] as number) < 0 || (e[key] as number) >= 128) return `${key} must be a tile 0–127`;
  }
  if (!Number.isInteger(e.zoom) || (e.zoom as number) < 1) return "zoom must be a positive integer";
  if (typeof e.image !== "string" || !/^\/hall\/[a-z0-9][a-z0-9-]*\.png$/.test(e.image)) return "image must be /hall/<slug>.png";
  return null;
}

/** Usable entries, newest first (by block, which is the true order of the wall). */
export function parseHall(value: unknown): HallEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: HallEntry[] = [];
  for (const item of value) {
    if (hallEntryProblem(item) !== null) continue;
    const entry = item as HallEntry;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries.sort((a, b) => b.block - a.block);
}

export const HALL_ENTRIES: readonly HallEntry[] = parseHall(raw);

export function hallInMenu(entries: readonly HallEntry[] = HALL_ENTRIES): boolean {
  return entries.length >= HALL_MENU_MIN;
}

/** The existing wall deep link: `/wall?x=&y=&zoom=`. */
export function hallWallHref(entry: HallEntry): string {
  return buildHref("/wall", { x: String(entry.x), y: String(entry.y), zoom: String(entry.zoom) });
}

/** "11 Nov 2026" — the date the still was taken, in the site's day-month style. */
export function hallDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
