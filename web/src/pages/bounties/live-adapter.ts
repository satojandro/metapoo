/**
 * Live bounty adapter — view calls only against the escrow contract.
 * Does not broadcast funding. Funding CTA stays gated unless env unlocks it.
 */

import { resolveFundingGate } from "./funding-gate";
import { BountyContractUnsetError, bountyViewFunction } from "./rpc";
import type {
  BountyAdapter,
  BountyDetailResult,
  BountyFundingGate,
  BountyListFilters,
  BountyListResult,
} from "./types";
import {
  mapContractBountyToDetail,
  mapContractBountyToSummary,
  type ContractBountyView,
  type ContractClaimView,
  type ContractListPage,
  type ContractSubmissionView,
} from "./view-map";
import { isFundedOpportunity } from "./funded";

const LIST_PAGE_LIMIT = 50;
/** Safety cap so a runaway contract cannot hang the UI. */
const MAX_LIST_PAGES = 20;

export interface LiveBountyAdapterOptions {
  /** Escrow contract account. Empty → clear CONTRACT_UNSET errors. */
  contractId: string;
  /** Override funding gate (tests). Defaults to env via resolveFundingGate(). */
  fundingEnabled?: boolean;
  /** Injected view caller (tests). */
  view?: <T>(
    methodName: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  /** Override page size (tests). */
  pageLimit?: number;
  /** Override max pages walked (tests). */
  maxPages?: number;
}

export function createLiveBountyAdapter(
  options: LiveBountyAdapterOptions,
): BountyAdapter {
  const contractId = options.contractId.trim();
  const pageLimit = options.pageLimit ?? LIST_PAGE_LIMIT;
  const maxPages = options.maxPages ?? MAX_LIST_PAGES;
  const view =
    options.view ??
    (<T>(methodName: string, args: Record<string, unknown> = {}) =>
      bountyViewFunction<T>(methodName, args, { contractId }));

  const fundingGate: BountyFundingGate = resolveFundingGate(
    options.fundingEnabled,
  );

  const ensureConfigured = (): void => {
    if (!contractId) {
      throw new BountyContractUnsetError();
    }
  };

  return {
    mode: "live",

    getFundingGate(): BountyFundingGate {
      return fundingGate;
    },

    async listBounties(filters: BountyListFilters): Promise<BountyListResult> {
      try {
        ensureConfigured();
        const startIndex = filters.fromIndex ?? 0;
        const pages = await fetchAllPages<ContractBountyView>(
          (fromIndex, limit) =>
            view<ContractListPage<ContractBountyView>>("list_bounties", {
              from_index: fromIndex,
              limit,
            }),
          pageLimit,
          maxPages,
          startIndex,
        );
        let items = pages.items.map(mapContractBountyToSummary);

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

        // Truncated pages must not collapse into a false "complete" empty/NO_MATCHES.
        if (pages.truncated) {
          return {
            ok: true,
            items,
            truncated: true,
            nextFromIndex: pages.nextFromIndex,
          };
        }

        if (items.length === 0) {
          if (pages.total === 0 || pages.items.length === 0) {
            return { ok: false, error: "EMPTY" };
          }
          return { ok: false, error: "NO_MATCHES" };
        }
        return {
          ok: true,
          items,
          truncated: undefined,
          nextFromIndex: null,
        };
      } catch (err) {
        return mapListError(err);
      }
    },

    async getBounty(id: string): Promise<BountyDetailResult> {
      try {
        ensureConfigured();
        const bounty = await view<ContractBountyView>("get_bounty", {
          bounty_id: id,
        });
        const submissionsPage = await fetchAllPages<ContractSubmissionView>(
          (fromIndex, limit) =>
            view<ContractListPage<ContractSubmissionView>>("list_submissions", {
              bounty_id: id,
              from_index: fromIndex,
              limit,
            }),
          pageLimit,
          maxPages,
        );
        const claimsPage = await fetchAllPages<ContractClaimView>(
          (fromIndex, limit) =>
            view<ContractListPage<ContractClaimView>>("list_claims", {
              bounty_id: id,
              from_index: fromIndex,
              limit,
            }),
          pageLimit,
          maxPages,
        );
        const truncated = submissionsPage.truncated || claimsPage.truncated;
        return {
          ok: true,
          bounty: mapContractBountyToDetail(
            bounty,
            submissionsPage.items,
            claimsPage.items,
          ),
          truncated: truncated || undefined,
        };
      } catch (err) {
        return mapDetailError(err);
      }
    },
  };
}

interface FetchedPages<T> {
  items: T[];
  total: number;
  truncated: boolean;
  nextFromIndex: number | null;
}

/**
 * Walk `next_from_index` until exhausted or `maxPages` is hit.
 * When truncated, `nextFromIndex` is the index the caller should resume from.
 */
export async function fetchAllPages<T>(
  fetchPage: (
    fromIndex: number,
    limit: number,
  ) => Promise<ContractListPage<T>>,
  pageLimit: number,
  maxPages: number,
  startIndex = 0,
): Promise<FetchedPages<T>> {
  const items: T[] = [];
  let fromIndex = startIndex;
  let total = 0;
  let pages = 0;
  let nextFromIndex: number | null = null;

  while (pages < maxPages) {
    const page = await fetchPage(fromIndex, pageLimit);
    total = page.total;
    items.push(...page.items);
    pages += 1;
    if (page.next_from_index == null) {
      nextFromIndex = null;
      break;
    }
    nextFromIndex = page.next_from_index;
    fromIndex = page.next_from_index;
  }

  const truncated = nextFromIndex != null;
  return { items, total, truncated, nextFromIndex };
}

function mapListError(err: unknown): BountyListResult {
  if (err instanceof BountyContractUnsetError) {
    return {
      ok: false,
      error: "SERVICE_UNAVAILABLE",
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: "SERVICE_UNAVAILABLE",
    message: `Live bounty views failed: ${message}`,
  };
}

function mapDetailError(err: unknown): BountyDetailResult {
  if (err instanceof BountyContractUnsetError) {
    return {
      ok: false,
      error: "CONTRACT_UNSET",
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/not.?found|does not exist|NOT_FOUND/i.test(message)) {
    return { ok: false, error: "NOT_FOUND", message };
  }
  return {
    ok: false,
    error: "SERVICE_UNAVAILABLE",
    message: `Live bounty views failed: ${message}`,
  };
}
