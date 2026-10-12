/**
 * Regenerates golden JSON under fixtures/golden/ from scenario definitions.
 * Run: npm run generate-fixtures
 *
 * Documented numeric examples are asserted here so regenerating cannot silently
 * drift from pressure-and-paint.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { regionId } from "./geometry.ts";
import {
  applySuccessfulHeat,
  cooledHeatAt,
  placementCost,
  quoteRegion,
} from "./math.ts";
import { buildReport } from "./report.ts";
import { runScenario } from "./simulate.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_GEOMETRY,
  configToJson,
  toiletString,
  type PlacementIntent,
  type RegionState,
} from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = join(root, "fixtures", "golden");

function writeJson(name: string, value: unknown): void {
  mkdirSync(goldenDir, { recursive: true });
  writeFileSync(join(goldenDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function intent(
  t: number | bigint,
  account: string,
  operator: string,
  x: number,
  y: number,
  color: number,
): PlacementIntent {
  return { t: BigInt(t), account, operator, x, y, color };
}

function outcomeJson(outcome: {
  ok: boolean;
  reason?: string;
  region_id: number | null;
  cost: bigint | null;
  cooled_heat: bigint | null;
  heat_after: bigint | null;
  updated_at_seconds: bigint | null;
}) {
  if (outcome.ok) {
    return {
      ok: true,
      region_id: outcome.region_id,
      cost: toiletString(outcome.cost!),
      cooled_heat: toiletString(outcome.cooled_heat!),
      heat_after: toiletString(outcome.heat_after!),
      updated_at_seconds: toiletString(outcome.updated_at_seconds!),
    };
  }
  return {
    ok: false,
    reason: outcome.reason,
    region_id: outcome.region_id,
    cost: null,
    cooled_heat: outcome.cooled_heat === null ? null : toiletString(outcome.cooled_heat),
    heat_after: outcome.heat_after === null ? null : toiletString(outcome.heat_after),
    updated_at_seconds:
      outcome.updated_at_seconds === null
        ? null
        : toiletString(outcome.updated_at_seconds),
  };
}

function scenarioFixture(
  name: string,
  description: string,
  intents: PlacementIntent[],
  extras: {
    priceThreshold?: bigint;
    restorationTargets?: Array<{ x: number; y: number; color: number; account: string }>;
  } = {},
) {
  const priceThreshold = extras.priceThreshold ?? FIXTURE_CONFIG.base_cost + 1n;
  const result = runScenario(intents, {
    geometry: FIXTURE_GEOMETRY,
    config: FIXTURE_CONFIG,
    priceThreshold,
    restorationTargets: extras.restorationTargets,
  });
  const report = buildReport(name, result, priceThreshold);
  return {
    name,
    description,
    config: configToJson(FIXTURE_CONFIG),
    geometry: FIXTURE_GEOMETRY,
    price_threshold: toiletString(priceThreshold),
    ...(extras.restorationTargets
      ? { restoration_targets: extras.restorationTargets }
      : {}),
    steps: intents.map((step, index) => ({
      t: toiletString(step.t),
      account: step.account,
      operator: step.operator,
      x: step.x,
      y: step.y,
      color: step.color,
      expect: outcomeJson(result.steps[index]!.outcome),
    })),
    expect_report: {
      spend: report.spend,
      successful_placements: report.successful_placements,
      rejected_placements: report.rejected_placements,
      restoration_cost: report.restoration_cost,
      time_above_threshold_seconds: report.time_above_threshold_seconds,
      price_threshold: report.price_threshold,
      concentration_by_operator: report.concentration_by_operator,
      concentration_by_account: report.concentration_by_account,
    },
    markdown_summary: report.markdown_summary,
  };
}

function assertDocExamples(): void {
  const cold: RegionState = { heat: 0n, updated_at_seconds: 0n };
  const q1 = quoteRegion(cold, FIXTURE_CONFIG, 100n);
  if (q1.cost !== 10n || q1.cooled_heat !== 0n) {
    throw new Error(`documented cold cost expected 10, got ${q1.cost}`);
  }

  const afterFirst = applySuccessfulHeat(q1.cooled_heat, FIXTURE_CONFIG, 100n);
  if (afterFirst.heat !== 10n) {
    throw new Error(`after first placement heat expected 10, got ${afterFirst.heat}`);
  }
  const q2 = quoteRegion(afterFirst, FIXTURE_CONFIG, 100n);
  if (q2.cost !== 11n || q2.cooled_heat !== 10n) {
    throw new Error(`documented second same-second cost expected 11, got ${q2.cost}`);
  }

  const heat20: RegionState = { heat: 20n, updated_at_seconds: 100n };
  const q3 = quoteRegion(heat20, FIXTURE_CONFIG, 110n);
  if (q3.cooled_heat !== 10n || q3.cost !== 11n) {
    throw new Error(`documented cool-after-10s expected cooled 10 cost 11`);
  }

  const capped: RegionState = { heat: 400n, updated_at_seconds: 100n };
  const q4 = quoteRegion(capped, FIXTURE_CONFIG, 100n);
  if (q4.cost !== 50n) {
    throw new Error(`documented heat-cap cost expected 50, got ${q4.cost}`);
  }
}

function documentedExamples() {
  assertDocExamples();
  const cases = [
    {
      id: "cold_region_at_t100",
      region: { heat: "0", updated_at_seconds: "0" },
      t: "100",
      expect: {
        elapsed: "100",
        cooled_heat: "0",
        cost: "10",
      },
    },
    {
      id: "second_placement_same_second",
      region: { heat: "10", updated_at_seconds: "100" },
      t: "100",
      expect: {
        elapsed: "0",
        cooled_heat: "10",
        cost: "11",
        heat_after_success: "20",
      },
    },
    {
      id: "after_10s_heat20_cools_to_10",
      region: { heat: "20", updated_at_seconds: "100" },
      t: "110",
      expect: {
        elapsed: "10",
        cooled_heat: "10",
        cost: "11",
      },
    },
    {
      id: "heat_cap_cost_is_max",
      region: { heat: "400", updated_at_seconds: "50" },
      t: "50",
      expect: {
        elapsed: "0",
        cooled_heat: "400",
        cost: "50",
      },
    },
    {
      id: "long_inactivity_fully_cools",
      region: { heat: "20", updated_at_seconds: "100" },
      t: "10020",
      expect: {
        elapsed: "9920",
        cooled_heat: "0",
        cost: "10",
      },
    },
    {
      id: "overflow_safe_decay_bounds_elapsed",
      region: { heat: "5", updated_at_seconds: "0" },
      t: "999999999999",
      expect: {
        elapsed: "999999999999",
        cooled_heat: "0",
        cost: "10",
      },
    },
  ];

  // Verify generator math matches case expectations.
  for (const c of cases) {
    const region: RegionState = {
      heat: BigInt(c.region.heat),
      updated_at_seconds: BigInt(c.region.updated_at_seconds),
    };
    const t = BigInt(c.t);
    const { elapsed, cooled_heat } = cooledHeatAt(region, FIXTURE_CONFIG, t);
    const cost = placementCost(cooled_heat, FIXTURE_CONFIG);
    if (
      toiletString(elapsed) !== c.expect.elapsed ||
      toiletString(cooled_heat) !== c.expect.cooled_heat ||
      toiletString(cost) !== c.expect.cost
    ) {
      throw new Error(`case ${c.id} drifted from documented expect`);
    }
    if ("heat_after_success" in c.expect) {
      const next = applySuccessfulHeat(cooled_heat, FIXTURE_CONFIG, t);
      if (toiletString(next.heat) !== c.expect.heat_after_success) {
        throw new Error(`case ${c.id} heat_after_success drift`);
      }
    }
  }

  return {
    name: "documented-examples",
    description:
      "Canonical numeric vectors from pressure-and-paint.md fixture config.",
    config: configToJson(FIXTURE_CONFIG),
    geometry: FIXTURE_GEOMETRY,
    cases,
  };
}

function regionBoundaryCoords() {
  const samples = [
    { x: 0, y: 0, region_id: 0 },
    { x: 7, y: 0, region_id: 0 },
    { x: 8, y: 0, region_id: 1 },
    { x: 0, y: 7, region_id: 0 },
    { x: 0, y: 8, region_id: 16 },
    { x: 7, y: 7, region_id: 0 },
    { x: 8, y: 8, region_id: 17 },
    { x: 127, y: 127, region_id: 255 },
    { x: 120, y: 120, region_id: 255 },
    { x: 119, y: 119, region_id: 238 },
  ];
  for (const sample of samples) {
    const got = regionId(FIXTURE_GEOMETRY, sample.x, sample.y);
    if (got !== sample.region_id) {
      throw new Error(
        `boundary (${sample.x},${sample.y}) expected region ${sample.region_id}, got ${got}`,
      );
    }
  }

  // Paint on both sides of the x=8 boundary; heats must not leak.
  const intents = [
    intent(100, "left.near", "left", 7, 0, 1),
    intent(100, "right.near", "right", 8, 0, 2),
    intent(100, "left.near", "left", 7, 1, 3),
  ];
  return {
    ...scenarioFixture(
      "region-boundary",
      "Region IDs at 8×8 boundaries; adjacent regions heat independently.",
      intents,
    ),
    coordinate_samples: samples,
  };
}

function main(): void {
  writeJson("documented-examples.json", documentedExamples());

  writeJson(
    "quiet-artist.json",
    scenarioFixture(
      "quiet-artist",
      "Single operator paints sparsely so heat fully cools between placements.",
      [
        intent(100, "quiet.near", "quiet", 16, 16, 1),
        intent(160, "quiet.near", "quiet", 17, 16, 2),
        intent(220, "quiet.near", "quiet", 18, 16, 3),
        intent(280, "quiet.near", "quiet", 19, 16, 4),
        intent(340, "quiet.near", "quiet", 20, 16, 5),
      ],
      { priceThreshold: 11n },
    ),
  );

  writeJson(
    "two-crews.json",
    scenarioFixture(
      "two-crews",
      "Two crews alternate in one contested region, raising local pressure.",
      [
        intent(100, "crew-a-1.near", "crew-a", 40, 40, 1),
        intent(100, "crew-b-1.near", "crew-b", 41, 40, 2),
        intent(101, "crew-a-2.near", "crew-a", 42, 40, 3),
        intent(101, "crew-b-2.near", "crew-b", 43, 40, 4),
        intent(102, "crew-a-1.near", "crew-a", 44, 40, 5),
        intent(102, "crew-b-1.near", "crew-b", 45, 40, 6),
        intent(103, "crew-a-2.near", "crew-a", 40, 41, 7),
        intent(103, "crew-b-2.near", "crew-b", 41, 41, 1),
      ],
      { priceThreshold: 11n },
    ),
  );

  // Wealthy warmer heats one region, then a restorer must pay the elevated quote.
  const warmerIntents: PlacementIntent[] = [];
  for (let i = 0; i < 40; i += 1) {
    warmerIntents.push(intent(500, "whale.near", "whale", 64 + (i % 8), 64, 1 + (i % 7)));
  }
  warmerIntents.push(intent(500, "restorer.near", "restorer", 64, 65, 2));
  writeJson(
    "wealthy-warmer.json",
    scenarioFixture(
      "wealthy-warmer",
      "Whale heats a region toward the cap; restoration quote reflects obstruction.",
      warmerIntents,
      {
        priceThreshold: 40n,
        restorationTargets: [
          { x: 64, y: 64, color: 7, account: "restorer.near" },
          { x: 65, y: 64, color: 7, account: "restorer.near" },
          { x: 66, y: 64, color: 7, account: "restorer.near" },
        ],
      },
    ),
  );

  writeJson("region-boundary.json", regionBoundaryCoords());

  writeJson(
    "same-second-ordering.json",
    scenarioFixture(
      "same-second-ordering",
      "Same-second placements: order determines intermediate heat each payer sees.",
      [
        intent(200, "alice.near", "alice", 8, 8, 1),
        intent(200, "bob.near", "bob", 9, 8, 2),
        intent(200, "carol.near", "carol", 10, 8, 3),
      ],
      { priceThreshold: 11n },
    ),
  );

  writeJson(
    "long-inactivity.json",
    scenarioFixture(
      "long-inactivity",
      "After long inactivity, cooled heat returns to zero and cost returns to base.",
      [
        intent(100, "sleeper.near", "sleeper", 24, 24, 1),
        intent(100, "sleeper.near", "sleeper", 25, 24, 2),
        intent(10100, "sleeper.near", "sleeper", 26, 24, 3),
      ],
      { priceThreshold: 11n },
    ),
  );

  // Drive heat to cap: 40 increments of 10 → 400.
  const capIntents: PlacementIntent[] = [];
  for (let i = 0; i < 42; i += 1) {
    capIntents.push(
      intent(300, "capper.near", "capper", 80 + (i % 8), 80 + Math.floor(i / 8), 1 + (i % 7)),
    );
  }
  writeJson(
    "heat-cap.json",
    scenarioFixture(
      "heat-cap",
      "Heat clamps at heat_cap; placement cost clamps at max_cost.",
      capIntents,
      { priceThreshold: 50n },
    ),
  );

  writeJson(
    "noop-same-artist-same-color.json",
    scenarioFixture(
      "noop-same-artist-same-color",
      "Same-artist/same-color is rejected before charging; heat does not change.",
      [
        intent(100, "artist.near", "artist", 0, 0, 4),
        intent(100, "artist.near", "artist", 0, 0, 4),
        intent(101, "artist.near", "artist", 0, 0, 4),
        intent(101, "other.near", "other", 0, 0, 4),
      ],
      { priceThreshold: 11n },
    ),
  );

  // Fixed-price control: compare quiet spend vs heated spend in reports (separate file).
  writeJson(
    "fixed-price-control.json",
    {
      name: "fixed-price-control",
      description:
        "Control note: if every placement cost exactly base_cost (10), quiet-artist spend would equal successful_placements * 10. Contested scenarios diverge upward.",
      base_cost: "10",
      compare_scenarios: ["quiet-artist", "two-crews", "wealthy-warmer"],
    },
  );

  console.log(`Wrote golden fixtures to ${goldenDir}`);
}

main();
