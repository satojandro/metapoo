/**
 * Select fixture (default) vs live bounty adapter from env.
 * Live never silently falls back to fixtures on RPC failure.
 */

import { BOUNTY_CONTRACT_ID, BOUNTY_FUNDING_ENABLED } from "../../config";
import { createFixtureBountyAdapter } from "./fixture-adapter";
import { createLiveBountyAdapter } from "./live-adapter";
import type { BountyAdapter, BountyAdapterMode } from "./types";

export interface SelectBountyAdapterOptions {
  /** When set, forces mode regardless of contract id (tests / overrides). */
  mode?: BountyAdapterMode;
  contractId?: string;
  fundingEnabled?: boolean;
}

/**
 * Default page wiring: fixture unless a bounty contract id is configured.
 * Passing `mode: "live"` with an empty contract id still builds the live
 * adapter so callers get an explicit CONTRACT_UNSET error — never fixtures.
 */
export function selectBountyAdapter(
  options: SelectBountyAdapterOptions = {},
): BountyAdapter {
  const contractId = (options.contractId ?? BOUNTY_CONTRACT_ID).trim();
  const fundingEnabled = options.fundingEnabled ?? BOUNTY_FUNDING_ENABLED;

  const mode: BountyAdapterMode =
    options.mode ?? (contractId ? "live" : "fixture");

  if (mode === "live") {
    return createLiveBountyAdapter({
      contractId,
      fundingEnabled,
    });
  }

  return createFixtureBountyAdapter({ fundingEnabled });
}

/** Convenience used by browse / detail / create mounts. */
export function createDefaultBountyAdapter(): BountyAdapter {
  return selectBountyAdapter();
}
