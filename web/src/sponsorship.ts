import { SPONSORSHIP_ENABLED } from "./config";

/**
 * Sponsorship means someone else pays network gas for the player.
 * That path is not built yet. Even if the feature flag is flipped on by
 * mistake, we fall back to the ordinary wallet path.
 */

export interface SponsorshipStatus {
  /** Product flag from config / env. */
  flagEnabled: boolean;
  /** True only when a real sponsor service is ready. Always false in MVP. */
  available: boolean;
  /** Short sentence for the fees panel before the user submits. */
  message: string;
  /** Which submit path the UI should take. */
  path: "ordinary_wallet" | "sponsored";
}

/** MVP: no sponsor service exists, so availability is always false. */
export function isSponsorshipAvailable(): boolean {
  return false;
}

export function describeSponsorship(): SponsorshipStatus {
  const available = isSponsorshipAvailable();
  const flagEnabled = SPONSORSHIP_ENABLED;

  if (!flagEnabled) {
    return {
      flagEnabled: false,
      available: false,
      path: "ordinary_wallet",
      message:
        "Gas sponsorship is off. No sponsor key is in this project. The game does not charge an MPOO or NEAR application fee. Your wallet may still pay network gas when you draw.",
    };
  }

  if (!available) {
    return {
      flagEnabled: true,
      available: false,
      path: "ordinary_wallet",
      message:
        "Sponsorship is flagged on, but no sponsor service is available. This page uses the ordinary wallet path instead. It does not claim a sponsored or cross-chain flow.",
    };
  }

  // Unreachable in MVP; kept so a future maintainer has one place to extend.
  return {
    flagEnabled: true,
    available: true,
    path: "sponsored",
    message: "Sponsorship is available for this draw.",
  };
}
