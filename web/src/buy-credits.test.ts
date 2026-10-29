import { describe, expect, it } from "vitest";
import {
  buildBuyCreditsNearArgs,
  buildFtTransferCallArgs,
  creditsUnchangedAfterFailure,
  multiplyUnits,
  parsePaymentConfig,
  quoteBuyCredits,
  REGISTRATION_YOCTO,
  type PaymentConfigView,
} from "./buy-credits";

const PRICE = "2500000000000000000000"; // 0.0025 NEAR, the launch price
const MPOO_PRICE = "1000000000000000000"; // 1 token (18 decimals)

const config: PaymentConfigView = {
  mpooToken: "mpoo.nearlytrade.near",
  nearPerCredit: PRICE,
  mpooPerCredit: MPOO_PRICE,
  registrationFee: REGISTRATION_YOCTO,
};

describe("multiplyUnits", () => {
  it("produces an attached deposit of exactly quantity × price", () => {
    // Acceptance: quantity 10 at price P → deposit 10P (fails on float math).
    expect(multiplyUnits(PRICE, 10)).toBe("25000000000000000000000");
    expect(multiplyUnits(PRICE, 100)).toBe("250000000000000000000000");
    expect(multiplyUnits("1", 3)).toBe("3");
  });

  it("rejects non-integer or non-positive quantities", () => {
    expect(() => multiplyUnits(PRICE, 0)).toThrow(/quantity/i);
    expect(() => multiplyUnits(PRICE, 1.5)).toThrow(/quantity/i);
    expect(() => multiplyUnits("0", 10)).toThrow(/unit price/i);
  });
});

describe("quoteBuyCredits", () => {
  it("NEAR path: min_credits and deposit match quantity × price", () => {
    const quote = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: 0n,
      network: "testnet",
    });
    expect(quote.minCredits).toBe("10");
    expect(quote.expectedPrice).toBe(PRICE);
    expect(quote.purchaseAmount).toBe(multiplyUnits(PRICE, 10));
    expect(quote.registrationDeposit).toBeNull();
    expect(quote.totalNearAttached).toBe(quote.purchaseAmount);
    const args = buildBuyCreditsNearArgs(quote);
    expect(args).toEqual({ min_credits: "10", expected_price: PRICE });
  });

  it("shows registration as its own line when get_credits is null", () => {
    const unregistered = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: null,
      network: "testnet",
    });
    expect(unregistered.registrationDeposit).toBe(REGISTRATION_YOCTO);
    expect(unregistered.lineItems.some((item) => /First-time setup/i.test(item.label))).toBe(
      true,
    );
    expect(unregistered.totalNearAttached).toBe(
      (BigInt(REGISTRATION_YOCTO) + BigInt(unregistered.purchaseAmount)).toString(),
    );

    const registered = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: 5n,
      network: "testnet",
    });
    expect(registered.registrationDeposit).toBeNull();
    expect(registered.lineItems.some((item) => /First-time setup/i.test(item.label))).toBe(
      false,
    );
  });

  it("token path builds ft_transfer_call msg with expected_price", () => {
    const quote = quoteBuyCredits({
      config,
      quantity: 2,
      asset: "token",
      creditsBalance: 1n,
      network: "testnet",
      tokenDecimals: 18,
    });
    expect(quote.tokenLabel).toBe("test token");
    expect(quote.purchaseAmount).toBe(multiplyUnits(MPOO_PRICE, 2));
    const args = buildFtTransferCallArgs({
      boardContractId: "board.testnet",
      quote,
    });
    expect(args.receiver_id).toBe("board.testnet");
    expect(args.amount).toBe(quote.purchaseAmount);
    expect(JSON.parse(args.msg)).toEqual({
      min_credits: "2",
      expected_price: MPOO_PRICE,
    });
  });

  it("labels mainnet token purchases as mPOO", () => {
    const quote = quoteBuyCredits({
      config,
      quantity: 1,
      asset: "token",
      creditsBalance: 0n,
      network: "mainnet",
      tokenDecimals: 18,
    });
    expect(quote.tokenLabel).toBe("mPOO");
    expect(quote.lineItems[0]?.amountLabel).toContain("mPOO");
  });
});

describe("parsePaymentConfig", () => {
  it("reads registration_fee from the board view", () => {
    expect(
      parsePaymentConfig({
        mpoo_token: "token.testnet",
        near_per_credit: PRICE,
        mpoo_per_credit: MPOO_PRICE,
        registration_fee: REGISTRATION_YOCTO,
      }),
    ).toEqual({
      mpooToken: "token.testnet",
      nearPerCredit: PRICE,
      mpooPerCredit: MPOO_PRICE,
      registrationFee: REGISTRATION_YOCTO,
    });
  });
});

describe("creditsUnchangedAfterFailure", () => {
  it("a rejected purchase must leave displayed credits unchanged", () => {
    expect(creditsUnchangedAfterFailure(12n, 12n)).toBe(true);
    expect(creditsUnchangedAfterFailure(null, null)).toBe(true);
    expect(creditsUnchangedAfterFailure(12n, 22n)).toBe(false);
  });
});
