/**
 * A curated still of the wall: the shape behind the Hall of Fame (`hall.json`,
 * spec §4.1) and the agent gallery (`agents-gallery.json`, spec §5.2), and the one
 * implementation of its validation. Each list keeps its stills in its own directory
 * under web/public, which is the only thing that differs between them here.
 */

import { buildHref } from "./routes";

export interface WallStill {
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

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_FILE = /^[a-z0-9][a-z0-9-]*\.png$/;

/**
 * Why an entry is not usable, or null when it is. `imageDir` is the directory under
 * web/public the still must be served from ("hall", "agents-gallery"): an image
 * anywhere else, or on another host, is refused.
 */
export function stillEntryProblem(value: unknown, imageDir: string): string | null {
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
  const prefix = `/${imageDir}/`;
  if (typeof e.image !== "string" || !e.image.startsWith(prefix) || !IMAGE_FILE.test(e.image.slice(prefix.length))) {
    return `image must be /${imageDir}/<slug>.png`;
  }
  return null;
}

/** Usable entries, newest first (by block, which is the true order of the wall), first id wins. */
export function parseStills<T extends WallStill>(value: unknown, problem: (item: unknown) => string | null): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: T[] = [];
  for (const item of value) {
    if (problem(item) !== null) continue;
    const entry = item as T;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries.sort((a, b) => b.block - a.block);
}

/** The existing wall deep link: `/wall?x=&y=&zoom=`. */
export function stillWallHref(entry: Pick<WallStill, "x" | "y" | "zoom">): string {
  return buildHref("/wall", { x: String(entry.x), y: String(entry.y), zoom: String(entry.zoom) });
}
