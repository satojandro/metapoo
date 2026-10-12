import { BOUNTY_FUNDING_ENABLED } from "../../config";
import type { BountyFundingGate } from "./types";

/** Advisory NEAR storage prepaid shown next to MPOO award (not part of award). */
export const BOUNTY_NEAR_STORAGE_HINT = "0.05";

/** Advisory NEAR gas budget label (not part of award). */
export const BOUNTY_NEAR_GAS_HINT = "0.01";

export const FUNDING_CONFIRMATION_COPY =
  "Funding locks MPOO as an escrow liability on the bounty contract — not paint revenue. " +
  "NEAR storage deposit is required separately for create/propose writes. " +
  "Confirm only if you understand funds stay in escrow until award or sponsor refund.";

export const FUNDING_GATED_REASON =
  "Live funding is gated until the payout path is ready. " +
  "Set VITE_BOUNTY_FUNDING_ENABLED=true to unlock the fund CTA (still requires confirmation).";

export const FUNDING_ENABLED_REASON =
  "Funding CTA unlocked by VITE_BOUNTY_FUNDING_ENABLED. " +
  "MPOO moves only as escrow liability after you confirm; NEAR storage is separate.";

/**
 * Resolve the funding gate from env (or an explicit override for tests).
 * Default is disabled — do not enable reckless live funding.
 */
export function resolveFundingGate(
  fundingEnabled?: boolean,
): BountyFundingGate {
  const enabled = fundingEnabled ?? BOUNTY_FUNDING_ENABLED;
  if (enabled) {
    return {
      enabled: true,
      reason: FUNDING_ENABLED_REASON,
      confirmationCopy: FUNDING_CONFIRMATION_COPY,
    };
  }
  return {
    enabled: false,
    reason: FUNDING_GATED_REASON,
    confirmationCopy: FUNDING_CONFIRMATION_COPY,
  };
}

/** True only when the env flag is the string `"true"`. */
export function isBountyFundingEnabledFlag(raw: string | undefined): boolean {
  return (raw ?? "").trim() === "true";
}
