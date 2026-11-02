/** ADM-2: how each setting is read from a snapshot, shown, and timed. Pure functions. */
import type { AdminSetting } from "./admin-catalog";
import { DAY_NS, EDITABLE_TUNABLES, cooldownUntil, units, type AdminSnapshot, type ChainRecord, type ChainValue } from "./admin-settings";
import { countdown, formatExact } from "./revenue-panel";

/** Owner methods the console can sign, besides `set_tunables`. */
export const OWNER_METHODS = ["set_paused", "set_near_price", "set_mpoo_price", "set_team_account", "set_buyback_account", "set_staking_contract"] as const;
export type OwnerMethod = (typeof OWNER_METHODS)[number];

export const fieldOf = (item: AdminSetting): string => item.field.startsWith("set_") ? item.field.split("(")[0] : item.field;

export function decimals(field: string): number | null {
  if (field === "reserve_floor" || field === "set_near_price") return 24;
  if (field === "set_mpoo_price") return 18;
  if (field.endsWith("_ns")) return 9;
  return null;
}

export function editUnit(field: string): string {
  const places = decimals(field);
  if (places === 24) return "NEAR";
  if (places === 18) return "mPOO";
  if (places === 9) return "seconds";
  if (field === "happy_hour_start_s") return "seconds after midnight UTC";
  if (field === "happy_hour_weekday") return "Monday 0 – Sunday 6";
  return "whole number";
}

export const isAccountField = (field: string): boolean => field.includes("account") || field === "set_staking_contract";

export function plainAmount(value: ChainValue, places: number): string {
  return formatExact(units(value), places).replaceAll(",", "");
}

export function duration(value: ChainValue): string {
  const seconds = units(value) / 1_000_000_000n;
  const h = seconds / 3600n, m = seconds % 3600n / 60n, s = seconds % 60n;
  return [h ? `${h} h` : "", m ? `${m} min` : "", s || (!h && !m) ? `${s} s` : ""].filter(Boolean).join(" ");
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** How a live value reads in the console. `undefined` = the read failed. */
export function display(field: string, value: ChainValue | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value === null) return "Not set";
  if (field === "first_fill_complete") return value ? "Full" : "Still filling";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field === "reserve_floor" || field === "set_near_price" || field === "registration_fee") return `${plainAmount(value, 24)} NEAR`;
  if (field === "set_mpoo_price") return `${plainAmount(value, 18)} mPOO`;
  if (field === "toilet_per_cell_second") return `${plainAmount(value, 18)} TOILET / tile / s`;
  if (field === "happy_hour_length_s") return duration(units(value) * 1_000_000_000n);
  if (field.endsWith("_ns")) return duration(value);
  if (field === "happy_hour_weekday") return WEEKDAYS[Number(value)] ?? "Unavailable";
  if (field === "happy_hour_start_s") {
    const n = Number(value);
    return `${String(Math.floor(n / 3600)).padStart(2, "0")}:${String(Math.floor(n % 3600 / 60)).padStart(2, "0")} UTC`;
  }
  if (field === "max_outstanding_credits" && units(value) === 0n) return "No limit";
  return String(value);
}

/** Where each field's live value comes from. */
export function valueFor(snapshot: AdminSnapshot | null, field: string): ChainValue | undefined {
  const r = snapshot?.records;
  if (!r) return undefined;
  const t = r.get_tunables;
  switch (field) {
    case "set_paused": return t?.paused;
    case "set_toilet_paused": return undefined;
    case "set_near_price": return r.get_payment_config?.near_per_credit;
    case "set_mpoo_price": return r.get_payment_config?.mpoo_per_credit;
    case "set_team_account": return r.get_revenue_state?.team_account;
    case "set_buyback_account": return r.get_revenue_state?.buyback_account;
    case "set_staking_contract": return r.get_revenue_state?.staking_contract;
    case "first_fill_complete": return r.get_happy_hour?.first_fill_complete;
    default: return t?.[field];
  }
}

export interface Timing { label: string; ready: boolean | null }

/** When a field can next change. `ready: null` = the contract checks it, the views don't say. */
export function timing(tunables: ChainRecord | undefined, field: string, nowMs: number, staking: ChainValue | undefined): Timing {
  if (!tunables) return { label: "Unavailable", ready: null };
  let until = 0n;
  if (field === "set_near_price" || /^repaint_.*_credits$/.test(field)) until = cooldownUntil(tunables.last_near_price_change_ns, tunables.near_price_cooldown_ns);
  else if (field === "set_mpoo_price") until = cooldownUntil(tunables.last_mpoo_price_change_ns, tunables.mpoo_price_cooldown_ns);
  else if (field.startsWith("happy_hour_") && field !== "happy_hour_requires_purchase") until = cooldownUntil(tunables.last_happy_hour_change_ns, DAY_NS);
  else if (field === "set_team_account" || field === "set_buyback_account") return { label: "7-day wait, checked by the contract", ready: null };
  else if (field === "set_staking_contract") return staking ? { label: "Set · fixed", ready: false } : { label: "Once only", ready: true };
  const clock = countdown(until, nowMs);
  return clock.due ? { label: "Can change now", ready: true } : { label: `In ${clock.label}`, ready: false };
}

/** Fields the owner may edit from the console at all (the contract still decides). */
export function isEditable(field: string): boolean {
  return EDITABLE_TUNABLES.has(field) || (OWNER_METHODS as readonly string[]).includes(field);
}
