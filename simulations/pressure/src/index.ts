export {
  regionColumns,
  regionRows,
  regionCount,
  regionId,
  regionBounds,
  isInsideBoard,
} from "./geometry.ts";
export {
  PressureConfigError,
  assertValidConfig,
  boundElapsedForDecay,
  cooledHeatAt,
  placementCost,
  quoteRegion,
  applySuccessfulHeat,
  coldRegion,
  evaluatePlacementMath,
} from "./math.ts";
export { createSimulator, runScenario } from "./simulate.ts";
export type { SimulatorOptions, SimulationResult, StepRecord } from "./simulate.ts";
export { buildReport, reportToJson } from "./report.ts";
export {
  FIXTURE_CONFIG,
  FIXTURE_GEOMETRY,
  toiletString,
  parseToilet,
  configFromJson,
  configToJson,
  regionFromJson,
  regionToJson,
} from "./types.ts";
export type {
  PressureConfig,
  PressureConfigJson,
  BoardGeometry,
  RegionState,
  RegionStateJson,
  PixelState,
  PlacementIntent,
  PlacementOutcome,
  PlacementRejectReason,
  PressureReport,
} from "./types.ts";
