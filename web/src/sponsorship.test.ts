import { describe, expect, it } from "vitest";
import { describeSponsorship, isSponsorshipAvailable } from "./sponsorship";

describe("sponsorship", () => {
  it("never claims an available sponsor service in the MVP", () => {
    expect(isSponsorshipAvailable()).toBe(false);
    const status = describeSponsorship();
    expect(status.available).toBe(false);
    expect(status.path).toBe("ordinary_wallet");
    expect(status.message.toLowerCase()).not.toMatch(/cross-chain/);
  });
});
