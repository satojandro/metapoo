/**
 * ADM-2: the console's status strip and "Needs attention" list, derived from one
 * snapshot. Pure: no DOM, no reads. A value the board didn't return reads as
 * unavailable, never as zero.
 */
import { cooldownUntil, units, type AdminSnapshot, type ChainValue } from "./admin-settings";
import { countdown, formatAmount, MPOO_DECIMALS, NEAR_DECIMALS } from "./revenue-panel";

export type Tone = "good" | "warn" | "bad" | "quiet";
export interface StatusItem { id: string; label: string; value: string; tone: Tone }
export interface AttentionItem { id: string; tone: "bad" | "warn" | "info"; text: string; field?: string }

export interface ConsoleInput {
  snapshot: AdminSnapshot;
  nowMs: number;
  /** NEAR on the buyback account, in yocto. `undefined` = not read yet, `null` = the read failed. */
  buybackYocto: bigint | null | undefined;
}

/** NEAR waiting on the buyback account worth flagging. */
export const BUYBACK_ATTENTION_YOCTO = 10n ** 24n;
/** A split that's this late, with something waiting, means the keeper may have stopped. */
export const DISTRIBUTION_OVERDUE_MS = 2 * 60 * 60 * 1000;

function int(value: ChainValue | undefined): bigint | null {
  try { return value === undefined ? null : units(value); } catch { return null; }
}
const near = (yocto: bigint): string => `${formatAmount(yocto, NEAR_DECIMALS)} NEAR`;
const mpoo = (atomic: bigint): string => `${formatAmount(atomic, MPOO_DECIMALS)} mPOO`;

function cooldown(last: ChainValue | undefined, length: ChainValue | undefined, nowMs: number): { value: string; ready: boolean } | null {
  if (length === undefined) return null;
  try {
    const clock = countdown(cooldownUntil(last, length), nowMs);
    return clock.due ? { value: "Can change now", ready: true } : { value: `In ${clock.label}`, ready: false };
  } catch { return null; }
}

function split(next: ChainValue | undefined, waiting: bigint | null, nowMs: number, unit: (n: bigint) => string): StatusItem["value"] {
  const nextNs = int(next);
  if (nextNs === null) return "Unavailable";
  const clock = countdown(nextNs, nowMs);
  const amount = waiting === null ? "" : ` · ${unit(waiting)} waiting`;
  return `${clock.due ? "Ready now" : `In ${clock.label}`}${amount}`;
}

export function statusItems({ snapshot, nowMs, buybackYocto }: ConsoleInput): StatusItem[] {
  const r = snapshot.records;
  const t = r.get_tunables;
  const hh = r.get_happy_hour;
  const sales = r.get_mpoo_sales_today;
  const rev = r.get_revenue_state;
  const items: StatusItem[] = [];

  items.push(t?.paused === true ? { id: "painting", label: "Painting and buying", value: "Paused", tone: "bad" }
    : t?.paused === false ? { id: "painting", label: "Painting and buying", value: "Live", tone: "good" }
    : { id: "painting", label: "Painting and buying", value: "Unavailable", tone: "quiet" });

  for (const [id, label, last, length] of [
    ["near-price", "NEAR price", t?.last_near_price_change_ns, t?.near_price_cooldown_ns],
    ["mpoo-price", "mPOO price", t?.last_mpoo_price_change_ns, t?.mpoo_price_cooldown_ns],
  ] as const) {
    const c = cooldown(last, length, nowMs);
    items.push({ id, label, value: c?.value ?? "Unavailable", tone: c ? (c.ready ? "good" : "quiet") : "quiet" });
  }

  let happy: StatusItem = { id: "happy-hour", label: "Happy hour", value: "Unavailable", tone: "quiet" };
  if (hh) {
    if (hh.open === true) happy = { ...happy, value: "Open now", tone: "good" };
    else if (hh.enabled === true) {
      const start = int(hh.window_start_ns);
      happy = { ...happy, value: start === null ? "On" : `Next ${new Date(Number(start / 1_000_000n)).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` };
    } else happy = { ...happy, value: hh.first_fill_complete === false ? "Off · wall still filling" : "Off" };
  }
  items.push(happy);

  const cap = int(sales?.cap), remaining = int(sales?.remaining);
  items.push(cap === null || remaining === null ? { id: "mpoo-cap", label: "mPOO sales today", value: "Unavailable", tone: "quiet" }
    : cap === 0n ? { id: "mpoo-cap", label: "mPOO sales today", value: "Closed (cap 0)", tone: "quiet" }
    : { id: "mpoo-cap", label: "mPOO sales today", value: `${remaining} of ${cap} credits left`, tone: remaining * 10n <= cap ? "warn" : "quiet" });

  items.push({ id: "near-split", label: "Next NEAR split", value: rev ? split(rev.next_near_distribution_ns, int(rev.withdrawable_near), nowMs, near) : "Unavailable", tone: "quiet" });
  items.push({ id: "mpoo-split", label: "Next mPOO split", value: rev ? split(rev.next_mpoo_distribution_ns, int(rev.mpoo_undistributed), nowMs, mpoo) : "Unavailable", tone: "quiet" });

  items.push({ id: "buyback", label: "NEAR on the buyback account",
    value: buybackYocto === undefined ? "Reading…" : buybackYocto === null ? "Unavailable" : near(buybackYocto),
    tone: typeof buybackYocto === "bigint" && buybackYocto >= BUYBACK_ATTENTION_YOCTO ? "warn" : "quiet" });
  return items;
}

const RANK = { bad: 0, warn: 1, info: 2 } as const;

/** Things the owner should look at, most urgent first. Empty when all is well. */
export function attentionItems({ snapshot, nowMs, buybackYocto }: ConsoleInput): AttentionItem[] {
  const r = snapshot.records;
  const t = r.get_tunables;
  const sales = r.get_mpoo_sales_today;
  const rev = r.get_revenue_state;
  const out: AttentionItem[] = [];
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;

  if (t?.paused === true) out.push({ id: "paused", tone: "bad", text: "Painting and buying are paused. Reading the wall and revenue splits continue.", field: "set_paused" });

  const failed = Object.keys(snapshot.errors).filter(key => key !== "get_owner");
  if (failed.length) out.push({ id: "reads", tone: "warn", text: `${failed.length} board read${failed.length === 1 ? "" : "s"} failed: ${failed.join(", ")}. Those values are hidden, not shown as zero.` });

  if (snapshot.ownerFromConfig) out.push({ id: "owner", tone: "info", text: `The board has no owner view yet, so the owner (${snapshot.owner}) comes from this app's configuration. The contract still checks it.` });

  const cap = int(sales?.cap), remaining = int(sales?.remaining);
  if (cap !== null && remaining !== null && cap > 0n && remaining * 10n <= cap) {
    out.push({ id: "mpoo-cap", tone: "warn", text: `mPOO sales are close to today's cap: ${remaining} of ${cap} credits left. The cap resets at midnight UTC.`, field: "mpoo_daily_credit_cap" });
  }

  if (typeof buybackYocto === "bigint" && buybackYocto >= BUYBACK_ATTENTION_YOCTO) {
    out.push({ id: "buyback", tone: "warn", text: `${near(buybackYocto)} is waiting on the buyback account to be swapped to mPOO and sent back.` });
  }

  const overdue = DISTRIBUTION_OVERDUE_MS * 1_000_000;
  for (const [id, label, next, waiting, unit] of [
    ["near-overdue", "NEAR", rev?.next_near_distribution_ns, int(rev?.withdrawable_near), near],
    ["mpoo-overdue", "mPOO", rev?.next_mpoo_distribution_ns, int(rev?.mpoo_undistributed), mpoo],
  ] as const) {
    const nextNs = int(next);
    if (nextNs === null || waiting === null || waiting === 0n || nextNs === 0n) continue;
    if (nowNs - nextNs > BigInt(overdue)) {
      out.push({ id, tone: "warn", text: `The ${label} split is overdue by ${countdown(nowNs, Number(nextNs / 1_000_000n)).label} with ${unit(waiting)} waiting. Is the keeper running?` });
    }
  }

  const reserve = int(rev?.mpoo_staker_reserve);
  if (rev && rev.staking_contract === null && reserve !== null && reserve > 0n) {
    out.push({ id: "staking", tone: "info", text: `${mpoo(reserve)} is locked for stakers until a staking contract is set (once, ever).`, field: "set_staking_contract" });
  }

  for (const [id, label, last, length, field] of [
    ["near-ready", "NEAR", t?.last_near_price_change_ns, t?.near_price_cooldown_ns, "set_near_price"],
    ["mpoo-ready", "mPOO", t?.last_mpoo_price_change_ns, t?.mpoo_price_cooldown_ns, "set_mpoo_price"],
  ] as const) {
    // Only after a change: a price that has never moved isn't news.
    if (last === null || last === undefined) continue;
    if (cooldown(last, length, nowMs)?.ready) out.push({ id, tone: "info", text: `The ${label} price can change again.`, field });
  }

  return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}
