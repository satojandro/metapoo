/** ADM-1: chain reads and edit rules. Token amounts never pass through floating point. */
import { isMethodNotFound, type View } from "./revenue-panel";
import { parseChainJson, stringifyChainJson } from "../chain-json";
import { rpcHeaders } from "../config";

export type ChainValue = string | number | bigint | boolean | null;
export type ChainRecord = Record<string, ChainValue>;
export const DAY_NS = 86_400_000_000_000n;
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
export const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;

export function units(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error("InvalidInteger: enter a non-negative whole number");
}

export function decimalUnits(text: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Enter a plain decimal number");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Pool average is mPOO per 1 NEAR. Floor once, after the 20% discount. */
export function discountedMpooPrice(average: string, nearPrice: string): bigint {
  return decimalUnits(average, 18) * units(nearPrice) * 80n / (100n * 10n ** 24n);
}

export function cooldownUntil(last: ChainValue | undefined, duration: ChainValue): bigint {
  return last === null || last === undefined ? 0n : units(last) + units(duration);
}
function requireElapsed(last: ChainValue | undefined, duration: ChainValue, nowMs: number, code: string): void {
  if (cooldownUntil(last, duration) > BigInt(Math.floor(nowMs)) * 1_000_000n) throw new Error(code);
}
function assert(condition: boolean, code: string): void { if (!condition) throw new Error(code); }

/** Mirrors lib.rs/free_paint.rs. The contract remains the final authority. */
export function validateTunables(next: ChainRecord, old: ChainRecord, outstanding: bigint, nowMs: number): void {
  const n = (key: string) => units(next[key]);
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "boolean" || value === null) continue;
    const max = ["reserve_floor", "max_outstanding_credits", "mpoo_daily_credit_cap", "toilet_per_cell_second"].includes(key)
      ? U128_MAX : key.endsWith("_ns") ? U64_MAX : 4_294_967_295n;
    assert(units(value) <= max, `IntegerOutOfRange: ${key}`);
  }
  assert(n("free_first_paints_per_account") <= 100n, "FreeFirstPaintsOutOfRange");
  assert(n("happy_hour_length_s") >= 900n && n("happy_hour_length_s") <= 86400n, "HappyHourLengthOutOfRange");
  assert(n("happy_hour_cap_per_account") >= 1n && n("happy_hour_cap_per_account") <= 1000n, "HappyHourCapOutOfRange");
  assert(n("happy_hour_weekday") <= 6n, "HappyHourWeekdayOutOfRange");
  assert(n("happy_hour_start_s") < 86400n, "HappyHourStartOutOfRange");
  assert(n("reserve_floor") >= 5n * 10n ** 24n, "ReserveFloorTooLow");
  assert(n("near_price_cooldown_ns") >= DAY_NS && n("mpoo_price_cooldown_ns") >= DAY_NS, "PriceCooldownTooShort");
  const prices = ["repaint_base_credits", "repaint_mid_credits", "repaint_young_credits"];
  assert(prices.every(key => n(key) >= 1n && n(key) <= 8n), "RepaintCreditsOutOfRange");
  assert(n(prices[0]) <= n(prices[1]) && n(prices[1]) <= n(prices[2]), "RepaintCreditsOutOfOrder");
  assert(n("repaint_young_ns") <= n("repaint_mid_ns"), "RepaintTiersOutOfOrder");
  assert(n("repaint_mid_ns") <= DAY_NS, "RepaintWindowTooLong");
  assert(n("mpoo_daily_credit_cap") <= 1_000_000n, "MpooDailyCapTooHigh");
  assert(n("max_outstanding_credits") === 0n || n("max_outstanding_credits") >= outstanding, "FloatCapBelowOutstanding");
  for (const key of ["last_near_price_change_ns", "last_mpoo_price_change_ns", "last_happy_hour_change_ns"]) {
    assert(stringifyChainJson(next[key]) === stringifyChainJson(old[key]), key.includes("happy") ? "HappyHourHistoryImmutable" : "PriceHistoryImmutable");
  }
  if (prices.some(key => n(key) !== units(old[key]))) {
    requireElapsed(old.last_near_price_change_ns, old.near_price_cooldown_ns, nowMs, "RepaintPriceCooldown");
  }
  const loosened = (next.happy_hour_enabled === true && (old.happy_hour_enabled !== true
    || n("happy_hour_weekday") !== units(old.happy_hour_weekday) || n("happy_hour_start_s") !== units(old.happy_hour_start_s)))
    || n("happy_hour_cap_per_account") > units(old.happy_hour_cap_per_account)
    || n("happy_hour_length_s") > units(old.happy_hour_length_s);
  if (loosened) requireElapsed(old.last_happy_hour_change_ns, DAY_NS, nowMs, "HappyHourCooldown");
}

export const EDITABLE_TUNABLES = new Set([
  "reserve_floor", "near_price_cooldown_ns", "mpoo_price_cooldown_ns",
  "repaint_young_ns", "repaint_mid_ns", "repaint_base_credits", "repaint_mid_credits", "repaint_young_credits",
  "max_outstanding_credits", "mpoo_daily_credit_cap", "free_first_paints_per_account", "happy_hour_enabled",
  "happy_hour_weekday", "happy_hour_start_s", "happy_hour_length_s", "happy_hour_cap_per_account",
  "happy_hour_requires_purchase", "distribution_interval_ns",
]);

export function record(raw: unknown): ChainRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("InvalidBoardResponse");
  return raw as ChainRecord;
}
export function changedFields(a: ChainRecord, b: ChainRecord): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key =>
    stringifyChainJson(a[key] ?? null) !== stringifyChainJson(b[key] ?? null));
}

/** Re-read at signing time. Spread the fresh record, including future fields. */
export async function prepareTunableChange(view: View, board: string, baseline: ChainRecord, field: string,
  value: string | boolean, outstanding: bigint, nowMs: number): Promise<{ tunables: ChainRecord }> {
  if (!EDITABLE_TUNABLES.has(field)) throw new Error("ReadOnly");
  const fresh = record(await view(board, "get_tunables"));
  const changes = changedFields(baseline, fresh);
  if (changes.length) throw new Error(`SettingsChanged: ${changes.join(", ")}. Reload and review your edit.`);
  let parsed: ChainValue;
  if (typeof baseline[field] === "boolean") {
    if (typeof value !== "boolean") throw new Error("InvalidBoolean");
    parsed = value;
  } else {
    const integer = units(value);
    parsed = typeof fresh[field] === "string" ? integer.toString()
      : integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
  }
  const next = { ...fresh, [field]: parsed };
  validateTunables(next, fresh, outstanding, nowMs);
  return { tunables: next };
}

export function priceChange(asset: "near" | "mpoo", current: string, next: string, t: ChainRecord, nowMs: number): ChainRecord {
  const old = units(current), value = units(next);
  assert(value > 0n, "ZeroPrice");
  assert(value <= U128_MAX, "IntegerOutOfRange");
  assert(value >= (old + 1n) / 2n && value <= old * 2n, "PriceStepTooLarge");
  requireElapsed(t[`last_${asset}_price_change_ns`], t[`${asset}_price_cooldown_ns`], nowMs, asset === "near" ? "NearPriceCooldown" : "MpooPriceCooldown");
  return { [`${asset}_per_credit`]: value.toString() };
}

export interface AdminSnapshot {
  owner: string | null;
  ownerFromConfig: boolean;
  records: Record<string, ChainRecord>;
  errors: Record<string, string>;
}
const METHODS = ["get_tunables", "get_payment_config", "get_mpoo_sales_today", "get_happy_hour",
  "get_free_first_paints", "get_revenue_state", "get_outstanding_credits", "get_withdrawable_near", "get_state_version", "get_board", "get_toilet_emission"];

export async function loadAdmin(view: View, board: string, configuredOwner = ""): Promise<AdminSnapshot> {
  const snapshot: AdminSnapshot = { owner: null, ownerFromConfig: false, records: {}, errors: {} };
  await Promise.all([...METHODS, "get_owner"].map(async method => {
    try {
      const args = method === "get_free_first_paints" ? { account_id: board } : {};
      const raw = await view(board, method, args);
      if (method === "get_owner") {
        if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) throw new Error("InvalidOwnerResponse");
        snapshot.owner = raw;
      } else snapshot.records[method] = raw !== null && typeof raw === "object" ? record(raw) : { value: raw as ChainValue };
    } catch (error) {
      snapshot.errors[method] = error instanceof Error ? error.message : String(error);
      if (method === "get_owner" && isMethodNotFound(error) && ACCOUNT_ID.test(configuredOwner)) {
        snapshot.owner = configuredOwner;
        snapshot.ownerFromConfig = true;
      }
    }
  }));
  return snapshot;
}

/** Same public RPC protocol as /money, with lossless parsing for unquoted u64 fields. */
export function createAdminView(url: string): View {
  return async (account, method, args = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal, headers: rpcHeaders(url),
        body: JSON.stringify({ jsonrpc: "2.0", id: "admin", method: "query", params: {
          request_type: "call_function", finality: "final", account_id: account, method_name: method,
          args_base64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args)))),
        } }),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
      if (!Array.isArray(body.result?.result)) throw new Error("InvalidRpcResult");
      return parseChainJson(new TextDecoder().decode(new Uint8Array(body.result.result)));
    } finally { clearTimeout(timer); }
  };
}

/** NEAR balance of an account, in yocto (RPC `view_account`). */
export function createAccountBalanceReader(url: string): (account: string) => Promise<bigint> {
  return async account => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal, headers: rpcHeaders(url),
        body: JSON.stringify({ jsonrpc: "2.0", id: "admin", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
      const amount = body.result?.amount;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("InvalidAccountView");
      return BigInt(amount);
    } finally { clearTimeout(timer); }
  };
}
