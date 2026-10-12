/**
 * Pressure / paint-cost overlay hooks and DOM wiring (Journey C).
 * Region legend uses numeric costs plus non-color pattern indicators
 * so heat is not conveyed by color alone.
 */

import type { QuoteView } from "@shared/protocol/board.ts";
import { FIXTURE_PRESSURE_CONFIG, regionIdForCell } from "../../pressure-quote";
import { formatToiletAmount, summarizeQuoteTiming } from "./format";

export interface PressureOverlayHooks {
  /** Whether the paint-cost overlay toggle is available (paid mode on). */
  available: boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Refresh region summary for the selected cell (or clear). */
  setSelectedQuote(quote: QuoteView | null, options?: { nowNs?: string; demoLabel?: string | null }): void;
  /** Tear down listeners / abort in-flight quote fetches owned by the overlay. */
  dispose(): void;
}

export interface PressureOverlayElements {
  toggle: HTMLInputElement;
  /** Outer section (shown whenever paid mode is available). */
  panel: HTMLElement;
  /** Legend + region details (shown only when the Paint cost toggle is on). */
  legend: HTMLElement;
  quoteSummary: HTMLElement;
  demoBanner: HTMLElement;
}

/** Pattern / glyph bands — non-color indicators paired with numeric costs. */
export const PRESSURE_BANDS: Array<{
  id: string;
  /** Inclusive lower bound (TOILET decimal). */
  minCost: number;
  /** Exclusive upper bound; omit for open-ended. */
  maxCostExclusive?: number;
  label: string;
  /** Textual pattern marker (not color-only). */
  pattern: string;
}> = [
  { id: "cool", minCost: 0, maxCostExclusive: 12, label: "Quiet", pattern: "···" },
  { id: "warm", minCost: 12, maxCostExclusive: 20, label: "Active", pattern: "///" },
  { id: "hot", minCost: 20, maxCostExclusive: 35, label: "Busy", pattern: "###" },
  { id: "peak", minCost: 35, label: "Peak", pattern: "■■■" },
];

export function bandForCost(cost: string): (typeof PRESSURE_BANDS)[number] {
  const value = Number(cost);
  for (const band of PRESSURE_BANDS) {
    if (value < band.minCost) continue;
    if (band.maxCostExclusive === undefined || value < band.maxCostExclusive) {
      return band;
    }
  }
  return PRESSURE_BANDS[PRESSURE_BANDS.length - 1]!;
}

export function renderLegendHtml(): string {
  const rows = PRESSURE_BANDS.map((band) => {
    const range =
      band.maxCostExclusive === undefined
        ? `${band.minCost}+ TOILET`
        : `${band.minCost}–${band.maxCostExclusive - 1} TOILET`;
    return `<li data-band="${band.id}"><span class="pressure-pattern" aria-hidden="true">${band.pattern}</span> <strong>${band.label}</strong> — ${range}</li>`;
  }).join("");
  return `
    <p class="pressure-legend-intro">
      Activity raises local cost; quiet time cools it. Costs are TOILET units — not account fairness or a profit guarantee.
    </p>
    <ul class="pressure-legend-list">${rows}</ul>
  `;
}

export function formatSelectedQuoteSummary(
  quote: QuoteView,
  options?: { nowNs?: string; demoLabel?: string | null },
): string {
  const nowNs = options?.nowNs ?? `${BigInt(Date.now()) * 1_000_000n}`;
  const timing = summarizeQuoteTiming(quote, nowNs);
  const band = bandForCost(quote.cost);
  const parts = [
    `Region ${quote.regionId} · ${formatToiletAmount(quote.cost)} (${band.label} ${band.pattern})`,
    `Balance ${formatToiletAmount(quote.balance)}`,
    `Max authorized ${formatToiletAmount(quote.cost)}`,
    `Quote ${timing.ageLabel}; ${timing.expiryLabel}`,
    "Network gas is separate from TOILET paint cost.",
  ];
  if (options?.demoLabel) {
    parts.push(options.demoLabel);
  }
  return parts.join(" · ");
}

export function createPressureOverlayHooks(
  elements: PressureOverlayElements | null,
  options?: { available?: boolean },
): PressureOverlayHooks {
  let enabled = false;
  const available = options?.available ?? false;
  const cleanups: Array<() => void> = [];

  function applyOverlayVisibility(): void {
    if (!elements) {
      return;
    }
    // Outer panel stays available whenever paid mode is on; legend details follow the toggle.
    elements.panel.hidden = !available;
    elements.legend.hidden = !enabled;
    elements.quoteSummary.hidden = !enabled;
  }

  if (elements) {
    elements.toggle.disabled = !available;
    elements.toggle.checked = false;
    elements.demoBanner.hidden = true;
    if (available) {
      elements.legend.innerHTML = renderLegendHtml();
      const onToggle = () => {
        enabled = elements.toggle.checked;
        applyOverlayVisibility();
      };
      elements.toggle.addEventListener("change", onToggle);
      cleanups.push(() => elements.toggle.removeEventListener("change", onToggle));
    } else {
      elements.legend.replaceChildren();
      elements.quoteSummary.textContent = "";
    }
    applyOverlayVisibility();
  }

  return {
    available,
    setEnabled(next) {
      enabled = next && available;
      if (elements) {
        elements.toggle.checked = enabled;
        applyOverlayVisibility();
      }
    },
    isEnabled() {
      return enabled && available;
    },
    setSelectedQuote(quote, quoteOptions) {
      if (!elements || !available) {
        return;
      }
      if (!quote) {
        elements.quoteSummary.textContent = enabled
          ? "Select a square to see its TOILET placement cost."
          : "";
        return;
      }
      elements.quoteSummary.textContent = formatSelectedQuoteSummary(quote, quoteOptions);
      if (quoteOptions?.demoLabel) {
        elements.demoBanner.hidden = false;
        elements.demoBanner.textContent = quoteOptions.demoLabel;
      }
    },
    dispose() {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
      enabled = false;
    },
  };
}

/** Sample region costs for overlay tooling / tests (fixture geometry). */
export function sampleRegionCostLabel(x: number, y: number): string {
  const regionId = regionIdForCell(x, y, 128, FIXTURE_PRESSURE_CONFIG.regionSize);
  const base = Number(FIXTURE_PRESSURE_CONFIG.baseCost);
  const cost = Math.min(
    Number(FIXTURE_PRESSURE_CONFIG.maxCost),
    base + (regionId % 5),
  );
  const band = bandForCost(String(cost));
  return `R${regionId} ${cost} TOILET ${band.pattern}`;
}
