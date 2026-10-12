import { isInsideBoard, regionId } from "./geometry.ts";
import {
  applySuccessfulHeat,
  assertValidConfig,
  coldRegion,
  quoteRegion,
} from "./math.ts";
import type {
  BoardGeometry,
  PixelState,
  PlacementIntent,
  PlacementOutcome,
  PressureConfig,
  RegionState,
} from "./types.ts";
import { toiletString } from "./types.ts";

const MAX_COLOR_INDEX = 7;

export type SimulatorOptions = {
  geometry: BoardGeometry;
  config: PressureConfig;
  /** Optional starting balances in TOILET; missing account = unlimited. */
  balances?: Map<string, bigint>;
  /** Price threshold for "time above threshold" reporting. */
  priceThreshold?: bigint;
  /**
   * Target pixels used to compute restoration_cost at the end of a scenario:
   * sum of quotes to paint each target cell with the desired color/account.
   * Quotes are sequential (pressure updates) in target order.
   */
  restorationTargets?: Array<{ x: number; y: number; color: number; account: string }>;
};

export type StepRecord = {
  intent: PlacementIntent;
  outcome: PlacementOutcome;
  spend_after: string;
};

export type SimulationResult = {
  steps: StepRecord[];
  regions: Map<number, RegionState>;
  pixels: Map<string, PixelState>;
  spend_by_account: Map<string, bigint>;
  spend_by_operator: Map<string, bigint>;
  placements_by_account: Map<string, number>;
  placements_by_operator: Map<string, number>;
  total_spend: bigint;
  successful_placements: number;
  rejected_placements: number;
  /** Seconds (integral) any monitored region quote was >= threshold. */
  time_above_threshold_seconds: bigint;
  restoration_cost: bigint;
};

function pixelKey(x: number, y: number): string {
  return `${x},${y}`;
}

function getRegion(regions: Map<number, RegionState>, id: number): RegionState {
  const existing = regions.get(id);
  if (existing) {
    return existing;
  }
  const fresh = coldRegion();
  regions.set(id, fresh);
  return fresh;
}

function addSpend(map: Map<string, bigint>, key: string, amount: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function bumpCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Track how many whole chain-seconds the max regional quote stayed at/above
 * the threshold between consecutive events (and until finalT).
 */
function accumulateThresholdTime(params: {
  geometry: BoardGeometry;
  config: PressureConfig;
  regions: Map<number, RegionState>;
  threshold: bigint;
  fromExclusive: bigint;
  toInclusive: bigint;
}): bigint {
  const { geometry, config, regions, threshold, fromExclusive, toInclusive } = params;
  if (toInclusive <= fromExclusive) {
    return 0n;
  }
  // Only touched regions can exceed base_cost. Sample each second in
  // (fromExclusive, toInclusive]. Fixtures stay small; closed-form cooling
  // intervals can replace this loop later if spans grow.
  if (regions.size === 0) {
    return 0n;
  }
  void geometry;
  let total = 0n;
  for (let t = fromExclusive + 1n; t <= toInclusive; t += 1n) {
    let hot = false;
    for (const region of regions.values()) {
      const { cost } = quoteRegion(region, config, t);
      if (cost >= threshold) {
        hot = true;
        break;
      }
    }
    if (hot) {
      total += 1n;
    }
  }
  return total;
}

export function createSimulator(options: SimulatorOptions) {
  assertValidConfig(options.config);
  const regions = new Map<number, RegionState>();
  const pixels = new Map<string, PixelState>();
  const spendByAccount = new Map<string, bigint>();
  const spendByOperator = new Map<string, bigint>();
  const placementsByAccount = new Map<string, number>();
  const placementsByOperator = new Map<string, number>();
  const balances =
    options.balances === undefined ? null : new Map(options.balances);
  const threshold = options.priceThreshold ?? options.config.base_cost + 1n;
  let totalSpend = 0n;
  let successful = 0;
  let rejected = 0;
  let lastT = 0n;
  let timeAbove = 0n;
  const steps: StepRecord[] = [];

  function attempt(intent: PlacementIntent): PlacementOutcome {
    if (intent.t > lastT) {
      timeAbove += accumulateThresholdTime({
        geometry: options.geometry,
        config: options.config,
        regions,
        threshold,
        fromExclusive: lastT,
        toInclusive: intent.t,
      });
      lastT = intent.t;
    } else if (intent.t < lastT) {
      throw new Error(
        `placements must be non-decreasing in t (got ${intent.t} after ${lastT})`,
      );
    }

    if (!isInsideBoard(options.geometry, intent.x, intent.y)) {
      rejected += 1;
      const outcome: PlacementOutcome = {
        ok: false,
        reason: "out_of_bounds",
        region_id: null,
        cost: null,
        cooled_heat: null,
        heat_after: null,
        updated_at_seconds: null,
      };
      steps.push({ intent, outcome, spend_after: toiletString(totalSpend) });
      return outcome;
    }

    if (
      !Number.isInteger(intent.color) ||
      intent.color < 0 ||
      intent.color > MAX_COLOR_INDEX
    ) {
      rejected += 1;
      const outcome: PlacementOutcome = {
        ok: false,
        reason: "invalid_color",
        region_id: regionId(options.geometry, intent.x, intent.y),
        cost: null,
        cooled_heat: null,
        heat_after: null,
        updated_at_seconds: null,
      };
      steps.push({ intent, outcome, spend_after: toiletString(totalSpend) });
      return outcome;
    }

    const rid = regionId(options.geometry, intent.x, intent.y);
    const region = getRegion(regions, rid);
    const key = pixelKey(intent.x, intent.y);
    const existing = pixels.get(key);

    // Same-artist/same-color is rejected before charging; heat unchanged.
    if (
      existing &&
      existing.artist === intent.account &&
      existing.color === intent.color
    ) {
      rejected += 1;
      const { cooled_heat } = quoteRegion(region, options.config, intent.t);
      const outcome: PlacementOutcome = {
        ok: false,
        reason: "noop_same_artist_same_color",
        region_id: rid,
        cost: null,
        cooled_heat,
        heat_after: region.heat,
        updated_at_seconds: region.updated_at_seconds,
      };
      steps.push({ intent, outcome, spend_after: toiletString(totalSpend) });
      return outcome;
    }

    const { cooled_heat, cost } = quoteRegion(region, options.config, intent.t);

    if (balances) {
      const bal = balances.get(intent.account) ?? 0n;
      if (bal < cost) {
        rejected += 1;
        const outcome: PlacementOutcome = {
          ok: false,
          reason: "insufficient_balance",
          region_id: rid,
          cost: null,
          cooled_heat,
          heat_after: region.heat,
          updated_at_seconds: region.updated_at_seconds,
        };
        steps.push({ intent, outcome, spend_after: toiletString(totalSpend) });
        return outcome;
      }
      balances.set(intent.account, bal - cost);
    }

    const next = applySuccessfulHeat(cooled_heat, options.config, intent.t);
    regions.set(rid, next);
    pixels.set(key, { color: intent.color, artist: intent.account });
    totalSpend += cost;
    successful += 1;
    addSpend(spendByAccount, intent.account, cost);
    addSpend(spendByOperator, intent.operator, cost);
    bumpCount(placementsByAccount, intent.account);
    bumpCount(placementsByOperator, intent.operator);

    const outcome: PlacementOutcome = {
      ok: true,
      region_id: rid,
      cost,
      cooled_heat,
      heat_after: next.heat,
      updated_at_seconds: next.updated_at_seconds,
    };
    steps.push({ intent, outcome, spend_after: toiletString(totalSpend) });
    return outcome;
  }

  function run(intents: PlacementIntent[]): SimulationResult {
    for (const intent of intents) {
      attempt(intent);
    }
    return finalize();
  }

  function computeRestorationCost(): bigint {
    const targets = options.restorationTargets;
    if (!targets || targets.length === 0) {
      return 0n;
    }
    // Clone region heat so quoting restoration does not mutate live state.
    const clone = new Map<number, RegionState>();
    for (const [id, state] of regions) {
      clone.set(id, { ...state });
    }
    let costSum = 0n;
    const t = lastT;
    for (const target of targets) {
      if (!isInsideBoard(options.geometry, target.x, target.y)) {
        continue;
      }
      const key = pixelKey(target.x, target.y);
      const pix = pixels.get(key);
      if (pix && pix.color === target.color && pix.artist === target.account) {
        continue;
      }
      const rid = regionId(options.geometry, target.x, target.y);
      const region = clone.get(rid) ?? coldRegion();
      const { cooled_heat, cost } = quoteRegion(region, options.config, t);
      costSum += cost;
      clone.set(rid, applySuccessfulHeat(cooled_heat, options.config, t));
    }
    return costSum;
  }

  function finalize(): SimulationResult {
    return {
      steps,
      regions,
      pixels,
      spend_by_account: spendByAccount,
      spend_by_operator: spendByOperator,
      placements_by_account: placementsByAccount,
      placements_by_operator: placementsByOperator,
      total_spend: totalSpend,
      successful_placements: successful,
      rejected_placements: rejected,
      time_above_threshold_seconds: timeAbove,
      restoration_cost: computeRestorationCost(),
    };
  }

  return { attempt, run, finalize, regions, pixels };
}

export function runScenario(
  intents: PlacementIntent[],
  options: SimulatorOptions,
): SimulationResult {
  return createSimulator(options).run(intents);
}
