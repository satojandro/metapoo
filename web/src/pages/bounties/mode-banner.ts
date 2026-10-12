import { DEMO_DATA_LABEL, createDemoBanner } from "./demo-banner";
import type { BountyAdapterMode } from "./types";

export const LIVE_VIEWS_LABEL =
  "Live contract views — funding gated; MPOO is escrow liability, not paint revenue";

/**
 * Fixture mode keeps the Wave 0 demo banner.
 * Live mode shows a non-demo status (no “Demo data” claim).
 */
export function createModeBanner(mode: BountyAdapterMode): HTMLElement {
  if (mode === "fixture") {
    return createDemoBanner();
  }
  const banner = document.createElement("p");
  banner.className = "mpoo-bounties__demo mpoo-bounties__demo--live";
  banner.setAttribute("role", "status");
  banner.textContent = LIVE_VIEWS_LABEL;
  return banner;
}

export { DEMO_DATA_LABEL };
