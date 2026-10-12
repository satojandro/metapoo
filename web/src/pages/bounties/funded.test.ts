import { describe, expect, it } from "vitest";
import { FIXTURE_BOUNTIES } from "./fixtures";
import { fundingDisplay, isFundedOpportunity } from "./funded";
import type { BountySummary } from "./types";

function base(
  overrides: Partial<BountySummary> = {},
): Pick<BountySummary, "status" | "escrowConfirmed" | "fundedAtNs"> {
  return {
    status: "ACTIVE",
    escrowConfirmed: true,
    fundedAtNs: "1759276800000000000",
    ...overrides,
  };
}

describe("fundingDisplay", () => {
  it("labels Funded only with confirmed escrow and a non-draft lifecycle", () => {
    expect(fundingDisplay(base()).label).toBe("Funded");
    expect(fundingDisplay(base({ status: "REVIEW" })).kind).toBe("funded");
    expect(fundingDisplay(base({ status: "AWARDED" })).kind).toBe("funded");
    expect(fundingDisplay(base({ status: "EXPIRED" })).kind).toBe("funded");
  });

  it("never labels DRAFT as Funded, even if a buggy flag is set", () => {
    expect(
      fundingDisplay(
        base({
          status: "DRAFT",
          escrowConfirmed: true,
          fundedAtNs: "1759276800000000000",
        }),
      ).label,
    ).toBe("Unfunded draft");
  });

  it("requires escrowConfirmed and fundedAtNs", () => {
    expect(
      fundingDisplay(
        base({ escrowConfirmed: false, fundedAtNs: "1759276800000000000" }),
      ).kind,
    ).toBe("unfunded_draft");
    expect(
      fundingDisplay(base({ escrowConfirmed: true, fundedAtNs: null })).kind,
    ).toBe("unfunded_draft");
  });

  it("labels cancelled unfunded drafts separately", () => {
    expect(
      fundingDisplay(
        base({
          status: "CANCELLED",
          escrowConfirmed: false,
          fundedAtNs: null,
        }),
      ).label,
    ).toBe("Cancelled (unfunded)");
  });
});

describe("fixture funded-vs-draft rules", () => {
  it("exposes both funded opportunities and an unfunded draft in fixtures", () => {
    const funded = FIXTURE_BOUNTIES.filter(isFundedOpportunity);
    const drafts = FIXTURE_BOUNTIES.filter(
      (b) => fundingDisplay(b).kind === "unfunded_draft",
    );
    expect(funded.length).toBeGreaterThan(0);
    expect(drafts.some((b) => b.status === "DRAFT")).toBe(true);
    expect(funded.every((b) => b.escrowConfirmed && b.fundedAtNs !== null)).toBe(
      true,
    );
    expect(funded.every((b) => b.status !== "DRAFT")).toBe(true);
  });
});
