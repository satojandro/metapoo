/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountBrowse } from "./browse";
import type {
  BountyAdapter,
  BountyListFilters,
  BountyListResult,
  BountySummary,
} from "./types";

function sampleSummary(id: string, title: string): BountySummary {
  return {
    id,
    title,
    briefText: title,
    sponsorAccountId: "sponsor.testnet",
    approverAccountId: "sponsor.testnet",
    boardId: "board.mpoo.testnet",
    crop: { x: 0, y: 0, width: 16, height: 16 },
    awardAmount: "1000",
    tokenSymbol: "MPOO",
    status: "ACTIVE",
    escrowConfirmed: true,
    fundedAtNs: "1",
    fundByNs: "2",
    submitByNs: "3",
    reviewByNs: "4",
    templateId: null,
  };
}

describe("browse Load more continuation", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("treats a final NO_MATCHES page as completion after a truncated first response", async () => {
    const listBounties = vi.fn(
      async (filters: BountyListFilters): Promise<BountyListResult> => {
        if (filters.fromIndex == null) {
          // First page: truncated, no filter matches yet.
          return {
            ok: true,
            items: [],
            truncated: true,
            nextFromIndex: 2,
          };
        }
        expect(filters.fromIndex).toBe(2);
        // Final pages exhausted; nothing matched anywhere.
        return { ok: false, error: "NO_MATCHES" };
      },
    );

    const adapter: BountyAdapter = {
      mode: "live",
      listBounties,
      getBounty: async () => ({ ok: false, error: "NOT_FOUND" }),
      getFundingGate: () => ({
        enabled: false,
        reason: "gated",
        confirmationCopy: "confirm",
      }),
    };

    const root = document.createElement("div");
    document.body.append(root);
    const dispose = mountBrowse(root, { bounties: adapter });

    // Initial load settles.
    await vi.waitFor(() => {
      expect(listBounties).toHaveBeenCalledTimes(1);
      expect(root.textContent).toMatch(/partial/i);
      expect(root.textContent).toMatch(/Load more/);
    });

    const loadMore = root.querySelector<HTMLButtonElement>(
      ".mpoo-bounties__callout--partial button",
    );
    expect(loadMore).toBeTruthy();
    loadMore!.click();

    await vi.waitFor(() => {
      expect(listBounties).toHaveBeenCalledTimes(2);
      // Partial notice and cursor cleared; complete empty state shown.
      expect(root.querySelector(".mpoo-bounties__callout--partial")).toBeNull();
      expect(root.textContent).toMatch(/No bounties match these filters/);
      expect(root.textContent).not.toMatch(/Could not load more/);
    });

    dispose();
  });

  it("keeps accumulated matches when Load more ends with NO_MATCHES", async () => {
    const first = sampleSummary("1", "Needle one");
    const listBounties = vi.fn(
      async (filters: BountyListFilters): Promise<BountyListResult> => {
        if (filters.fromIndex == null) {
          return {
            ok: true,
            items: [first],
            truncated: true,
            nextFromIndex: 5,
          };
        }
        return { ok: false, error: "NO_MATCHES" };
      },
    );

    const adapter: BountyAdapter = {
      mode: "live",
      listBounties,
      getBounty: async () => ({ ok: false, error: "NOT_FOUND" }),
      getFundingGate: () => ({
        enabled: false,
        reason: "gated",
        confirmationCopy: "confirm",
      }),
    };

    const root = document.createElement("div");
    document.body.append(root);
    const dispose = mountBrowse(root, { bounties: adapter });

    await vi.waitFor(() => {
      expect(root.textContent).toMatch(/Needle one/);
      expect(root.textContent).toMatch(/Load more/);
    });

    root
      .querySelector<HTMLButtonElement>(".mpoo-bounties__callout--partial button")!
      .click();

    await vi.waitFor(() => {
      expect(listBounties).toHaveBeenCalledTimes(2);
      expect(root.querySelector(".mpoo-bounties__callout--partial")).toBeNull();
      expect(root.textContent).toMatch(/Needle one/);
      expect(root.textContent).not.toMatch(/Could not load more/);
    });

    dispose();
  });
});
