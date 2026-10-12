/**
 * Short human-readable report generator.
 * Usage: npm run report -- fixtures/golden/quiet-artist.json
 *    or: npm run report -- quiet-artist
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, reportToJson } from "./report.ts";
import { runScenario } from "./simulate.ts";
import {
  configFromJson,
  parseToilet,
  type PlacementIntent,
  type PressureConfigJson,
} from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveInput(arg: string): string {
  if (arg.endsWith(".json")) {
    return arg.startsWith("/") ? arg : join(root, arg);
  }
  return join(root, "fixtures", "golden", `${arg}.json`);
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npm run report -- <scenario-name|path-to-golden.json>");
    process.exit(1);
  }

  const path = resolveInput(arg);
  const golden = JSON.parse(readFileSync(path, "utf8"));
  if (!golden.steps) {
    console.error("Input must be a scenario golden with steps[]");
    process.exit(1);
  }

  const config = configFromJson(golden.config as PressureConfigJson);
  const priceThreshold = parseToilet(golden.price_threshold ?? "11");
  const intents: PlacementIntent[] = golden.steps.map(
    (step: {
      t: string;
      account: string;
      operator: string;
      x: number;
      y: number;
      color: number;
    }) => ({
      t: parseToilet(step.t),
      account: step.account,
      operator: step.operator,
      x: step.x,
      y: step.y,
      color: step.color,
    }),
  );

  const result = runScenario(intents, {
    geometry: golden.geometry,
    config,
    priceThreshold,
    restorationTargets: golden.restoration_targets,
  });
  const report = buildReport(golden.name, result, priceThreshold);

  const outBase = basename(path, ".json");
  const outDir = join(root, "fixtures", "reports");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${outBase}.report.json`);
  const mdPath = join(outDir, `${outBase}.report.md`);

  writeFileSync(jsonPath, reportToJson(report));
  writeFileSync(mdPath, `${report.markdown_summary}\n`);

  console.log(report.markdown_summary);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main();
