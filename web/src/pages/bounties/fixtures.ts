import type { BountyDetail, BountySummary } from "./types";

/**
 * Fixture Art Bounties for UI rehearsal only.
 * Label every screen: "Demo data — no funds or NFTs".
 */

const NS_DAY = "86400000000000";

function addNs(base: string, days: number): string {
  const value = BigInt(base) + BigInt(days) * BigInt(NS_DAY);
  return value.toString();
}

/** Fixed "now" for stable fixture relative deadlines (2026-10-01T00:00:00Z). */
export const FIXTURE_NOW_NS = "1759276800000000000";

const summaries: BountySummary[] = [
  {
    id: "1",
    title: "Stall door mural",
    briefText:
      'Paint a friendly toilet mascot in the crop. <script>alert("xss")</script> Keep colors bold.',
    sponsorAccountId: "sponsor.testnet",
    approverAccountId: "sponsor.testnet",
    boardId: "board-main",
    crop: { x: 40, y: 20, width: 24, height: 24 },
    awardAmount: "1000000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "ACTIVE",
    escrowConfirmed: true,
    fundedAtNs: addNs(FIXTURE_NOW_NS, -2),
    fundByNs: addNs(FIXTURE_NOW_NS, -1),
    submitByNs: addNs(FIXTURE_NOW_NS, 12),
    reviewByNs: addNs(FIXTURE_NOW_NS, 16),
    templateId: "tmpl-stall-mascot",
  },
  {
    id: "2",
    title: "Corner graffiti study",
    briefText: "Soft pastel wash across the lower-right corner. No executable media.",
    sponsorAccountId: "patron.alice.testnet",
    approverAccountId: "patron.alice.testnet",
    boardId: "board-main",
    crop: { x: 96, y: 96, width: 32, height: 32 },
    awardAmount: "500000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "REVIEW",
    escrowConfirmed: true,
    fundedAtNs: addNs(FIXTURE_NOW_NS, -20),
    fundByNs: addNs(FIXTURE_NOW_NS, -18),
    submitByNs: addNs(FIXTURE_NOW_NS, -2),
    reviewByNs: addNs(FIXTURE_NOW_NS, 4),
    templateId: null,
  },
  {
    id: "3",
    title: "Unfunded draft (local save)",
    briefText: "This draft has never received escrow. Do not label it Funded.",
    sponsorAccountId: "you.testnet",
    approverAccountId: "you.testnet",
    boardId: "board-main",
    crop: { x: 8, y: 8, width: 16, height: 16 },
    awardAmount: "250000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "DRAFT",
    escrowConfirmed: false,
    fundedAtNs: null,
    fundByNs: addNs(FIXTURE_NOW_NS, 5),
    submitByNs: addNs(FIXTURE_NOW_NS, 20),
    reviewByNs: addNs(FIXTURE_NOW_NS, 25),
    templateId: null,
  },
  {
    id: "4",
    title: "Awarded night scene",
    briefText: "Winning submission locked; claims are separate from this page stub.",
    sponsorAccountId: "collector.testnet",
    approverAccountId: "collector.testnet",
    boardId: "board-main",
    crop: { x: 0, y: 64, width: 40, height: 20 },
    awardAmount: "2000000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "AWARDED",
    escrowConfirmed: true,
    fundedAtNs: addNs(FIXTURE_NOW_NS, -40),
    fundByNs: addNs(FIXTURE_NOW_NS, -38),
    submitByNs: addNs(FIXTURE_NOW_NS, -10),
    reviewByNs: addNs(FIXTURE_NOW_NS, -5),
    templateId: "tmpl-night",
  },
  {
    id: "5",
    title: "Expired silent sponsor",
    briefText: "Review window passed with no acceptance. Refund path is contract-owned.",
    sponsorAccountId: "quiet.testnet",
    approverAccountId: "quiet.testnet",
    boardId: "board-main",
    crop: { x: 60, y: 10, width: 20, height: 20 },
    awardAmount: "750000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "EXPIRED",
    escrowConfirmed: true,
    fundedAtNs: addNs(FIXTURE_NOW_NS, -50),
    fundByNs: addNs(FIXTURE_NOW_NS, -48),
    submitByNs: addNs(FIXTURE_NOW_NS, -20),
    reviewByNs: addNs(FIXTURE_NOW_NS, -12),
    templateId: null,
  },
  {
    id: "6",
    title: "Cancelled before funding",
    briefText: "Terminal unfunded draft.",
    sponsorAccountId: "sponsor.testnet",
    approverAccountId: "sponsor.testnet",
    boardId: "board-main",
    crop: { x: 1, y: 1, width: 8, height: 8 },
    awardAmount: "100000000000000000000000",
    tokenSymbol: "MPOO (test)",
    status: "CANCELLED",
    escrowConfirmed: false,
    fundedAtNs: null,
    fundByNs: addNs(FIXTURE_NOW_NS, -3),
    submitByNs: addNs(FIXTURE_NOW_NS, 10),
    reviewByNs: addNs(FIXTURE_NOW_NS, 14),
    templateId: null,
  },
];

const details: Record<string, BountyDetail> = Object.fromEntries(
  summaries.map((summary) => {
    const detail: BountyDetail = {
      ...summary,
      termsVersion: "1",
      briefHash: `sha256:fixture-${summary.id}`,
      createdAtNs: addNs(FIXTURE_NOW_NS, -60),
      winningSubmissionId: summary.status === "AWARDED" ? "sub-9" : null,
      nearStorageDeposit: "0.05",
      nearGasBudget: "0.01",
      submissions:
        summary.id === "1"
          ? [
              {
                id: "sub-1",
                proposerAccountId: "artist.one.testnet",
                state: "PROPOSED",
                snapshotId: null,
                recipientCount: 2,
              },
            ]
          : summary.id === "2"
            ? [
                {
                  id: "sub-4",
                  proposerAccountId: "crew.lead.testnet",
                  state: "FINALIZED",
                  snapshotId: "snap-400",
                  recipientCount: 3,
                },
                {
                  id: "sub-5",
                  proposerAccountId: "solo.testnet",
                  state: "FINALIZED",
                  snapshotId: "snap-401",
                  recipientCount: 1,
                },
              ]
            : summary.id === "4"
              ? [
                  {
                    id: "sub-9",
                    proposerAccountId: "winner.testnet",
                    state: "FINALIZED",
                    snapshotId: "snap-900",
                    recipientCount: 2,
                  },
                ]
              : [],
    };
    return [summary.id, detail];
  }),
);

export const FIXTURE_BOUNTIES: readonly BountySummary[] = summaries;

export function getFixtureDetail(id: string): BountyDetail | null {
  return details[id] ?? null;
}

/** Simulate adapter outage when the filter query is exactly `__fail__`. */
export const FIXTURE_FORCE_FAIL_QUERY = "__fail__";
