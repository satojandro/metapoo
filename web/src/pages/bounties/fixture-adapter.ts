import { resolveFundingGate } from "./funding-gate";
import {
  FIXTURE_BOUNTIES,
  FIXTURE_FORCE_FAIL_QUERY,
  getFixtureDetail,
} from "./fixtures";
import { isFundedOpportunity } from "./funded";
import type {
  BountyAdapter,
  BountyDetailResult,
  BountyFundingGate,
  BountyListFilters,
  BountyListResult,
} from "./types";

export interface FixtureBountyAdapterOptions {
  fundingEnabled?: boolean;
}

/**
 * Fixture-backed bounty adapter for UI rehearsal.
 * Labelled demo data — no funds or NFTs. Live mode must never silently fall back here.
 */
export function createFixtureBountyAdapter(
  options: FixtureBountyAdapterOptions = {},
): BountyAdapter {
  const fundingGate: BountyFundingGate = resolveFundingGate(
    options.fundingEnabled,
  );

  return {
    mode: "fixture",

    getFundingGate(): BountyFundingGate {
      return fundingGate;
    },

    async listBounties(filters: BountyListFilters): Promise<BountyListResult> {
      if (filters.query === FIXTURE_FORCE_FAIL_QUERY) {
        return { ok: false, error: "SERVICE_UNAVAILABLE" };
      }

      let items = [...FIXTURE_BOUNTIES];

      if (filters.fundedOnly) {
        items = items.filter(isFundedOpportunity);
      }

      if (filters.status !== "ALL") {
        items = items.filter((b) => b.status === filters.status);
      }

      if (filters.query) {
        const q = filters.query.toLowerCase();
        items = items.filter(
          (b) =>
            b.title.toLowerCase().includes(q) ||
            b.briefText.toLowerCase().includes(q) ||
            b.id === filters.query ||
            b.sponsorAccountId.toLowerCase().includes(q),
        );
      }

      if (items.length === 0) {
        const hadAnyFunded = FIXTURE_BOUNTIES.some(isFundedOpportunity);
        if (filters.fundedOnly && !hadAnyFunded) {
          return { ok: false, error: "EMPTY" };
        }
        if (
          filters.query ||
          filters.status !== "ALL" ||
          (filters.fundedOnly && FIXTURE_BOUNTIES.length > 0)
        ) {
          const fundedPool = FIXTURE_BOUNTIES.filter(isFundedOpportunity);
          if (filters.fundedOnly && fundedPool.length === 0) {
            return { ok: false, error: "EMPTY" };
          }
          return { ok: false, error: "NO_MATCHES" };
        }
        return { ok: false, error: "EMPTY" };
      }

      return { ok: true, items };
    },

    async getBounty(id: string): Promise<BountyDetailResult> {
      if (id === "lag") {
        return { ok: false, error: "INDEX_LAG" };
      }
      if (id === "down") {
        return { ok: false, error: "SERVICE_UNAVAILABLE" };
      }
      const bounty = getFixtureDetail(id);
      if (!bounty) {
        return { ok: false, error: "NOT_FOUND" };
      }
      return { ok: true, bounty };
    },
  };
}
