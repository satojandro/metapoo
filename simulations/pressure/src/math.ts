import type { PlacementOutcome, PressureConfig, RegionState } from "./types.ts";

/**
 * Pure regional pressure math (pressure-and-paint.md).
 *
 * At chain second t:
 * 1. elapsed = max(0, t - updated_at_seconds)
 * 2. cooled_heat = max(0, heat - decay_per_second * elapsed) with saturating/safe mul
 * 3. cost = min(max_cost, base_cost + floor(cooled_heat * num / den))
 * 4. On success: heat = min(heat_cap, cooled_heat + heat_increment), updated_at = t
 */

export class PressureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PressureConfigError";
  }
}

/** NEAR/Rust u128 upper bound — shared with the Rust stub for identical rejection. */
export const U128_MAX = (1n << 128n) - 1n;

/** Reject zero surcharge denominator before any quote or mutation. */
export function assertValidConfig(config: PressureConfig): void {
  if (config.surcharge_denominator === 0n) {
    throw new PressureConfigError("surcharge_denominator must be non-zero");
  }
  if (config.base_cost < 0n || config.max_cost < 0n) {
    throw new PressureConfigError("costs must be non-negative");
  }
  if (config.heat_cap < 0n || config.heat_increment < 0n || config.decay_per_second < 0n) {
    throw new PressureConfigError("heat parameters must be non-negative");
  }
  if (config.surcharge_numerator < 0n) {
    throw new PressureConfigError("surcharge_numerator must be non-negative");
  }
  if (
    config.base_cost > U128_MAX ||
    config.max_cost > U128_MAX ||
    config.heat_cap > U128_MAX ||
    config.heat_increment > U128_MAX ||
    config.decay_per_second > U128_MAX ||
    config.surcharge_numerator > U128_MAX
  ) {
    throw new PressureConfigError("config field exceeds u128");
  }
}

/**
 * Reject cooled_heat × numerator products that would overflow u128 before
 * division. Matches Rust checked_mul (not saturating_mul) so both languages
 * agree at the boundary instead of silently diverging.
 */
export function assertSurchargeProductFits(
  cooledHeat: bigint,
  config: PressureConfig,
): void {
  assertValidConfig(config);
  if (cooledHeat < 0n || cooledHeat > U128_MAX) {
    throw new PressureConfigError("cooled_heat outside u128");
  }
  if (cooledHeat === 0n || config.surcharge_numerator === 0n) {
    return;
  }
  const maxHeat = U128_MAX / config.surcharge_numerator;
  if (cooledHeat > maxHeat) {
    throw new PressureConfigError("surcharge product overflows u128");
  }
}

/**
 * Bound elapsed so decay_per_second * elapsed cannot overflow a u128-style
 * product and so cooling saturates at zero heat.
 */
export function boundElapsedForDecay(
  heat: bigint,
  decayPerSecond: bigint,
  elapsed: bigint,
): bigint {
  if (elapsed <= 0n || heat <= 0n || decayPerSecond <= 0n) {
    return 0n;
  }
  // Maximum elapsed that can still leave residual heat: floor((heat - 1) / decay) + 1
  // Equivalent saturating path: anything larger cools fully to 0.
  const maxUseful = heat / decayPerSecond + (heat % decayPerSecond === 0n ? 0n : 1n);
  return elapsed < maxUseful ? elapsed : maxUseful;
}

export function cooledHeatAt(
  region: RegionState,
  config: PressureConfig,
  t: bigint,
): { elapsed: bigint; cooled_heat: bigint } {
  assertValidConfig(config);
  const rawElapsed = t >= region.updated_at_seconds ? t - region.updated_at_seconds : 0n;
  const elapsed = rawElapsed;
  const bounded = boundElapsedForDecay(region.heat, config.decay_per_second, elapsed);
  const decayed = config.decay_per_second * bounded;
  const cooled =
    region.heat > decayed ? region.heat - decayed : 0n;
  return { elapsed, cooled_heat: cooled };
}

export function placementCost(cooledHeat: bigint, config: PressureConfig): bigint {
  assertSurchargeProductFits(cooledHeat, config);
  const surcharge = (cooledHeat * config.surcharge_numerator) / config.surcharge_denominator;
  const uncapped = config.base_cost + surcharge;
  if (uncapped > U128_MAX) {
    throw new PressureConfigError("uncapped cost overflows u128");
  }
  return uncapped < config.max_cost ? uncapped : config.max_cost;
}

export function quoteRegion(
  region: RegionState,
  config: PressureConfig,
  t: bigint,
): { elapsed: bigint; cooled_heat: bigint; cost: bigint } {
  const { elapsed, cooled_heat } = cooledHeatAt(region, config, t);
  return { elapsed, cooled_heat, cost: placementCost(cooled_heat, config) };
}

/** Apply a successful placement's heat update (caller already charged cost). */
export function applySuccessfulHeat(
  cooledHeat: bigint,
  config: PressureConfig,
  t: bigint,
): RegionState {
  assertValidConfig(config);
  const raised = cooledHeat + config.heat_increment;
  const heat = raised < config.heat_cap ? raised : config.heat_cap;
  return { heat, updated_at_seconds: t };
}

export function coldRegion(): RegionState {
  return { heat: 0n, updated_at_seconds: 0n };
}

/**
 * Evaluate a quote + optional commit for a known region.
 * No-op / balance checks are handled by the simulator; this stays pure math.
 */
export function evaluatePlacementMath(
  region: RegionState,
  config: PressureConfig,
  t: bigint,
  commit: boolean,
): PlacementOutcome & { region_id: number } {
  // region_id filled by caller; placeholder 0 here for pure math helpers/tests.
  try {
    assertValidConfig(config);
  } catch {
    return {
      ok: false,
      reason: "zero_surcharge_denominator",
      region_id: 0,
      cost: null,
      cooled_heat: null,
      heat_after: null,
      updated_at_seconds: null,
    };
  }
  const { cooled_heat, cost } = quoteRegion(region, config, t);
  if (!commit) {
    return {
      ok: true,
      region_id: 0,
      cost,
      cooled_heat,
      heat_after: region.heat,
      updated_at_seconds: region.updated_at_seconds,
    };
  }
  const next = applySuccessfulHeat(cooled_heat, config, t);
  return {
    ok: true,
    region_id: 0,
    cost,
    cooled_heat,
    heat_after: next.heat,
    updated_at_seconds: next.updated_at_seconds,
  };
}
