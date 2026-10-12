import {
  FIXTURE_BOUNTIES,
  FIXTURE_FORCE_FAIL_QUERY,
  getFixtureDetail,
} from "./fixtures";
import { isFundedOpportunity } from "./funded";
import type {
  BountyAdapter,
  BountyDetailResult,
  BountyListFilters,
  BountyListResult,
} from "./types";

/**
 * Fixture-backed bounty adapter for Wave 0 UI.
 * Does not claim live escrow. Live mode must never silently fall back here.
 */
export function createFixtureBountyAdapter(): BountyAdapter {
  return {
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
          // Funded-only with no matches among filters → NO_MATCHES when
          // there are funded items that simply don't match the query/status.
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
