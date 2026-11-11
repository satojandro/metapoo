// @vitest-environment happy-dom
/**
 * The approval window's captions, pinned per row of the owner-approved table (11 Nov 2026).
 * Every assertion here is about what the player reads, and each caption is built from the
 * transaction — never from an argument the game could choose.
 */
import { describe, expect, it } from "vitest";
import { reviewContractIntent, type ApprovalFacts } from "./intents";

const BOARD = "board.metapoo.testnet";
const STAKING = "staking.metapoo.testnet";
const TOILET = "toilet.metapoo.testnet";
const MPOO = "mpoo.nearlytrade.near";
const NEAR = 10n ** 24n;

const facts: ApprovalFacts = {
  walletAddress: "alice.testnet",
  boardContractId: BOARD,
  stakingContractId: STAKING,
  toiletTokenId: TOILET,
  mpooTokenId: MPOO,
  pricePerCreditYocto: (NEAR * 25n / 10_000n).toString(), // 0.0025 NEAR
  mpooPerCredit: (10n ** 18n * 4825n / 1000n).toString(), // 4.825 mPOO
  unstakeBurnBps: 1_000,
};

const call = (receiverId: string, methodName: string, args: unknown = {}, deposit = "0") => ({
  receiverId,
  actions: [{ type: "FunctionCall", params: { methodName, args: JSON.stringify(args), gas: "30000000000000", deposit } }],
});

const review = (transactions: unknown[], overrides: Partial<ApprovalFacts> = {}) =>
  reviewContractIntent(transactions, { ...facts, ...overrides });

describe("buying credits", () => {
  it("captions the NEAR purchase with the amount from the transaction", () => {
    const r = review([call(BOARD, "buy_credits_near", { min_credits: "10" }, (NEAR * 25n / 1000n).toString())])!;
    expect(r.title).toBe("Buy 10 credits");
    expect(r.rows.map((row) => row.label)).toEqual(["Pay", "To"]);
    expect(r.rows[0].value).toBe("0.025 NEAR");
    expect(r.rows[1].value).toBe("the Meta Poo wall");
    expect(r.approveLabel).toBe("Pay 0.025 NEAR");
  });

  it("shows the setup row and the total when registration is batched in", () => {
    const r = review([{
      receiverId: BOARD,
      actions: [
        { type: "FunctionCall", params: { methodName: "register_credit_account", args: "{}", gas: "30000000000000", deposit: (NEAR / 100n).toString() } },
        { type: "FunctionCall", params: { methodName: "buy_credits_near", args: "{}", gas: "30000000000000", deposit: (NEAR * 25n / 1000n).toString() } },
      ],
    }])!;
    expect(r.rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      "Credits: 0.025 NEAR",
      "One-time account setup: 0.01 NEAR",
      "Total: 0.035 NEAR",
      "To: the Meta Poo wall",
    ]);
    expect(r.approveLabel).toBe("Pay 0.035 NEAR");
  });

  it("captions a bare registration as its own step, with no credits claimed", () => {
    const r = review([call(BOARD, "register_credit_account", {}, (NEAR / 100n).toString())])!;
    expect(r.title).toBe("Set up your account");
    expect(r.rows.map((row) => row.label)).toEqual(["One-time account setup", "To"]);
    expect(r.approveLabel).toBe("Pay 0.01 NEAR");
  });

  it("leaves the credit count out rather than guessing when the price was not read", () => {
    const r = review([call(BOARD, "buy_credits_near", {}, (NEAR * 25n / 1000n).toString())], { pricePerCreditYocto: null })!;
    expect(r.title).toBe("Buy credits");
    expect(r.notes.join(" ")).toMatch(/price per credit couldn't be read/);
    expect(r.approveLabel).toBe("Pay 0.025 NEAR");
  });
});

describe("mPOO and TOILET transfer calls", () => {
  it("tells an mPOO credit purchase from a stake by token, receiver and msg", () => {
    const buy = review([call(MPOO, "ft_transfer_call", { receiver_id: BOARD, amount: (10n ** 18n * 48n).toString(), msg: '{"min_credits":"10"}' })])!;
    expect(buy.title).toBe("Buy 9 credits with mPOO");
    expect(buy.rows[0]).toEqual({ label: "Pay", value: "48 mPOO" });
    expect(buy.rows[1].value).toBe("the Meta Poo wall");

    const stake = review([call(TOILET, "ft_transfer_call", { receiver_id: STAKING, amount: (10n ** 18n * 607n).toString(), msg: "stake" })])!;
    expect(stake.title).toBe("Stake 607 TOILET");
    expect(stake.rows).toEqual([{ label: "To", value: "the staking pool" }]);
    expect(stake.approveLabel).toBe("Stake 607 TOILET");
  });

  it("adds the staking setup row when the same transaction registers first", () => {
    const stake = review([
      call(STAKING, "storage_deposit", {}, (NEAR / 1n).toString()),
      call(TOILET, "ft_transfer_call", { receiver_id: STAKING, amount: "1000000000000000000", msg: "stake" }),
    ])!;
    expect(stake.rows.map((row) => row.label)).toEqual(["To", "One-time setup"]);
  });

  it("refuses an ft_transfer_call to a receiver that is not the board or the pool", () => {
    expect(() => review([call("elsewhere.testnet", "ft_transfer_call", { receiver_id: "elsewhere.testnet", amount: "1", msg: "" })])).toThrow(/not supported/);
    expect(() => review([call(MPOO, "ft_transfer_call", { receiver_id: "elsewhere.testnet", amount: "1", msg: "" })])).toThrow(/Unreviewed transfer/);
  });

  it("refuses a stake-shaped call that does not say 'stake'", () => {
    expect(() => review([call(TOILET, "ft_transfer_call", { receiver_id: STAKING, amount: "1", msg: "withdraw" })])).toThrow(/Unreviewed transfer/);
  });
});

describe("painting", () => {
  it("counts the tiles in the call, not the cell count the game claims", () => {
    const r = review([call(BOARD, "draw_many", { cells: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] })])!;
    expect(r.title).toBe("Paint 3 tiles");
    expect(r.rows[0]).toEqual({ label: "Cost", value: "at most 3 credits" });
    expect(r.approveLabel).toBe("Paint 3 tiles");
  });
});

describe("claims and staking", () => {
  it("never puts an amount on a claim: the figure accrues until execution", () => {
    const toilet = review([call(BOARD, "claim_toilet", { toilet: TOILET })])!;
    expect(toilet.title).toBe("Claim your TOILET");
    expect(toilet.rows.some((row) => /\d/.test(row.value))).toBe(false);

    const mpoo = review([call(STAKING, "claim_rewards", {})])!;
    expect(mpoo.title).toBe("Claim your mPOO");
    expect(mpoo.approveLabel).toBe("Claim mPOO");
  });

  it("shows the burn from the contract's rate, and says so when the rate was not read", () => {
    const known = review([call(STAKING, "unstake", { amount: (10n ** 20n).toString() })])!;
    expect(known.title).toBe("Unstake 100 TOILET");
    expect(known.rows).toEqual([
      { label: "You get back", value: "90 TOILET" },
      { label: "Burned forever", value: "10 TOILET" },
    ]);

    const unknown = review([call(STAKING, "unstake", { amount: (10n ** 20n).toString() })], { unstakeBurnBps: null })!;
    expect(unknown.rows).toHaveLength(0);
    expect(unknown.notes.join(" ")).toMatch(/burn rate couldn't be read/);
  });

  it("names the mPOO setup when a first claim needs it", () => {
    const r = review([
      call(MPOO, "storage_deposit", {}, (NEAR / 100n).toString()),
      call(STAKING, "claim_rewards", {}),
    ])!;
    expect(r.rows.map((row) => row.label)).toContain("One-time mPOO setup");
  });
});

describe("the allowlist is explicit and closed", () => {
  it("captions a listed owner method and refuses an unlisted one", () => {
    const owner = review([call(BOARD, "set_paused", { paused: true })])!;
    expect(owner.title).toBe("Change a board setting");
    expect(owner.approveLabel).toBe("Approve");

    expect(() => review([call(BOARD, "set_owner", { account_id: "mallory.testnet" })])).toThrow(/not supported/);
    expect(() => review([call(BOARD, "withdraw_all", {})])).toThrow(/not supported/);
  });

  it("refuses an unknown method on the staking contract too", () => {
    expect(() => review([call(STAKING, "drain", {})])).toThrow(/not supported/);
  });

  it("cannot be captioned by anything the game puts in the arguments", () => {
    const r = review([call(BOARD, "buy_credits_near", { summary: "Buy 1000 credits", label: "Pay 1 NEAR", min_credits: "10" }, (NEAR * 25n / 1000n).toString())])!;
    expect(r.title).toBe("Buy 10 credits");
    expect(r.approveLabel).toBe("Pay 0.025 NEAR");
    expect(JSON.stringify(r)).not.toContain("Buy 1000 credits");
    expect(JSON.stringify(r)).not.toContain("Pay 1 NEAR");
  });
});
