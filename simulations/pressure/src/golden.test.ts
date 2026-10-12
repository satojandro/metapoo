import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport } from "./report.ts";
import { runScenario } from "./simulate.ts";
import {
  configFromJson,
  parseToilet,
  type PlacementIntent,
  type PressureConfigJson,
} from "./types.ts";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden");

type GoldenStep = {
  t: string;
  account: string;
  operator: string;
  x: number;
  y: number;
  color: number;
  expect: {
    ok: boolean;
    reason?: string;
    region_id: number | null;
    cost: string | null;
    cooled_heat: string | null;
    heat_after: string | null;
    updated_at_seconds: string | null;
  };
};

type ScenarioGolden = {
  name: string;
  config: PressureConfigJson;
  geometry: { width: number; height: number; region_size: number };
  price_threshold: string;
  steps: GoldenStep[];
  expect_report: {
    spend: string;
    successful_placements: number;
    rejected_placements: number;
    restoration_cost: string;
    time_above_threshold_seconds: string;
    price_threshold: string;
    concentration_by_operator: Record<string, { spend: string; placements: number }>;
    concentration_by_account: Record<string, { spend: string; placements: number }>;
  };
  restoration_targets?: Array<{ x: number; y: number; color: number; account: string }>;
};

const SCENARIO_FILES = [
  "quiet-artist.json",
  "two-crews.json",
  "wealthy-warmer.json",
  "region-boundary.json",
  "same-second-ordering.json",
  "long-inactivity.json",
  "heat-cap.json",
  "noop-same-artist-same-color.json",
];

function loadScenario(file: string): ScenarioGolden {
  return JSON.parse(readFileSync(join(goldenDir, file), "utf8")) as ScenarioGolden;
}

function intentsFrom(steps: GoldenStep[]): PlacementIntent[] {
  return steps.map((step) => ({
    t: parseToilet(step.t),
    account: step.account,
    operator: step.operator,
    x: step.x,
    y: step.y,
    color: step.color,
  }));
}

function assertOutcome(actual: {
  ok: boolean;
  reason?: string;
  region_id: number | null;
  cost: bigint | null;
  cooled_heat: bigint | null;
  heat_after: bigint | null;
  updated_at_seconds: bigint | null;
}, expected: GoldenStep["expect"], label: string): void {
  assert.equal(actual.ok, expected.ok, `${label} ok`);
  assert.equal(actual.region_id, expected.region_id, `${label} region_id`);
  if (expected.ok) {
    assert.equal(
      actual.cost === null ? null : actual.cost.toString(10),
      expected.cost,
      `${label} cost`,
    );
    assert.equal(
      actual.cooled_heat === null ? null : actual.cooled_heat.toString(10),
      expected.cooled_heat,
      `${label} cooled_heat`,
    );
    assert.equal(
      actual.heat_after === null ? null : actual.heat_after.toString(10),
      expected.heat_after,
      `${label} heat_after`,
    );
    assert.equal(
      actual.updated_at_seconds === null ? null : actual.updated_at_seconds.toString(10),
      expected.updated_at_seconds,
      `${label} updated_at_seconds`,
    );
  } else {
    assert.equal(actual.reason, expected.reason, `${label} reason`);
    assert.equal(
      actual.heat_after === null ? null : actual.heat_after.toString(10),
      expected.heat_after,
      `${label} heat_after unchanged`,
    );
    assert.equal(
      actual.updated_at_seconds === null ? null : actual.updated_at_seconds.toString(10),
      expected.updated_at_seconds,
      `${label} updated_at unchanged`,
    );
  }
}

for (const file of SCENARIO_FILES) {
  test(`golden scenario ${file}`, () => {
    const golden = loadScenario(file);
    const config = configFromJson(golden.config);
    const priceThreshold = parseToilet(golden.price_threshold);

    const result = runScenario(intentsFrom(golden.steps), {
      geometry: golden.geometry,
      config,
      priceThreshold,
      restorationTargets: golden.restoration_targets,
    });

    assert.equal(result.steps.length, golden.steps.length);
    for (let i = 0; i < golden.steps.length; i += 1) {
      assertOutcome(result.steps[i]!.outcome, golden.steps[i]!.expect, `${file} step ${i}`);
    }

    const report = buildReport(golden.name, result, priceThreshold);
    assert.equal(report.spend, golden.expect_report.spend);
    assert.equal(report.successful_placements, golden.expect_report.successful_placements);
    assert.equal(report.rejected_placements, golden.expect_report.rejected_placements);
    assert.equal(report.restoration_cost, golden.expect_report.restoration_cost);
    assert.equal(
      report.time_above_threshold_seconds,
      golden.expect_report.time_above_threshold_seconds,
    );
    assert.deepEqual(
      report.concentration_by_operator,
      golden.expect_report.concentration_by_operator,
    );
    assert.deepEqual(
      report.concentration_by_account,
      golden.expect_report.concentration_by_account,
    );
  });
}

test("golden directory contains required scenario files", () => {
  const files = new Set(readdirSync(goldenDir));
  for (const required of [
    ...SCENARIO_FILES,
    "documented-examples.json",
    "fixed-price-control.json",
    "overflow-boundary.json",
  ]) {
    assert.ok(files.has(required), `missing ${required}`);
  }
});

test("noop rejects without raising heat", () => {
  const golden = loadScenario("noop-same-artist-same-color.json");
  const first = golden.steps[0]!.expect;
  const second = golden.steps[1]!.expect;
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "noop_same_artist_same_color");
  assert.equal(second.heat_after, first.heat_after);
  assert.equal(second.updated_at_seconds, first.updated_at_seconds);
  assert.equal(second.cost, null);
});

test("quiet artist pays only base cost each time", () => {
  const golden = loadScenario("quiet-artist.json");
  for (const step of golden.steps) {
    assert.equal(step.expect.ok, true);
    assert.equal(step.expect.cost, "10");
  }
  assert.equal(golden.expect_report.spend, "50");
  assert.equal(golden.expect_report.successful_placements, 5);
});

test("wealthy warmer restoration cost is above base", () => {
  const golden = loadScenario("wealthy-warmer.json");
  assert.ok(parseToilet(golden.expect_report.restoration_cost) > 10n);
  assert.ok(parseToilet(golden.expect_report.spend) > 100n);
});
