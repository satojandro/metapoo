import { readRpcFetch } from "../read-rpc";
/**
 * "Where the money goes": reads, formatting and button rules for the revenue page.
 *
 * Spec: docs/payments/2026-11-01-paid-board-revision-spec.md §R1, §R2, "Automation".
 * Everything here is pure or takes an injected `view`, so it is testable without a chain.
 *
 * Amounts are integer strings in the token's smallest unit (yocto for NEAR, 1e-18 for mPOO).
 * They are only ever handled as `bigint`; no floating point touches a balance.
 */

/** NEAR has 24 decimals. */
export const NEAR_DECIMALS = 24;
/** mPOO has 18 decimals (docs/payments/2026-10-28-paid-model-decisions.md, `ft_metadata`). */
export const MPOO_DECIMALS = 18;
/** The burn address: 64 zeros, an implicit account with no key. */
export const BURN_ACCOUNT = "0".repeat(64);

/** Prepaid gas for `distribute_near`: two transfers and their callbacks. */
export const DISTRIBUTE_NEAR_GAS = "50000000000000";
/** Prepaid gas for `distribute_mpoo`: three `ft_transfer`s and callbacks (~150 Tgas, REV-D). */
export const DISTRIBUTE_MPOO_GAS = "150000000000000";
/** NEAR's protocol minimum gas price, in yocto per gas unit. Unused gas is refunded. */
export const MIN_GAS_PRICE_YOCTO = 100_000_000n;

/** The split, in percent. Order matters only for display. */
export const NEAR_SPLIT = { team: 10, buyback: 90 } as const;
export const MPOO_SPLIT = { team: 10, stakers: 70, burn: 20 } as const;

export type DistributionKind = "near" | "mpoo";

export interface RevenueState {
  /** NEAR paid for credits and not yet split (yocto). */
  withdrawableNear: bigint;
  /** mPOO accepted by the board and not yet split. */
  mpooUndistributed: bigint;
  /** The stakers' 70%, held on the board until a staking contract is set. */
  mpooStakerReserve: bigint;
  /** Earliest block time (ns) for the next `distribute_near`; 0 means now. */
  nextNearDistributionNs: bigint;
  /** Earliest block time (ns) for the next `distribute_mpoo`; 0 means now. */
  nextMpooDistributionNs: bigint;
  teamAccount: string;
  buybackAccount: string;
  /** Null until the owner sets it (once). */
  stakingContract: string | null;
  burnAccount: string;
}

/**
 * The contract's field names, in one table. REV-D is not deployed yet: if a name
 * differs, change it here and nowhere else.
 */
export const REVENUE_FIELDS = {
  withdrawableNear: "withdrawable_near",
  mpooUndistributed: "mpoo_undistributed",
  mpooStakerReserve: "mpoo_staker_reserve",
  nextNearDistributionNs: "next_near_distribution_ns",
  nextMpooDistributionNs: "next_mpoo_distribution_ns",
  teamAccount: "team_account",
  buybackAccount: "buyback_account",
  stakingContract: "staking_contract",
  burnAccount: "burn_account",
} as const;

const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;

function readUnits(raw: Record<string, unknown>, key: string): bigint {
  const value = raw[key];
  // U128 / U64 arrive as JSON strings. Accept a safe integer number too, never a float.
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`get_revenue_state: ${key} is not an unsigned integer`);
}

function readAccount(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !ACCOUNT_ID.test(value)) {
    throw new Error(`get_revenue_state: ${key} is not an account id`);
  }
  return value;
}

/** The one place that turns the `get_revenue_state` JSON into page types. */
export function parseRevenueState(raw: unknown): RevenueState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("get_revenue_state: not an object");
  }
  const r = raw as Record<string, unknown>;
  const f = REVENUE_FIELDS;
  const staking = r[f.stakingContract];
  return {
    withdrawableNear: readUnits(r, f.withdrawableNear),
    mpooUndistributed: readUnits(r, f.mpooUndistributed),
    mpooStakerReserve: readUnits(r, f.mpooStakerReserve),
    nextNearDistributionNs: readUnits(r, f.nextNearDistributionNs),
    nextMpooDistributionNs: readUnits(r, f.nextMpooDistributionNs),
    teamAccount: readAccount(r, f.teamAccount),
    buybackAccount: readAccount(r, f.buybackAccount),
    stakingContract: staking === null || staking === undefined ? null : readAccount(r, f.stakingContract),
    burnAccount: r[f.burnAccount] === undefined ? BURN_ACCOUNT : readAccount(r, f.burnAccount),
  };
}

/** `get_payment_config().mpoo_token`, validated. */
export function parseMpooToken(raw: unknown): string {
  const token = raw && typeof raw === "object" ? (raw as Record<string, unknown>).mpoo_token : undefined;
  if (typeof token !== "string" || !ACCOUNT_ID.test(token)) {
    throw new Error("get_payment_config: mpoo_token is not an account id");
  }
  return token;
}

/** `ft_balance_of` returns a U128 string. */
export function parseFtBalance(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("ft_balance_of: not a U128 string");
  return BigInt(raw);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FormatOptions {
  /** Fraction digits to keep; the rest is cut off (rounded down). Default 4. */
  maxFraction?: number;
}

/**
 * Exact decimal rendering of an integer amount, with thousands separators.
 * Digits past `maxFraction` are truncated, never rounded up, so the page never
 * shows more than is there. A non-zero amount too small to show reads "< 0.0001".
 */
export function formatAmount(units: bigint | string, decimals: number, options: FormatOptions = {}): string {
  const value = typeof units === "bigint" ? units : BigInt(/^\d+$/.test(units) ? units : NaN);
  if (value < 0n) throw new Error("Negative amount");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error("Invalid decimals");
  const maxFraction = Math.min(options.maxFraction ?? 4, decimals);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fractionDigits = (value % scale).toString().padStart(decimals, "0");
  const kept = fractionDigits.slice(0, maxFraction).replace(/0+$/, "");
  if (whole === 0n && kept === "" && value > 0n) {
    return maxFraction === 0 ? "< 1" : `< 0.${"0".repeat(maxFraction - 1)}1`;
  }
  return kept ? `${group(whole.toString())}.${kept}` : group(whole.toString());
}

/** Full precision, for a tooltip or the accessible name. */
export function formatExact(units: bigint, decimals: number): string {
  return formatAmount(units, decimals, { maxFraction: decimals });
}

/** NEAR 10 / 90; integer division, dust to the buyback (spec R1). */
export function splitNear(amount: bigint): { team: bigint; buyback: bigint } {
  const team = (amount * BigInt(NEAR_SPLIT.team)) / 100n;
  return { team, buyback: amount - team };
}

/** mPOO 10 / 70 / 20; integer division, dust to the stakers' reserve (spec R2). */
export function splitMpoo(amount: bigint): { team: bigint; stakers: bigint; burn: bigint } {
  const team = (amount * BigInt(MPOO_SPLIT.team)) / 100n;
  const burn = (amount * BigInt(MPOO_SPLIT.burn)) / 100n;
  return { team, burn, stakers: amount - team - burn };
}

/** Worst-case gas cost of a call at the protocol minimum gas price, in yocto. */
export function maxGasCostYocto(gas: string): bigint {
  return BigInt(gas) * MIN_GAS_PRICE_YOCTO;
}

export interface Countdown {
  due: boolean;
  /** "now", "12 s", "41 min 07 s", "1 h 05 min", "2 d 3 h". */
  label: string;
}

const pad2 = (n: bigint): string => n.toString().padStart(2, "0");

/** Time left until `nextNs` (chain nanoseconds). "0", or any time in the past, is due. */
export function countdown(nextNs: bigint, nowMs: number): Countdown {
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  if (nextNs <= nowNs) return { due: true, label: "now" };
  // Round up to whole seconds so "0 s" never shows while it is not yet due.
  const seconds = (nextNs - nowNs + 999_999_999n) / 1_000_000_000n;
  const d = seconds / 86_400n;
  const h = (seconds % 86_400n) / 3_600n;
  const m = (seconds % 3_600n) / 60n;
  const s = seconds % 60n;
  if (d > 0n) return { due: false, label: `${d} d ${h} h` };
  if (h > 0n) return { due: false, label: `${h} h ${pad2(m)} min` };
  if (m > 0n) return { due: false, label: `${m} min ${pad2(s)} s` };
  return { due: false, label: `${s} s` };
}

export interface ButtonInput {
  due: boolean;
  /** Amount waiting for this split. Nothing waiting → nothing to send. */
  waiting: bigint;
  accountId: string | null;
  walletNetwork: string | null;
  pageNetwork: string;
  busy: boolean;
  /** Example numbers (no board configured): never sendable. */
  example: boolean;
}

export interface ButtonState {
  enabled: boolean;
  label: string;
  /** Why it is disabled, or what pressing it does. */
  hint: string;
  /** Signed out with something to send: the button says "Connect wallet" (UI review C1). */
  connect?: true;
}

/** Whether "Distribute now" can be pressed, and the sentence that says why not. */
export function distributeButtonState(input: ButtonInput): ButtonState {
  const label = "Distribute now";
  if (input.example) return { enabled: false, label, hint: "Example only: this preview is not connected to a board." };
  if (input.busy) return { enabled: false, label: "Waiting for wallet…", hint: "Confirm or cancel in your wallet." };
  if (!input.due) return { enabled: false, label, hint: "Not yet: the board allows one split per interval." };
  if (input.waiting === 0n) return { enabled: false, label, hint: "Nothing is waiting, so there is nothing to send." };
  if (!input.accountId) {
    return { enabled: true, label: "Connect wallet", hint: "Connect a wallet to send it. Any account can.", connect: true };
  }
  if (input.walletNetwork !== input.pageNetwork) {
    return { enabled: false, label, hint: `Switch your wallet to ${input.pageNetwork} to send it.` };
  }
  return { enabled: true, label, hint: "Your wallet signs; you attach no NEAR and pay only gas." };
}

/** Public explorer page for an account, or null where there is no public explorer. */
export function accountExplorerUrl(network: string, account: string): string | null {
  if (network === "testnet") return `https://testnet.nearblocks.io/address/${encodeURIComponent(account)}`;
  if (network === "mainnet") return `https://nearblocks.io/address/${encodeURIComponent(account)}`;
  return null;
}

/** An old board without `get_revenue_state` answers with MethodNotFound. */
export function isMethodNotFound(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /MethodNotFound|MethodResolveError|method .*not found/i.test(text);
}

/** The board's rejection inside the interval (someone else got there first). */
export function isDistributionTooSoon(text: string | null | undefined): boolean {
  return !!text && /DistributionTooSoon/i.test(text);
}

export type View = (account: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

export type RevenueSnapshot =
  | {
      kind: "live";
      state: RevenueState;
      mpooToken: string | null;
      /** mPOO held by the burn address; null when that read failed. */
      burned: bigint | null;
    }
  | { kind: "not-yet" };

/**
 * Read everything the page shows. An old board (no `get_revenue_state`) is
 * `not-yet`, not an error. A failed burn read leaves only that figure blank.
 */
export async function loadRevenue(view: View, contractId: string): Promise<RevenueSnapshot> {
  let raw: unknown;
  try {
    raw = await view(contractId, "get_revenue_state");
  } catch (error) {
    if (isMethodNotFound(error)) return { kind: "not-yet" };
    throw error;
  }
  const state = parseRevenueState(raw);
  let mpooToken: string | null = null;
  let burned: bigint | null = null;
  try {
    mpooToken = parseMpooToken(await view(contractId, "get_payment_config"));
    burned = parseFtBalance(await view(mpooToken, "ft_balance_of", { account_id: state.burnAccount }));
  } catch {
    burned = null;
  }
  return { kind: "live", state, mpooToken, burned };
}

/** A `View` over NEAR JSON-RPC that keeps the chain's own error text. */
export function createRpcView(rpcUrl: string, timeoutMs = 15_000): View {
  return async (account, method, args = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await readRpcFetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0", id: "revenue", method: "query",
          params: {
            request_type: "call_function", finality: "final", account_id: account,
            method_name: method, args_base64: btoa(JSON.stringify(args)),
          },
        }),
      }, 1);
      if (!response.ok) throw new Error(`RPC HTTP ${response.status} while calling ${method}`);
      const body = (await response.json()) as {
        result?: { result?: number[]; error?: string };
        error?: { message?: string; data?: unknown; cause?: { name?: string } };
      };
      if (body.error) {
        throw new Error([body.error.cause?.name, body.error.message, JSON.stringify(body.error.data ?? "")].join(" "));
      }
      if (body.result?.error) throw new Error(body.result.error);
      if (!Array.isArray(body.result?.result)) throw new Error(`Empty RPC result for ${method}`);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Labelled example for the mock preview. Never shown when a board is configured. */
export function exampleSnapshot(nowMs: number): RevenueSnapshot {
  const nowNs = BigInt(nowMs) * 1_000_000n;
  return {
    kind: "live",
    state: {
      withdrawableNear: 12_500_000_000_000_000_000_000_000n,
      mpooUndistributed: 48_250_000_000_000_000_000_000n,
      mpooStakerReserve: 310_400_000_000_000_000_000_000n,
      nextNearDistributionNs: 0n,
      nextMpooDistributionNs: nowNs + 41n * 60n * 1_000_000_000n + 7_000_000_000n,
      teamAccount: "team.example.testnet",
      buybackAccount: "buyback.example.testnet",
      stakingContract: null,
      burnAccount: BURN_ACCOUNT,
    },
    mpooToken: "mpoo.example.testnet",
    burned: 88_660_000_000_000_000_000_000n,
  };
}
