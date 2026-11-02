/**
 * ADM-2: what the console signs, and the checks before it. Every change except the
 * emergency pause re-reads the owner and the record it changes, and stops if either
 * moved since the editor opened (ADM-1's guards, unchanged).
 */
import type { AdminSetting } from "./admin-catalog";
import { isAccountField, type OwnerMethod } from "./admin-format";
import {
  ACCOUNT_ID, EDITABLE_TUNABLES, changedFields, prepareTunableChange, priceChange, record, units, validateTunables,
  type AdminSnapshot, type ChainRecord, type ChainValue,
} from "./admin-settings";
import { stringifyChainJson } from "../chain-json";
import { isMethodNotFound, type View } from "./revenue-panel";

export type AdminMethod = "set_tunables" | OwnerMethod;

export interface Draft {
  item: AdminSetting;
  field: string;
  /** The tunables record the editor opened on. */
  baseline: ChainRecord;
  value: ChainValue;
  original: ChainValue;
}

export interface Change { methodName: AdminMethod; args: Record<string, unknown> }

/** Client-side check before preview. The contract stays the final authority. */
export function validateDraft(d: Draft, tunables: ChainRecord, snapshot: AdminSnapshot, nowMs: number, board: string): void {
  if (EDITABLE_TUNABLES.has(d.field)) {
    const value = typeof tunables[d.field] === "boolean" ? d.value : typeof tunables[d.field] === "string" ? String(d.value) : units(d.value);
    validateTunables({ ...tunables, [d.field]: value }, tunables, units(snapshot.records.get_outstanding_credits?.value), nowMs);
  } else if (d.field === "set_near_price" || d.field === "set_mpoo_price") {
    const asset = d.field === "set_near_price" ? "near" : "mpoo";
    priceChange(asset, String(snapshot.records.get_payment_config?.[`${asset}_per_credit`]), String(d.value), tunables, nowMs);
  } else if (isAccountField(d.field)) {
    if (typeof d.value !== "string" || !ACCOUNT_ID.test(d.value) || d.value === board) throw new Error("InvalidRevenueAccount");
    if (d.field === "set_staking_contract" && snapshot.records.get_revenue_state?.staking_contract) throw new Error("StakingContractAlreadySet");
  } else if (d.field !== "set_paused") {
    throw new Error("ReadOnly");
  }
}

/**
 * Re-read before signing: the owner, then the record being changed. Throws with the
 * reason when anything moved; returns exactly what to sign otherwise.
 */
export async function prepareChange(view: View, board: string, d: Draft, snapshot: AdminSnapshot, nowMs: number): Promise<Change> {
  const expectedOwner = snapshot.owner;
  if (!expectedOwner) throw new Error("OwnerUnknown");
  let currentOwner: unknown;
  try { currentOwner = await view(board, "get_owner"); }
  catch (error) { if (!isMethodNotFound(error) || !snapshot.ownerFromConfig) throw error; currentOwner = expectedOwner; }
  if (currentOwner !== expectedOwner) throw new Error("OwnerChanged: reload the board settings");

  if (EDITABLE_TUNABLES.has(d.field)) {
    const outstanding = units(await view(board, "get_outstanding_credits"));
    const args = await prepareTunableChange(view, board, d.baseline, d.field,
      typeof d.value === "boolean" ? d.value : String(d.value), outstanding, nowMs);
    return { methodName: "set_tunables", args };
  }
  const fresh = record(await view(board, "get_tunables"));
  if (changedFields(d.baseline, fresh).length) throw new Error("SettingsChanged: reload and review your edit");
  if (d.field === "set_paused") return { methodName: "set_paused", args: { paused: d.value } };
  if (d.field === "set_near_price" || d.field === "set_mpoo_price") {
    const config = record(await view(board, "get_payment_config"));
    const asset = d.field === "set_near_price" ? "near" : "mpoo";
    if (stringifyChainJson(config[`${asset}_per_credit`]) !== stringifyChainJson(d.original)) throw new Error("PriceChanged: reload and review your edit");
    return { methodName: d.field, args: priceChange(asset, String(config[`${asset}_per_credit`]), String(d.value), fresh, nowMs) };
  }
  if (isAccountField(d.field)) {
    const revenue = record(await view(board, "get_revenue_state"));
    const key = d.field.replace("set_", "");
    if (stringifyChainJson(revenue[key] ?? null) !== stringifyChainJson(d.original)) throw new Error("RevenueAccountChanged: reload and review your edit");
    validateDraft(d, fresh, { ...snapshot, records: { ...snapshot.records, get_revenue_state: revenue } }, nowMs, board);
    return { methodName: d.field as OwnerMethod, args: { account_id: d.value } };
  }
  throw new Error("ReadOnly");
}

/**
 * The emergency stop. No reads at all: an RPC outage must never block it. The wallet
 * still checks the connected account is the owner on the page network, and the
 * contract checks it again.
 */
export const PAUSE_NOW: Change = { methodName: "set_paused", args: { paused: true } };
