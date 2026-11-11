/**
 * TOILET reads and claim-button rules for /stake and the wallet panel.
 *
 * Sources: `get_toilet_emission` and `get_pending_toilet` on the board,
 * `get_supply_info`, `is_paused` and `ft_balance_of` on the TOILET token.
 * Pure or over an injected `view`, so it is testable without a chain.
 *
 * Amounts are integer strings in 1e-18 units, handled only as `bigint`.
 */

import { wallTiles } from "@shared/types.ts";
import { isViewTunables, type ViewTunables } from "../pages/wall/wall-views";
import {
  formatAmount,
  isMethodNotFound,
  loadRevenue,
  MPOO_SPLIT,
  NEAR_SPLIT,
  type RevenueSnapshot,
  type View,
} from "./revenue-panel";

/** The hard cap, in whole TOILET. */
export const TOILET_CAP = 1_000_000_000;
/** Tiles on the wall. */
/** Tiles on the wall at its current size (live: a paid board can grow). */
export { wallTiles };
/** The staking pool pays out at most this share of itself per day (spec T5). */
export const DAILY_RELEASE = 0.1;
/** Unstaking burns this share of the amount taken out (spec T7). */
export const EXIT_TAX = 0.1;

/** TOILET has 18 decimals (`ft_metadata` on the token). */
export const TOILET_DECIMALS = 18;
/** `claim_toilet` forwards 10 Tgas to `mint` and 10 Tgas to its callback. */
export const CLAIM_TOILET_GAS = "50000000000000";

export interface ToiletEmission {
  /** TOILET (1e-18 units) each held cell earns per second. 0 = emission off. */
  perCellSecond: bigint;
  /** Earned by everyone so far, claimed or not. Reserved against the cap. */
  accruedTotal: bigint;
  cap: bigint;
  remaining: bigint;
}

export interface ToiletSupply {
  totalSupply: bigint;
  issuedTotal: bigint;
  burnedTotal: bigint;
}

export interface ToiletAccount {
  /** In the wallet now. */
  balance: bigint;
  /** Earned from painted cells, waiting for `claim_toilet`. */
  pending: bigint;
}

export type ToiletSnapshot =
  | {
      kind: "live";
      emission: ToiletEmission;
      /** Null when the token read failed; the board figures still show. */
      supply: ToiletSupply | null;
      paused: boolean | null;
      /** Null when signed out, or when the account reads failed. */
      account: ToiletAccount | null;
      accountFailed: boolean;
    }
  /** A board deployed before emission existed. Normal, not an error. */
  | { kind: "not-yet" };

function units(raw: Record<string, unknown>, key: string, where: string): bigint {
  const value = raw[key];
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${where}: ${key} is not a U128 string`);
}

function object(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  return raw as Record<string, unknown>;
}

export function parseEmission(raw: unknown): ToiletEmission {
  const r = object(raw, "get_toilet_emission");
  const w = "get_toilet_emission";
  return {
    perCellSecond: units(r, "per_cell_second", w),
    accruedTotal: units(r, "accrued_total", w),
    cap: units(r, "cap", w),
    remaining: units(r, "remaining", w),
  };
}

export function parseSupply(raw: unknown): ToiletSupply {
  const r = object(raw, "get_supply_info");
  const w = "get_supply_info";
  return {
    totalSupply: units(r, "total_supply", w),
    issuedTotal: units(r, "issued_total", w),
    burnedTotal: units(r, "burned_total", w),
  };
}

export function parseU128(raw: unknown, where: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`${where}: not a U128 string`);
  return BigInt(raw);
}

/** TOILET one cell earns in a day at the current rate. */
export function perCellDay(emission: ToiletEmission): bigint {
  return emission.perCellSecond * 86_400n;
}

/**
 * Read everything /stake shows about TOILET. Board emission is required; the token
 * and account reads may fail on their own without blanking the rest.
 */
export async function loadToilet(
  view: View,
  board: string,
  toilet: string,
  account: string | null,
): Promise<ToiletSnapshot> {
  let raw: unknown;
  try {
    raw = await view(board, "get_toilet_emission");
  } catch (error) {
    if (isMethodNotFound(error)) return { kind: "not-yet" };
    throw error;
  }
  const emission = parseEmission(raw);
  const tokenRead = (async (): Promise<[ToiletSupply | null, boolean | null]> => {
    if (!toilet) return [null, null];
    const [supply, paused] = await Promise.allSettled([
      view(toilet, "get_supply_info").then(parseSupply),
      view(toilet, "is_paused"),
    ]);
    return [
      supply.status === "fulfilled" ? supply.value : null,
      paused.status === "fulfilled" && typeof paused.value === "boolean" ? paused.value : null,
    ];
  })();
  const accountRead = (async (): Promise<ToiletAccount | null> => {
    if (!account) return null;
    const pending = parseU128(await view(board, "get_pending_toilet", { account }), "get_pending_toilet");
    // An account the token has never seen has no balance yet: ft_balance_of answers "0".
    const balance = toilet
      ? parseU128(await view(toilet, "ft_balance_of", { account_id: account }), "ft_balance_of")
      : 0n;
    return { balance, pending };
  })();
  const [[supply, paused], accountResult] = await Promise.all([
    tokenRead,
    accountRead.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: null })),
  ]);
  return {
    kind: "live",
    emission,
    supply,
    paused,
    account: accountResult.value,
    accountFailed: !accountResult.ok,
  };
}

/** The board refuses a claim below this (§B5, `ClaimBelowMinimum`). */
export const MIN_CLAIM = 1_000_000_000_000_000_000n;

export interface ClaimInput {
  pending: bigint | null;
  accountId: string | null;
  walletNetwork: string | null;
  pageNetwork: string;
  toilet: string;
  paused: boolean | null;
  busy: boolean;
  example: boolean;
}

export interface ClaimState {
  enabled: boolean;
  label: string;
  hint: string;
  /**
   * Signed out: the action is not blocked by anything the player can fix in the
   * panel, so the button says "Connect wallet" and stays pressable (UI review C1).
   */
  connect?: true;
}

/** Whether "Claim TOILET" can be pressed, and the sentence that says why not. */
export function claimButtonState(input: ClaimInput): ClaimState {
  const label = "Claim TOILET";
  if (input.example) return { enabled: false, label, hint: "Example only: this preview is not connected to a board." };
  if (!input.toilet) return { enabled: false, label, hint: "This page doesn’t know the TOILET token address yet, so it can’t claim." };
  if (input.busy) return { enabled: false, label: "Waiting for wallet…", hint: "Confirm or cancel in your wallet." };
  if (!input.accountId) {
    return { enabled: true, label: "Connect wallet", hint: "Connect a wallet to see and claim what your tiles earned.", connect: true };
  }
  if (input.walletNetwork !== input.pageNetwork) {
    return { enabled: false, label, hint: `Switch your wallet to ${input.pageNetwork} to claim.` };
  }
  if (input.paused) return { enabled: false, label, hint: "TOILET is paused right now. Your earnings keep counting and wait for you." };
  if (input.pending === null) return { enabled: false, label, hint: "Couldn’t read your earnings. Try again in a moment." };
  if (input.pending === 0n) return { enabled: false, label, hint: "Nothing to claim yet. Tiles you paint with credits earn TOILET while you hold them." };
  // The board's own floor (B5). Below it the transaction panics `ClaimBelowMinimum`, so
  // the button says how much is left instead of inviting a failure.
  if (input.pending < MIN_CLAIM) {
    return {
      enabled: false,
      label,
      hint: `${formatAmount(input.pending, TOILET_DECIMALS, { maxFraction: 2 })} of 1.00 TOILET earned. Claim opens at 1.00 — your tiles keep earning either way.`,
    };
  }
  return { enabled: true, label, hint: "One approval in your wallet, plus a small network fee." };
}

/** True when the receipts carry the board's `claim_failed` event: the mint was refused. */
export function mintRefused(outcome: unknown, depth = 0): boolean {
  if (depth > 8 || outcome === null || outcome === undefined) return false;
  if (typeof outcome === "string") {
    if (!outcome.startsWith("EVENT_JSON:")) return false;
    try {
      return (JSON.parse(outcome.slice("EVENT_JSON:".length)) as { event?: unknown }).event === "claim_failed";
    } catch {
      return false;
    }
  }
  if (typeof outcome !== "object") return false;
  return Object.values(outcome as Record<string, unknown>).some((value) => mintRefused(value, depth + 1));
}

/* ——— /toilet live values ——— */

export interface ToiletPageSnapshot {
  emission: ToiletEmission | null;
  supply: ToiletSupply | null;
  /** mPOO held on the board for stakers; null when unread. */
  reserve: bigint | null;
  /** undefined = unread, null = not set yet. */
  stakingContract: string | null | undefined;
  /** yoctoNEAR per credit. */
  nearPerCredit: bigint | null;
  tiers: ViewTunables | null;
}

export const EMPTY_PAGE: ToiletPageSnapshot = {
  emission: null, supply: null, reserve: null, stakingContract: undefined, nearPerCredit: null, tiers: null,
};

/** Read everything /toilet shows. Never throws: a failed read leaves only its values unknown. */
export async function loadToiletPage(view: View, board: string, toilet: string): Promise<ToiletPageSnapshot> {
  const safe = <T>(p: Promise<T>) => p.catch(() => undefined);
  const [t, revenue, config, tunables] = await Promise.all([
    safe(loadToilet(view, board, toilet, null)),
    safe(loadRevenue(view, board)) as Promise<RevenueSnapshot | undefined>,
    safe(view(board, "get_payment_config")),
    safe(view(board, "get_tunables")),
  ]);
  const out: ToiletPageSnapshot = { ...EMPTY_PAGE };
  if (t?.kind === "live") {
    out.emission = t.emission;
    out.supply = t.supply;
  }
  if (revenue?.kind === "live") {
    out.reserve = revenue.state.mpooStakerReserve;
    out.stakingContract = revenue.state.stakingContract;
  }
  const near = (config as Record<string, unknown> | undefined)?.near_per_credit;
  if (typeof near === "string" && /^\d+$/.test(near) && BigInt(near) > 0n) out.nearPerCredit = BigInt(near);
  if (isViewTunables(tunables)) out.tiers = tunables;
  return out;
}

/* ——— Explorers: sample arithmetic, in whole tokens and NEAR ——— */

export type Tone = "good" | "warn" | "bad";

export interface EarnInput { years: number; held: number; hours: number; painted: number }
export interface EarnOutcome {
  you: number; perTileDay: number; wallDay: number; mintedPct: number; runYears: number; tone: Tone;
}

/** What tiles earn when the billion is minted over `years` on a full wall. */
export function earnOutcome({ years, held, hours, painted }: EarnInput): EarnOutcome {
  const perTileDay = TOILET_CAP / (years * 365 * wallTiles());
  const wallDay = perTileDay * painted;
  const mintedPct = (wallDay * 365 / TOILET_CAP) * 100;
  return {
    you: held * perTileDay * hours / 24,
    perTileDay,
    wallDay,
    mintedPct,
    runYears: TOILET_CAP / (wallDay * 365),
    tone: mintedPct > 50 ? "bad" : mintedPct > 15 ? "warn" : "good",
  };
}

/** The pace the board's own rate implies: years to mint the billion on a full wall. */
export function yearsAtRate(perCellSecond: bigint): number | null {
  if (perCellSecond <= 0n) return null;
  const perTileDay = Number(perCellSecond * 86_400n) / 1e18;
  return TOILET_CAP / (perTileDay * 365 * wallTiles());
}

export interface WhaleInput {
  whaleTiles: number; players: number; nearPerCredit: number; wetCredits: number; dryCredits: number;
}

/** A whale defending tiles while `players` poke 32 tiles each a day; answered while wet. */
export function whaleOutcome({ whaleTiles, players, nearPerCredit, wetCredits, dryCredits }: WhaleInput) {
  const pokes = Math.min(players * 32, whaleTiles * 24);
  const pokeNear = pokes * dryCredits * nearPerCredit;
  const answerNear = pokes * wetCredits * nearPerCredit;
  return {
    share: whaleTiles / wallTiles(),
    buyNear: whaleTiles * dryCredits * nearPerCredit,
    pokeNear,
    answerNear,
    stakersNear: (pokeNear + answerNear) * (NEAR_SPLIT.buyback / 100) * (MPOO_SPLIT.stakers / 100),
  };
}

/** Where a week of painter NEAR settles once the pool releases `DAILY_RELEASE` a day. Before swap costs. */
export function stakeOutcome(weeklyNear: number, share: number) {
  const buyback = weeklyNear * NEAR_SPLIT.buyback / 100;
  const weekly = buyback * MPOO_SPLIT.stakers / 100;
  return {
    pool: (weekly / 7) / DAILY_RELEASE,
    you: weekly * share,
    flushed: buyback * MPOO_SPLIT.burn / 100,
  };
}

/** Labelled example for the unconfigured preview. Never shown when a board is configured. */
export function exampleToilet(): ToiletSnapshot {
  const e18 = 10n ** 18n;
  return {
    kind: "live",
    emission: {
      perCellSecond: 1_000_000_000_000_000n,
      accruedTotal: 21_400_000n * e18,
      cap: 1_000_000_000n * e18,
      remaining: 978_600_000n * e18,
    },
    supply: { totalSupply: 18_900_000n * e18, issuedTotal: 19_200_000n * e18, burnedTotal: 300_000n * e18 },
    paused: false,
    account: { balance: 12_480n * e18, pending: 2_315_600_000_000_000_000_000n },
    accountFailed: false,
  };
}
