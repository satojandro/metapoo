/**
 * /how-it-works: live reads and the arithmetic behind the page.
 *
 * Every live value is null until the board confirms it. The page hides a number
 * (or the sentence that needs it) rather than showing a default. The practice wall
 * and the sample-wall story are client-side only and never touch the wallet.
 */

import { wallTiles } from "@shared/types.ts";
import { isViewTunables, type ViewTunables } from "../pages/wall/wall-views";
import { MPOO_SPLIT, NEAR_SPLIT, type View } from "./revenue-panel";

/** Tiles on the wall at its current size (live: a paid board can grow). */
export { wallTiles };
const MINUTE_NS = 60_000_000_000n;

export interface HappyHourSchedule {
  enabled: boolean;
  /** 0 = Monday … 6 = Sunday, as the contract stores it. */
  weekday: number;
  /** Seconds after midnight UTC. */
  startS: number;
  lengthS: number;
  cap: number;
  requiresPurchase: boolean;
}

export interface HowItWorksSnapshot {
  /** yoctoNEAR per credit. */
  nearPerCredit: bigint | null;
  /** yoctoNEAR, paid once to open a credit account. */
  registrationFee: bigint | null;
  tiers: ViewTunables | null;
  freeFirstPerAccount: number | null;
  happyHour: HappyHourSchedule | null;
  firstFillComplete: boolean | null;
  /** Tiles that hold paint now. */
  painted: number | null;
}

export const EMPTY_SNAPSHOT: HowItWorksSnapshot = {
  nearPerCredit: null, registrationFee: null, tiers: null, freeFirstPerAccount: null,
  happyHour: null, firstFillComplete: null, painted: null,
};

function bigOrNull(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function intOrNull(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

export function parseHappyHour(t: Record<string, unknown>): HappyHourSchedule | null {
  const weekday = intOrNull(t.happy_hour_weekday, 6);
  const startS = intOrNull(t.happy_hour_start_s, 86_399);
  const lengthS = intOrNull(t.happy_hour_length_s, 86_400);
  const cap = intOrNull(t.happy_hour_cap_per_account);
  if (typeof t.happy_hour_enabled !== "boolean" || typeof t.happy_hour_requires_purchase !== "boolean"
    || weekday === null || startS === null || lengthS === null || lengthS === 0 || cap === null) return null;
  return { enabled: t.happy_hour_enabled, weekday, startS, lengthS, cap, requiresPurchase: t.happy_hour_requires_purchase };
}

/** Parse each read on its own: one failed view leaves only its own values unknown. */
export function parseSnapshot(reads: {
  paymentConfig?: unknown; tunables?: unknown; happyHour?: unknown; pixelsPage?: unknown;
}): HowItWorksSnapshot {
  const out: HowItWorksSnapshot = { ...EMPTY_SNAPSHOT };
  const pc = reads.paymentConfig as Record<string, unknown> | undefined;
  if (pc && typeof pc === "object") {
    out.nearPerCredit = bigOrNull(pc.near_per_credit);
    out.registrationFee = bigOrNull(pc.registration_fee);
  }
  const t = reads.tunables as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    out.tiers = isViewTunables(t) ? t : null;
    out.freeFirstPerAccount = intOrNull(t.free_first_paints_per_account, 10_000);
    out.happyHour = parseHappyHour(t);
  }
  const hh = reads.happyHour as Record<string, unknown> | undefined;
  if (hh && typeof hh === "object" && typeof hh.first_fill_complete === "boolean") {
    out.firstFillComplete = hh.first_fill_complete;
  }
  const page = reads.pixelsPage as Record<string, unknown> | undefined;
  if (page && typeof page === "object") out.painted = intOrNull(page.total, wallTiles());
  return out;
}

/** Read the board. Never throws: a failed view is simply absent. */
export async function loadHowItWorks(view: View, board: string): Promise<HowItWorksSnapshot> {
  const safe = (method: string, args?: Record<string, unknown>) => view(board, method, args).catch(() => undefined);
  const [paymentConfig, tunables, happyHour, pixelsPage] = await Promise.all([
    safe("get_payment_config"),
    safe("get_tunables"),
    safe("get_happy_hour", { account_id: null }),
    safe("get_pixels", { from_index: 0, limit: 1 }),
  ]);
  return parseSnapshot({ paymentConfig, tunables, happyHour, pixelsPage });
}

/* ——— Formatting ——— */

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function weekdayName(weekday: number): string { return WEEKDAYS[weekday] ?? ""; }

/** "0.0025" from yocto, trimmed, no rounding up. */
export function nearText(yocto: bigint, maxFraction = 6): string {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, "0").slice(0, maxFraction).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function minutesText(ns: number | string): string {
  const minutes = Number(BigInt(ns) / MINUTE_NS);
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "an hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function durationText(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "one hour" : `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function utcClock(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
}

/* ——— Happy hour ——— */

/**
 * Start (ms) of the window that is open now or comes next. Weekday 0 = Monday.
 * Wraps across the week end and handles a window still open from the previous week.
 */
export function nextHappyHourStart(nowMs: number, weekday: number, startS: number, lengthS: number): number {
  const now = new Date(nowMs);
  const monday0 = (now.getUTCDay() + 6) % 7;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const thisWeek = today + ((weekday - monday0) * 86_400 + startS) * 1000;
  const week = 7 * 86_400_000;
  for (const s of [thisWeek - week, thisWeek, thisWeek + week]) {
    if (s + lengthS * 1000 > nowMs) return s;
  }
  return thisWeek + week;
}

export function happyHourClock(nowMs: number, schedule: Pick<HappyHourSchedule, "weekday" | "startS" | "lengthS">):
  { open: boolean; startMs: number; label: string } {
  const startMs = nextHappyHourStart(nowMs, schedule.weekday, schedule.startS, schedule.lengthS);
  const open = nowMs >= startMs;
  const ms = open ? startMs + schedule.lengthS * 1000 - nowMs : startMs - nowMs;
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24;
  const m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const label = open
    ? `Open now · ${h ? `${h}h ` : ""}${pad(m)}:${pad(s)} left`
    : `${d ? `${d}d ` : ""}${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  return { open, startMs, label };
}

/* ——— The autonomous stall ——— */

/**
 * Where a week's NEAR ends up, before swap costs: the team's NEAR share, then the
 * buyback's mPOO split. With 10 / 90 and 10 / 70 / 20 that is 63 / 18 / 19.
 */
export function spendOutcome(near: number): { stakers: number; flushed: number; team: number } {
  const buyback = near * NEAR_SPLIT.buyback / 100;
  return {
    stakers: buyback * MPOO_SPLIT.stakers / 100,
    flushed: buyback * MPOO_SPLIT.burn / 100,
    team: near * NEAR_SPLIT.team / 100 + buyback * MPOO_SPLIT.team / 100,
  };
}

/* ——— The practice wall ——— */

export type PracticePhase = "filling" | "normal" | "happy";

export interface PracticePrices { young: number; mid: number; base: number; youngMin: number; midMin: number }

/** The board's tiers in minutes and credits, or the launch values for a clearly-labelled practice. */
export function practicePrices(tiers: ViewTunables | null): PracticePrices {
  if (!tiers) return { young: 4, mid: 2, base: 1, youngMin: 10, midMin: 60 };
  return {
    young: tiers.repaint_young_credits, mid: tiers.repaint_mid_credits, base: tiers.repaint_base_credits,
    youngMin: Number(BigInt(tiers.repaint_young_ns) / MINUTE_NS), midMin: Number(BigInt(tiers.repaint_mid_ns) / MINUTE_NS),
  };
}

export interface PracticeCell { color: number | null; at: number | null }

/** Credits to cover a cell painted `at` (sample minutes) at sample time `clock`. */
export function practiceTier(cell: PracticeCell, clock: number, p: PracticePrices): number {
  if (cell.at === null) return p.base;
  const age = clock - cell.at;
  return age < p.youngMin ? p.young : age < p.midMin ? p.mid : p.base;
}

export interface FreeBudget { first: number; happy: number }

/** One cell's price in a stroke, spending free paints from `budget` as the board would. */
export function practicePrice(cell: PracticeCell, clock: number, phase: PracticePhase, p: PracticePrices,
  budget: FreeBudget): number {
  const tier = practiceTier(cell, clock, p);
  // Free first paints: empty cells only. Happy hour: base-price cells (dry or empty).
  const dryOrBlank = cell.at === null || clock - cell.at >= p.midMin;
  if (phase === "filling" && cell.color === null && budget.first > 0) { budget.first -= 1; return 0; }
  if (phase === "happy" && dryOrBlank && budget.happy > 0) { budget.happy -= 1; return 0; }
  return tier;
}

export interface Receipt { cells: number; free: number; credits: number; budget: FreeBudget }

export function practiceReceipt(cells: PracticeCell[], clock: number, phase: PracticePhase, p: PracticePrices,
  start: FreeBudget): Receipt {
  const budget = { ...start };
  let credits = 0, free = 0;
  for (const cell of cells) {
    const price = practicePrice(cell, clock, phase, p, budget);
    credits += price;
    if (price === 0) free += 1;
  }
  return { cells: cells.length, free, credits, budget };
}
