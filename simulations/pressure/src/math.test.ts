import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { regionId, regionCount } from "./geometry.ts";
import {
  PressureConfigError,
  applySuccessfulHeat,
  assertValidConfig,
  cooledHeatAt,
  placementCost,
  quoteRegion,
} from "./math.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_GEOMETRY,
  configFromJson,
  parseToilet,
  type PressureConfigJson,
  type RegionStateJson,
} from "./types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

test("fixture geometry is 128×128 with 256 regions of 8×8", () => {
  assert.equal(FIXTURE_GEOMETRY.width, 128);
  assert.equal(FIXTURE_GEOMETRY.height, 128);
  assert.equal(FIXTURE_GEOMETRY.region_size, 8);
  assert.equal(regionCount(FIXTURE_GEOMETRY), 256);
});

test("zero surcharge denominator is rejected", () => {
  assert.throws(
    () =>
      assertValidConfig({
        ...FIXTURE_CONFIG,
        surcharge_denominator: 0n,
      }),
    PressureConfigError,
  );
});

test("documented-examples golden vectors", () => {
  const doc = JSON.parse(
    readFileSync(join(fixtures, "golden", "documented-examples.json"), "utf8"),
  );
  const config = configFromJson(doc.config as PressureConfigJson);

  for (const c of doc.cases) {
    const region = {
      heat: parseToilet((c.region as RegionStateJson).heat),
      updated_at_seconds: parseToilet((c.region as RegionStateJson).updated_at_seconds),
    };
    const t = parseToilet(c.t);
    const { elapsed, cooled_heat } = cooledHeatAt(region, config, t);
    const cost = placementCost(cooled_heat, config);
    assert.equal(elapsed, parseToilet(c.expect.elapsed), c.id);
    assert.equal(cooled_heat, parseToilet(c.expect.cooled_heat), c.id);
    assert.equal(cost, parseToilet(c.expect.cost), c.id);
    if (c.expect.heat_after_success !== undefined) {
      const next = applySuccessfulHeat(cooled_heat, config, t);
      assert.equal(next.heat, parseToilet(c.expect.heat_after_success), c.id);
    }
  }
});

test("config.json matches FIXTURE_CONFIG", () => {
  const raw = JSON.parse(readFileSync(join(fixtures, "config.json"), "utf8"));
  const config = configFromJson(raw);
  assert.equal(config.base_cost, 10n);
  assert.equal(config.max_cost, 50n);
  assert.equal(config.heat_cap, 400n);
  assert.equal(config.heat_increment, 10n);
  assert.equal(config.decay_per_second, 1n);
  assert.equal(config.surcharge_numerator, 1n);
  assert.equal(config.surcharge_denominator, 10n);
  assert.equal(raw.board.region_count, 256);
});

test("region boundary samples from golden fixture", () => {
  const boundary = JSON.parse(
    readFileSync(join(fixtures, "golden", "region-boundary.json"), "utf8"),
  );
  for (const sample of boundary.coordinate_samples) {
    assert.equal(
      regionId(FIXTURE_GEOMETRY, sample.x, sample.y),
      sample.region_id,
      `(${sample.x},${sample.y})`,
    );
  }
});

test("quote at heat cap is max_cost", () => {
  const { cost } = quoteRegion(
    { heat: 400n, updated_at_seconds: 0n },
    FIXTURE_CONFIG,
    0n,
  );
  assert.equal(cost, 50n);
});

test("overflow-boundary golden: Rust/TS agree on u128 surcharge rejection", () => {
  const file = JSON.parse(
    readFileSync(join(fixtures, "golden", "overflow-boundary.json"), "utf8"),
  );
  for (const c of file.cases) {
    const config = configFromJson(c.config as PressureConfigJson);
    const cooled = parseToilet(c.cooled_heat);
    if (c.expect.error === "overflow") {
      assert.throws(
        () => placementCost(cooled, config),
        (err: unknown) =>
          err instanceof PressureConfigError &&
          /overflow/i.test(err.message),
        c.id,
      );
    } else {
      assert.equal(placementCost(cooled, config), parseToilet(c.expect.cost), c.id);
    }
  }
});
