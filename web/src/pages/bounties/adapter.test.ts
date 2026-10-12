import { describe, expect, it, vi } from "vitest";
import { selectBountyAdapter } from "./adapter";
import { createFixtureBountyAdapter } from "./fixture-adapter";
import {
  FUNDING_GATED_REASON,
  isBountyFundingEnabledFlag,
  resolveFundingGate,
} from "./funding-gate";
import { createLiveBountyAdapter } from "./live-adapter";
import type { ContractBountyView, ContractClaimView, ContractSubmissionView } from "./view-map";
import {
  mapContractBountyToDetail,
  mapContractBountyToSummary,
  mapContractClaim,
  mapContractSubmission,
  mapBountyStatus,
  requireDecimalString,
} from "./view-map";

const sampleBounty: ContractBountyView = {
  id: "7",
  network_id: "testnet",
  escrow_account_id: "bounties.escrow.testnet",
  sponsor: "sponsor.testnet",
  board_id: "board-main",
  crop: { x: 1, y: 2, width: 8, height: 8 },
  brief_uri: "Paint a calm corner",
  brief_hash: "sha256:abc",
  award_amount: "1000",
  terms_version: "1",
  created_at_ns: "1759276800000000000",
  fund_by_ns: "1759363200000000000",
  submit_by_ns: "1760227200000000000",
  review_by_ns: "1760832000000000000",
  status: "ACTIVE",
  funded_at_ns: "1759280000000000000",
  winning_submission_id: null,
  escrow_held: "1000",
};

const sampleSubmission: ContractSubmissionView = {
  id: "3",
  bounty_id: "7",
  proposer: "artist.testnet",
  snapshot_id: "snap-1",
  manifest_hash: "sha256:m",
  crop: { x: 1, y: 2, width: 8, height: 8 },
  note_hash: "sha256:n",
  recipients: [
    { account_id: "artist.testnet", share_bps: 6000 },
    { account_id: "helper.testnet", share_bps: 4000 },
  ],
  consent_digest: "sha256:consent",
  approved_accounts: ["artist.testnet", "helper.testnet"],
  state: "FINALIZED",
  created_at_ns: "1759300000000000000",
};

const sampleClaim: ContractClaimView = {
  id: "9",
  bounty_id: "7",
  beneficiary: "artist.testnet",
  amount: "600",
  kind: "AWARD",
  status: "AVAILABLE",
  attempt_id: null,
};

describe("selectBountyAdapter", () => {
  it("defaults to fixture when contract id is empty", () => {
    const adapter = selectBountyAdapter({
      contractId: "",
      fundingEnabled: false,
    });
    expect(adapter.mode).toBe("fixture");
    expect(adapter.getFundingGate().enabled).toBe(false);
  });

  it("selects live when contract id is set", () => {
    const adapter = selectBountyAdapter({
      contractId: "bounties.example.testnet",
      fundingEnabled: false,
    });
    expect(adapter.mode).toBe("live");
  });

  it("honours explicit fixture mode even if a contract id is present", () => {
    const adapter = selectBountyAdapter({
      mode: "fixture",
      contractId: "bounties.example.testnet",
    });
    expect(adapter.mode).toBe("fixture");
  });

  it("forced live with empty contract id returns CONTRACT_UNSET (no fixture fallback)", async () => {
    const adapter = selectBountyAdapter({
      mode: "live",
      contractId: "",
    });
    expect(adapter.mode).toBe("live");
    const detail = await adapter.getBounty("1");
    expect(detail.ok).toBe(false);
    if (!detail.ok) {
      expect(detail.error).toBe("CONTRACT_UNSET");
      expect(detail.message).toMatch(/VITE_BOUNTY_CONTRACT_ID/);
    }
  });
});

describe("funding gate", () => {
  it("treats only the string true as enabled", () => {
    expect(isBountyFundingEnabledFlag(undefined)).toBe(false);
    expect(isBountyFundingEnabledFlag("")).toBe(false);
    expect(isBountyFundingEnabledFlag("false")).toBe(false);
    expect(isBountyFundingEnabledFlag("true")).toBe(true);
  });

  it("disables the fund CTA by default with explicit gated copy", () => {
    const gate = resolveFundingGate(false);
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe(FUNDING_GATED_REASON);
    expect(gate.confirmationCopy).toMatch(/escrow liability/i);
  });

  it("unlocks the CTA only when fundingEnabled is true", () => {
    const gate = resolveFundingGate(true);
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toMatch(/VITE_BOUNTY_FUNDING_ENABLED/);
  });

  it("fixture adapter exposes the same gate policy", () => {
    expect(createFixtureBountyAdapter({ fundingEnabled: false }).getFundingGate().enabled).toBe(
      false,
    );
    expect(createFixtureBountyAdapter({ fundingEnabled: true }).getFundingGate().enabled).toBe(
      true,
    );
  });
});

describe("view mapping", () => {
  it("keeps amounts and ns as decimal strings", () => {
    expect(requireDecimalString("1000", "award")).toBe("1000");
    expect(requireDecimalString(0, "zero")).toBe("0");
    expect(() => requireDecimalString("1.5", "bad")).toThrow(/decimal/);
    expect(() => requireDecimalString("abc", "bad")).toThrow(/decimal/);
  });

  it("maps snake_case bounty views to page summaries", () => {
    const summary = mapContractBountyToSummary(sampleBounty);
    expect(summary.id).toBe("7");
    expect(summary.sponsorAccountId).toBe("sponsor.testnet");
    expect(summary.approverAccountId).toBe("sponsor.testnet");
    expect(summary.awardAmount).toBe("1000");
    expect(summary.fundByNs).toBe("1759363200000000000");
    expect(summary.escrowConfirmed).toBe(true);
    expect(summary.status).toBe("ACTIVE");
    expect(summary.crop).toEqual({ x: 1, y: 2, width: 8, height: 8 });
  });

  it("maps REVIEW and DRAFT statuses", () => {
    expect(mapBountyStatus("REVIEW")).toBe("REVIEW");
    expect(mapBountyStatus("draft")).toBe("DRAFT");
  });

  it("does not confirm escrow when held is zero", () => {
    const summary = mapContractBountyToSummary({
      ...sampleBounty,
      status: "DRAFT",
      funded_at_ns: null,
      escrow_held: "0",
    });
    expect(summary.escrowConfirmed).toBe(false);
    expect(summary.fundedAtNs).toBeNull();
  });

  it("maps submissions with consent and split recipients", () => {
    const sub = mapContractSubmission(sampleSubmission);
    expect(sub.state).toBe("FINALIZED");
    expect(sub.recipientCount).toBe(2);
    expect(sub.recipients).toEqual([
      { accountId: "artist.testnet", shareBps: 6000 },
      { accountId: "helper.testnet", shareBps: 4000 },
    ]);
    expect(sub.consentDigest).toBe("sha256:consent");
    expect(sub.approvedAccounts).toEqual([
      "artist.testnet",
      "helper.testnet",
    ]);
  });

  it("maps OPEN/WITHDRAWN aliases from older fixture labels", () => {
    expect(mapContractSubmission({ ...sampleSubmission, state: "OPEN" }).state).toBe(
      "OPEN",
    );
    expect(
      mapContractSubmission({ ...sampleSubmission, state: "PROPOSED" }).state,
    ).toBe("OPEN");
    expect(
      mapContractSubmission({ ...sampleSubmission, state: "WITHDRAWN" }).state,
    ).toBe("WITHDRAWN");
  });

  it("maps claims with decimal amounts", () => {
    const claim = mapContractClaim(sampleClaim);
    expect(claim).toEqual({
      id: "9",
      bountyId: "7",
      beneficiaryAccountId: "artist.testnet",
      amount: "600",
      kind: "AWARD",
      status: "AVAILABLE",
    });
  });

  it("builds detail with submissions and claims", () => {
    const detail = mapContractBountyToDetail(
      sampleBounty,
      [sampleSubmission],
      [sampleClaim],
    );
    expect(detail.escrowAccountId).toBe("bounties.escrow.testnet");
    expect(detail.escrowHeld).toBe("1000");
    expect(detail.submissions).toHaveLength(1);
    expect(detail.claims).toHaveLength(1);
    expect(detail.nearStorageDeposit).toMatch(/^\d+(\.\d+)?$/);
  });
});

describe("live adapter with mocked views", () => {
  it("lists and details from contract view mocks", async () => {
    const view = vi.fn(async (method: string) => {
      if (method === "list_bounties") {
        return {
          items: [sampleBounty],
          from_index: 0,
          limit: 50,
          total: 1,
          next_from_index: null,
        };
      }
      if (method === "get_bounty") {
        return sampleBounty;
      }
      if (method === "list_submissions") {
        return {
          items: [sampleSubmission],
          from_index: 0,
          limit: 50,
          total: 1,
          next_from_index: null,
        };
      }
      if (method === "list_claims") {
        return {
          items: [sampleClaim],
          from_index: 0,
          limit: 50,
          total: 1,
          next_from_index: null,
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const adapter = createLiveBountyAdapter({
      contractId: "bounties.mock.testnet",
      fundingEnabled: false,
      view: view as never,
    });

    const list = await adapter.listBounties({
      fundedOnly: true,
      status: "ALL",
      query: "",
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.items[0]?.id).toBe("7");
      expect(list.items[0]?.awardAmount).toBe("1000");
    }

    const detail = await adapter.getBounty("7");
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.bounty.submissions[0]?.consentDigest).toBe("sha256:consent");
      expect(detail.bounty.claims[0]?.amount).toBe("600");
    }

    expect(adapter.getFundingGate().enabled).toBe(false);
    expect(view).toHaveBeenCalled();
  });

  it("surfaces a clear error when contract id is unset", async () => {
    const adapter = createLiveBountyAdapter({
      contractId: "",
      fundingEnabled: false,
    });
    const list = await adapter.listBounties({
      fundedOnly: false,
      status: "ALL",
      query: "",
    });
    expect(list.ok).toBe(false);
    if (!list.ok) {
      expect(list.message).toMatch(/VITE_BOUNTY_CONTRACT_ID/);
    }
  });

  it("follows next_from_index across pages before filtering", async () => {
    const page1 = {
      ...sampleBounty,
      id: "1",
      brief_uri: "Find me later",
    };
    const page2 = {
      ...sampleBounty,
      id: "51",
      brief_uri: "Unique needle in page two",
      award_amount: "2000",
    };
    const view = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === "list_bounties") {
        const from = Number(args?.from_index ?? 0);
        if (from === 0) {
          return {
            items: [page1],
            from_index: 0,
            limit: 1,
            total: 2,
            next_from_index: 1,
          };
        }
        return {
          items: [page2],
          from_index: 1,
          limit: 1,
          total: 2,
          next_from_index: null,
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const adapter = createLiveBountyAdapter({
      contractId: "bounties.mock.testnet",
      fundingEnabled: false,
      view: view as never,
      pageLimit: 1,
    });

    const list = await adapter.listBounties({
      fundedOnly: false,
      status: "ALL",
      query: "needle",
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.id).toBe("51");
      expect(list.truncated).toBeUndefined();
    }
    expect(view).toHaveBeenCalledTimes(2);
  });

  it("exposes truncated when the page safety cap is hit", async () => {
    const view = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === "list_bounties") {
        const from = Number(args?.from_index ?? 0);
        return {
          items: [{ ...sampleBounty, id: String(from) }],
          from_index: from,
          limit: 1,
          total: 99,
          next_from_index: from + 1,
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const adapter = createLiveBountyAdapter({
      contractId: "bounties.mock.testnet",
      fundingEnabled: false,
      view: view as never,
      pageLimit: 1,
      maxPages: 2,
    });

    const list = await adapter.listBounties({
      fundedOnly: false,
      status: "ALL",
      query: "",
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.items).toHaveLength(2);
      expect(list.truncated).toBe(true);
      expect(list.nextFromIndex).toBe(2);
    }
  });

  it("keeps truncated info when filters match nothing in loaded pages", async () => {
    const view = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === "list_bounties") {
        const from = Number(args?.from_index ?? 0);
        return {
          items: [
            {
              ...sampleBounty,
              id: String(from),
              brief_uri: "unrelated draft text",
              status: "DRAFT",
              funded_at_ns: null,
              escrow_held: "0",
            },
          ],
          from_index: from,
          limit: 1,
          total: 99,
          next_from_index: from + 1,
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const adapter = createLiveBountyAdapter({
      contractId: "bounties.mock.testnet",
      fundingEnabled: false,
      view: view as never,
      pageLimit: 1,
      maxPages: 2,
    });

    const list = await adapter.listBounties({
      fundedOnly: true,
      status: "ACTIVE",
      query: "needle-that-is-not-here",
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.items).toHaveLength(0);
      expect(list.truncated).toBe(true);
      expect(list.nextFromIndex).toBe(2);
    }
  });

  it("resumes listBounties from fromIndex for continuation", async () => {
    const view = vi.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === "list_bounties") {
        const from = Number(args?.from_index ?? 0);
        expect(from).toBe(10);
        return {
          items: [{ ...sampleBounty, id: "10" }],
          from_index: 10,
          limit: 50,
          total: 11,
          next_from_index: null,
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const adapter = createLiveBountyAdapter({
      contractId: "bounties.mock.testnet",
      fundingEnabled: false,
      view: view as never,
    });

    const list = await adapter.listBounties({
      fundedOnly: false,
      status: "ALL",
      query: "",
      fromIndex: 10,
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.items[0]?.id).toBe("10");
      expect(list.truncated).toBeUndefined();
    }
  });
});
