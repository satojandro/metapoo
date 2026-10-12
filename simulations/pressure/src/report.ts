import type { SimulationResult } from "./simulate.ts";
import type { PressureReport } from "./types.ts";
import { toiletString } from "./types.ts";

function concentrationMap(
  spend: Map<string, bigint>,
  placements: Map<string, number>,
): Record<string, { spend: string; placements: number }> {
  const keys = new Set([...spend.keys(), ...placements.keys()]);
  const out: Record<string, { spend: string; placements: number }> = {};
  for (const key of [...keys].sort()) {
    out[key] = {
      spend: toiletString(spend.get(key) ?? 0n),
      placements: placements.get(key) ?? 0,
    };
  }
  return out;
}

function formatConcentration(
  title: string,
  map: Record<string, { spend: string; placements: number }>,
): string {
  const lines = Object.entries(map).map(
    ([name, row]) => `  - ${name}: spend ${row.spend} TOILET across ${row.placements} placements`,
  );
  if (lines.length === 0) {
    return `${title}: (none)`;
  }
  return `${title}:\n${lines.join("\n")}`;
}

/** Build the JSON + markdown summary fields required by the pressure spec. */
export function buildReport(
  scenario: string,
  result: SimulationResult,
  priceThreshold: bigint,
): PressureReport {
  const concentration_by_operator = concentrationMap(
    result.spend_by_operator,
    result.placements_by_operator,
  );
  const concentration_by_account = concentrationMap(
    result.spend_by_account,
    result.placements_by_account,
  );

  const spend = toiletString(result.total_spend);
  const restoration = toiletString(result.restoration_cost);
  const timeAbove = toiletString(result.time_above_threshold_seconds);
  const threshold = toiletString(priceThreshold);

  const markdown_summary = [
    `# Pressure simulation: ${scenario}`,
    "",
    `- **Spend:** ${spend} TOILET`,
    `- **Successful placements:** ${result.successful_placements}`,
    `- **Rejected placements:** ${result.rejected_placements}`,
    `- **Restoration cost:** ${restoration} TOILET`,
    `- **Time at/above price threshold (${threshold}):** ${timeAbove} s`,
    "",
    formatConcentration("Concentration by operator", concentration_by_operator),
    "",
    formatConcentration("Concentration by account", concentration_by_account),
    "",
    "_Simulated outcomes are not measured player retention._",
  ].join("\n");

  return {
    scenario,
    spend,
    successful_placements: result.successful_placements,
    rejected_placements: result.rejected_placements,
    restoration_cost: restoration,
    time_above_threshold_seconds: timeAbove,
    price_threshold: threshold,
    concentration_by_operator,
    concentration_by_account,
    markdown_summary,
  };
}

export function reportToJson(report: PressureReport): string {
  const { markdown_summary: _md, ...rest } = report;
  return `${JSON.stringify({ ...rest, markdown_summary: report.markdown_summary }, null, 2)}\n`;
}
