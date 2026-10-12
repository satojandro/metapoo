/**
 * Pressure / paint-cost overlay (Journey C — Worker F).
 */

export {
  createPressureOverlayHooks,
  bandForCost,
  formatSelectedQuoteSummary,
  renderLegendHtml,
  sampleRegionCostLabel,
  PRESSURE_BANDS,
  type PressureOverlayHooks,
  type PressureOverlayElements,
} from "./overlay";

export {
  formatDurationNs,
  formatQuoteAge,
  formatQuoteExpiry,
  formatToiletAmount,
  summarizeQuoteTiming,
  type QuoteTimingSummary,
} from "./format";

export {
  PRICE_CHANGED_TITLE,
  PRICE_CHANGED_MESSAGE,
  checkMaxCostAuthorization,
  revalidateQueuedPaint,
  queueStopMessage,
  type MaxCostCheckResult,
  type QueueStopReason,
} from "./max-cost-ux";
