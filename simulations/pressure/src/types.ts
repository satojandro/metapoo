/**
 * Pressure pricing types for the Meta Poo regional heat model.
 *
 * Money and heat travel as decimal strings at JSON boundaries (TOILET integer
 * units). Internally we use bigint so fixture math stays exact.
 */

/** Versioned pressure config. All fields are integers; no floats. */
export type PressureConfig = {
  version: number;
  base_cost: bigint;
  max_cost: bigint;
  heat_cap: bigint;
  heat_increment: bigint;
  decay_per_second: bigint;
  surcharge_numerator: bigint;
  surcharge_denominator: bigint;
  /** Unix-ish chain seconds when this config becomes effective. */
  effective_at: bigint;
};

/** Board geometry used to map (x, y) → region_id. */
export type BoardGeometry = {
  width: number;
  height: number;
  region_size: number;
};

/** Per-region heat state. */
export type RegionState = {
  heat: bigint;
  updated_at_seconds: bigint;
};

/** Sparse painted cell (Open wall: latest writer wins attribution). */
export type PixelState = {
  color: number;
  artist: string;
};

/** One attempted placement in a scenario. */
export type PlacementIntent = {
  /** Chain second t. */
  t: bigint;
  account: string;
  /** True simulated operator (for concentration reports). */
  operator: string;
  x: number;
  y: number;
  color: number;
};

export type PlacementRejectReason =
  | "out_of_bounds"
  | "invalid_color"
  | "noop_same_artist_same_color"
  | "zero_surcharge_denominator"
  | "insufficient_balance";

export type PlacementOutcome =
  | {
      ok: true;
      region_id: number;
      cost: bigint;
      cooled_heat: bigint;
      heat_after: bigint;
      updated_at_seconds: bigint;
    }
  | {
      ok: false;
      reason: PlacementRejectReason;
      region_id: number | null;
      cost: null;
      cooled_heat: bigint | null;
      heat_after: bigint | null;
      /** Region heat is unchanged on reject. */
      updated_at_seconds: bigint | null;
    };

/** Human + machine report fields required by the pressure spec. */
export type PressureReport = {
  scenario: string;
  spend: string;
  successful_placements: number;
  rejected_placements: number;
  restoration_cost: string;
  time_above_threshold_seconds: string;
  price_threshold: string;
  concentration_by_operator: Record<string, { spend: string; placements: number }>;
  concentration_by_account: Record<string, { spend: string; placements: number }>;
  markdown_summary: string;
};

/** Decimal-string form of PressureConfig for JSON fixtures. */
export type PressureConfigJson = {
  version: number;
  base_cost: string;
  max_cost: string;
  heat_cap: string;
  heat_increment: string;
  decay_per_second: string;
  surcharge_numerator: string;
  surcharge_denominator: string;
  effective_at: string;
};

export type RegionStateJson = {
  heat: string;
  updated_at_seconds: string;
};

export function toiletString(value: bigint): string {
  return value.toString(10);
}

export function parseToilet(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`TOILET values must be non-negative integers, got ${value}`);
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`TOILET decimal string must be unsigned digits, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

export function configFromJson(json: PressureConfigJson): PressureConfig {
  return {
    version: json.version,
    base_cost: parseToilet(json.base_cost),
    max_cost: parseToilet(json.max_cost),
    heat_cap: parseToilet(json.heat_cap),
    heat_increment: parseToilet(json.heat_increment),
    decay_per_second: parseToilet(json.decay_per_second),
    surcharge_numerator: parseToilet(json.surcharge_numerator),
    surcharge_denominator: parseToilet(json.surcharge_denominator),
    effective_at: parseToilet(json.effective_at),
  };
}

export function configToJson(config: PressureConfig): PressureConfigJson {
  return {
    version: config.version,
    base_cost: toiletString(config.base_cost),
    max_cost: toiletString(config.max_cost),
    heat_cap: toiletString(config.heat_cap),
    heat_increment: toiletString(config.heat_increment),
    decay_per_second: toiletString(config.decay_per_second),
    surcharge_numerator: toiletString(config.surcharge_numerator),
    surcharge_denominator: toiletString(config.surcharge_denominator),
    effective_at: toiletString(config.effective_at),
  };
}

export function regionFromJson(json: RegionStateJson): RegionState {
  return {
    heat: parseToilet(json.heat),
    updated_at_seconds: parseToilet(json.updated_at_seconds),
  };
}

export function regionToJson(region: RegionState): RegionStateJson {
  return {
    heat: toiletString(region.heat),
    updated_at_seconds: toiletString(region.updated_at_seconds),
  };
}

/** Fixture config from pressure-and-paint.md (prototype only). */
export const FIXTURE_CONFIG: PressureConfig = {
  version: 1,
  base_cost: 10n,
  max_cost: 50n,
  heat_cap: 400n,
  heat_increment: 10n,
  decay_per_second: 1n,
  surcharge_numerator: 1n,
  surcharge_denominator: 10n,
  effective_at: 0n,
};

/** 128×128 board, 8×8 regions → 16×16 = 256 regions. */
export const FIXTURE_GEOMETRY: BoardGeometry = {
  width: 128,
  height: 128,
  region_size: 8,
};
