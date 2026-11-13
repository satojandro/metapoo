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
import { parseStills, stillEntryProblem, stillWallHref, type WallStill } from "./wall-still";

/** A Hall entry is exactly a wall still; the shape and its checks live in `wall-still.ts`. */
export type HallEntry = WallStill;

/** Entries needed before /hall is linked from the menu. */
export const HALL_MENU_MIN = 3;

/** Why an entry is not usable, or null when it is. */
export function hallEntryProblem(value: unknown): string | null {
  return stillEntryProblem(value, "hall");
}

/** Usable entries, newest first (by block, which is the true order of the wall). */
export function parseHall(value: unknown): HallEntry[] {
  return parseStills<HallEntry>(value, hallEntryProblem);
}

export const HALL_ENTRIES: readonly HallEntry[] = parseHall(raw);

export function hallInMenu(entries: readonly HallEntry[] = HALL_ENTRIES): boolean {
  return entries.length >= HALL_MENU_MIN;
}

/** The existing wall deep link: `/wall?x=&y=&zoom=`. */
export function hallWallHref(entry: HallEntry): string {
  return stillWallHref(entry);
}

/** "11 Nov 2026" — the date the still was taken, in the site's day-month style. */
export function hallDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
