/**
 * /stake: reads, arithmetic and button rules for the TOILET staking contract
 * (contracts/toilet-staking). Pure or over an injected `view`, so it is testable
 * without a chain.
 *
 * Where to talk is never hard-coded: the board names the staking contract
 * (`get_revenue_state().staking_contract`), and the staking contract names its
 * TOILET and mPOO tokens (`get_config`). Amounts are integer strings in 1e-18
 * units, handled only as `bigint`.
 */

import { formatAmount, isMethodNotFound, loadRevenue, type View } from "./revenue-panel";

export const TOKEN_DECIMALS = 18;
const BPS = 10_000n;

/** `storage_deposit` on the staking contract or the mPOO token. */
export const STORAGE_GAS = "30000000000000";
/** `ft_transfer_call` on TOILET → staking `ft_on_transfer("stake")`. */
export const STAKE_GAS = "100000000000000";
/** The contract refuses `unstake` under 90 Tgas: two transfers and a callback. */
export const UNSTAKE_GAS = "100000000000000";
/** The contract refuses `claim_rewards` under 50 Tgas. */
export const CLAIM_REWARDS_GAS = "80000000000000";

export interface StakingConfig {
  toilet: string;
  mpoo: string;
  board: string;
  dripBps: number;
  exitTaxBps: number;
  /** yoctoNEAR, paid once to register a staker. */
  storageMin: bigint;
}

export interface StakingPool {
  /** mPOO waiting to be released. */
  pool: bigint;
  releasedTotal: bigint;
  totalStaked: bigint;
  burnedTotal: bigint;
}

export interface StakingAccount {
  /** TOILET in the wallet, ready to lock. */
  wallet: bigint;
  registered: boolean;
  staked: bigint;
  /** mPOO released to this staker and not yet claimed. */
  pendingRewards: bigint;
  /** The mPOO token must know the account before it can pay it. */
  mpooRegistered: boolean;
  /** yoctoNEAR the mPOO token asks to register an account; null when unread. */
  mpooStorageMin: bigint | null;
}

export type StakingSnapshot =
  | {
      kind: "live";
      staking: string;
      config: StakingConfig;
      pool: StakingPool;
      /** mPOO the board still holds for stakers; null when unread. */
      boardReserve: bigint | null;
      /** Null when signed out. */
      account: StakingAccount | null;
      accountFailed: boolean;
    }
  /** The board has no staking contract yet. */
  | { kind: "not-set" }
  /** The board names an account with no staking contract on it. */
  | { kind: "not-live"; staking: string };

const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;

function object(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  return raw as Record<string, unknown>;
}
function u128(r: Record<string, unknown>, key: string, where: string): bigint {
  const v = r[key];
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${where}: ${key} is not a U128 string`);
}
function account(r: Record<string, unknown>, key: string, where: string): string {
  const v = r[key];
  if (typeof v !== "string" || !ACCOUNT_ID.test(v)) throw new Error(`${where}: ${key} is not an account id`);
  return v;
}
function bps(r: Record<string, unknown>, key: string, where: string): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${where}: ${key} is not basis points`);
  return v;
}

export function parseConfig(raw: unknown): StakingConfig {
  const w = "get_config";
  const r = object(raw, w);
  return {
    toilet: account(r, "toilet", w),
    mpoo: account(r, "mpoo", w),
    board: account(r, "board", w),
    dripBps: bps(r, "drip_bps", w),
    exitTaxBps: bps(r, "exit_tax_bps", w),
    storageMin: u128(r, "storage_min", w),
  };
}

export function parsePool(raw: unknown): StakingPool {
  const w = "get_pool";
  const r = object(raw, w);
  return {
    pool: u128(r, "pool", w),
    releasedTotal: u128(r, "released_total", w),
    totalStaked: u128(r, "total_staked", w),
    burnedTotal: u128(r, "burned_total", w),
  };
}

export function parseStaker(raw: unknown): { registered: boolean; staked: bigint; pendingRewards: bigint } {
  const w = "get_staker";
  const r = object(raw, w);
  if (typeof r.registered !== "boolean") throw new Error(`${w}: registered is not a boolean`);
  return { registered: r.registered, staked: u128(r, "staked", w), pendingRewards: u128(r, "pending_rewards", w) };
}

function parseU128(raw: unknown, where: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`${where}: not a U128 string`);
  return BigInt(raw);
}

/** An account with no contract code answers like this, not with MethodNotFound. */
function isNoContract(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return isMethodNotFound(error) || /CodeDoesNotExist|CompilationError|AccountDoesNotExist|does not exist/i.test(text);
}

/**
 * Read everything /stake shows. The board and the staking contract must answer;
 * the board's reserve and the account reads may fail on their own.
 */
export async function loadStaking(view: View, board: string, accountId: string | null): Promise<StakingSnapshot> {
  const revenue = await loadRevenue(view, board);
  const staking = revenue.kind === "live" ? revenue.state.stakingContract : null;
  if (!staking) return { kind: "not-set" };
  let config: StakingConfig;
  try {
    config = parseConfig(await view(staking, "get_config"));
  } catch (error) {
    if (isNoContract(error)) return { kind: "not-live", staking };
    throw error;
  }
  const pool = parsePool(await view(staking, "get_pool"));
  // The reserve that feeds this pool sits on the board the staking contract names,
  // which may not be the board this page paints on.
  const feeder = config.board === board ? revenue : await loadRevenue(view, config.board).catch(() => null);
  const boardReserve = feeder?.kind === "live" ? feeder.state.mpooStakerReserve : null;
  if (!accountId) return { kind: "live", staking, config, pool, boardReserve, account: null, accountFailed: false };
  try {
    const [wallet, staker, mpooStorage, mpooBounds] = await Promise.all([
      view(config.toilet, "ft_balance_of", { account_id: accountId }).then((v) => parseU128(v, "ft_balance_of")),
      view(staking, "get_staker", { account_id: accountId }).then(parseStaker),
      view(config.mpoo, "storage_balance_of", { account_id: accountId }),
      view(config.mpoo, "storage_balance_bounds").catch(() => null),
    ]);
    const min = (mpooBounds as { min?: unknown } | null)?.min;
    return {
      kind: "live", staking, config, pool, boardReserve, accountFailed: false,
      account: {
        wallet, ...staker,
        mpooRegistered: mpooStorage !== null,
        mpooStorageMin: typeof min === "string" && /^\d+$/.test(min) ? BigInt(min) : null,
      },
    };
  } catch {
    return { kind: "live", staking, config, pool, boardReserve, account: null, accountFailed: true };
  }
}

/* ——— Arithmetic, mirroring contracts/toilet-staking/src/math.rs ——— */

/** `amount × bps / 10_000`, rounded down, as the contract does. */
export function bpsOf(amount: bigint, rate: number): bigint {
  const r = BigInt(rate);
  return (amount / BPS) * r + ((amount % BPS) * r) / BPS;
}

/** `(tax, net)` for an unstaked amount: the tax rounds down, `tax + net === amount`. */
export function exitTax(amount: bigint, rate: number): { tax: bigint; net: bigint } {
  const tax = bpsOf(amount, rate);
  return { tax, net: amount - tax };
}

/** Share of all staked TOILET in parts per million (1_000_000 = 100%). */
export function sharePpm(mine: bigint, total: bigint): number {
  if (total <= 0n || mine <= 0n) return 0;
  return Number((mine * 1_000_000n) / total);
}

/** "0.24%", "< 0.01%", "100%". */
export function shareText(ppm: number): string {
  if (ppm <= 0) return "0%";
  if (ppm < 100) return "< 0.01%";
  const pct = ppm / 10_000;
  return `${Number(pct.toFixed(pct >= 10 ? 1 : 2))}%`;
}

/** What one day of release would hand this share, at today's pool. Not a forecast. */
export function todaysCut(pool: bigint, dripBps: number, mine: bigint, total: bigint): bigint {
  if (total <= 0n || mine <= 0n) return 0n;
  return (bpsOf(pool, dripBps) * mine) / total;
}

/**
 * "12.5" → units. Null for anything that isn't a plain positive decimal with at most
 * `decimals` fraction digits. Never goes through floating point.
 */
export function parseAmount(text: string, decimals = TOKEN_DECIMALS): bigint | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return units > 0n ? units : null;
}

/** Units → "12.5", exact, for putting a balance back into an input. */
export function unitsToInput(units: bigint, decimals = TOKEN_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const frac = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${units / scale}.${frac}` : (units / scale).toString();
}

/* ——— Button rules ——— */

export interface ActionInput {
  accountId: string | null;
  walletNetwork: string | null;
  pageNetwork: string;
  busy: boolean;
  live: boolean;
}

export interface ActionState {
  enabled: boolean;
  label: string;
  hint: string;
}

function gate(input: ActionInput, label: string): ActionState | null {
  if (!input.live) return { enabled: false, label, hint: "Staking isn’t open on this board yet." };
  if (input.busy) return { enabled: false, label: "Waiting for wallet…", hint: "Confirm or cancel in your wallet." };
  if (!input.accountId) return { enabled: false, label, hint: "Connect a wallet to stake." };
  if (input.walletNetwork !== input.pageNetwork) {
    return { enabled: false, label, hint: `Switch your wallet to ${input.pageNetwork}.` };
  }
  return null;
}

/** "1,234.5678" — cut, never rounded up, so a label never shows more than is there. */
export const fmtToken = (units: bigint, maxFraction = 4) => formatAmount(units, TOKEN_DECIMALS, { maxFraction });
const fmt = (units: bigint) => fmtToken(units);

export function lockState(input: ActionInput & { amount: bigint | null; account: StakingAccount | null; storageMin: bigint }): ActionState {
  const blocked = gate(input, "Lock TOILET");
  if (blocked) return blocked;
  const a = input.account;
  if (!a) return { enabled: false, label: "Lock TOILET", hint: "Couldn’t read your balance. Try again in a moment." };
  if (a.wallet === 0n) return { enabled: false, label: "Lock TOILET", hint: "You have no TOILET yet. Tiles you paint with credits earn it." };
  if (input.amount === null) return { enabled: false, label: "Enter an amount", hint: "How much TOILET to lock." };
  if (input.amount > a.wallet) return { enabled: false, label: "Not enough TOILET", hint: "That’s more than your wallet holds." };
  const label = `Lock ${fmt(input.amount)} TOILET`;
  return a.registered
    ? { enabled: true, label, hint: "One approval in your wallet, plus a small network fee." }
    : { enabled: true, label, hint: "First time: your wallet signs two transactions. The first registers you with the staking contract and pays its storage, once." };
}

export function unlockState(input: ActionInput & { amount: bigint | null; account: StakingAccount | null; exitTaxBps: number }): ActionState {
  const blocked = gate(input, "Unlock TOILET");
  if (blocked) return blocked;
  const a = input.account;
  if (!a) return { enabled: false, label: "Unlock TOILET", hint: "Couldn’t read your stake. Try again in a moment." };
  if (a.staked === 0n) return { enabled: false, label: "Unlock TOILET", hint: "You have nothing locked." };
  if (input.amount === null) return { enabled: false, label: "Enter an amount", hint: "How much TOILET to unlock." };
  if (input.amount > a.staked) return { enabled: false, label: "More than you locked", hint: "That’s more than you have locked." };
  const { tax } = exitTax(input.amount, input.exitTaxBps);
  return {
    enabled: true,
    label: tax > 0n ? `Unlock and burn ${fmt(tax)} TOILET` : `Unlock ${fmt(input.amount)} TOILET`,
    hint: "One approval in your wallet, plus a small network fee. Your mPOO stays claimable.",
  };
}

export function claimRewardsState(input: ActionInput & { account: StakingAccount | null }): ActionState {
  const label = "Claim mPOO";
  const blocked = gate(input, label);
  if (blocked) return blocked;
  const a = input.account;
  if (!a) return { enabled: false, label, hint: "Couldn’t read your rewards. Try again in a moment." };
  if (a.pendingRewards === 0n) {
    return { enabled: false, label, hint: a.staked > 0n ? "Nothing released to you yet. The pool pays out a little every moment." : "Lock TOILET to start receiving mPOO." };
  }
  if (!a.mpooRegistered && a.mpooStorageMin === null) {
    return { enabled: false, label, hint: "Couldn’t read what the mPOO token charges to register you. Try again in a moment." };
  }
  return a.mpooRegistered
    ? { enabled: true, label, hint: "One approval in your wallet, plus a small network fee." }
    : { enabled: true, label, hint: "First claim: your wallet signs two transactions. The first registers you with the mPOO token so it can pay you." };
}

/** The contract's own refusals, in words. */
export function explainFailure(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/NotRegistered|AccountNotRegistered/.test(text)) return "You’re not registered with the staking contract yet.";
  if (/InsufficientStake/.test(text)) return "That’s more than you have locked.";
  if (/NothingToClaim/.test(text)) return "Nothing was waiting to claim.";
  if (/InsufficientGas/.test(text)) return "The wallet attached too little gas.";
  return null;
}

/** True when the receipts carry one of the named contract events (e.g. a refused payout). */
export function hasEvent(outcome: unknown, names: readonly string[], depth = 0): boolean {
  if (depth > 8 || outcome === null || outcome === undefined) return false;
  if (typeof outcome === "string") {
    if (!outcome.startsWith("EVENT_JSON:")) return false;
    try {
      return names.includes(String((JSON.parse(outcome.slice(11)) as { event?: unknown }).event));
    } catch {
      return false;
    }
  }
  if (typeof outcome !== "object") return false;
  return Object.values(outcome as Record<string, unknown>).some((v) => hasEvent(v, names, depth + 1));
}

/** A stake the contract refused is refunded; its log says so. */
export function stakeRefused(outcome: unknown, depth = 0): boolean {
  if (depth > 8 || outcome === null || outcome === undefined) return false;
  if (typeof outcome === "string") return outcome.startsWith("stake_refused") || outcome.startsWith("transfer_refused");
  if (typeof outcome !== "object") return false;
  return Object.values(outcome as Record<string, unknown>).some((v) => stakeRefused(v, depth + 1));
}
