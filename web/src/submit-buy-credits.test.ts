import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNear = vi.fn();
const sendToken = vi.fn();

vi.mock("./wallet", () => ({
  signAndSendBuyCreditsNear: (...args: unknown[]) => sendNear(...args),
  signAndSendBuyCreditsToken: (...args: unknown[]) => sendToken(...args),
}));

vi.mock("./config", () => ({
  CONTRACT_ID: "board.testnet",
}));

import { quoteBuyCredits, REGISTRATION_YOCTO, type PaymentConfigView } from "./buy-credits";
import { submitBuyCredits } from "./submit-buy-credits";

const PRICE = "2500000000000000000000"; // 0.0025 NEAR, the launch price
const config: PaymentConfigView = {
  mpooToken: "token.testnet",
  nearPerCredit: PRICE,
  mpooPerCredit: "1000000000000000000",
  registrationFee: REGISTRATION_YOCTO,
};

function successOutcome(hash = "txhash123") {
  return {
    transaction: { hash },
    status: { SuccessValue: "" },
  };
}

describe("submitBuyCredits", () => {
  beforeEach(() => {
    sendNear.mockReset();
    sendToken.mockReset();
  });

  it("leaves displayed credits unchanged when the user rejects", async () => {
    sendNear.mockRejectedValue(new Error("User rejected the request"));
    const quote = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: 12n,
      network: "testnet",
    });
    const readCredits = vi.fn(async () => 99n);
    const result = await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: 12n,
      readCredits,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.code).toBe("user_rejected");
      expect(result.creditsAfter).toBe(12n);
    }
    expect(readCredits).not.toHaveBeenCalled();
  });

  it("confirms only after get_credits re-read reaches the expected balance", async () => {
    sendNear.mockResolvedValue(successOutcome());
    const quote = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: 5n,
      network: "testnet",
    });
    const readCredits = vi.fn(async () => 15n);
    const result = await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: 5n,
      readCredits,
    });
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") {
      expect(result.creditsAfter).toBe(15n);
    }
    expect(sendNear).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseDeposit: quote.purchaseAmount,
        minCredits: "10",
        expectedPrice: PRICE,
        registrationDeposit: null,
      }),
    );
  });

  it("batches registration deposit when credits were null", async () => {
    sendNear.mockResolvedValue(successOutcome());
    const quote = quoteBuyCredits({
      config,
      quantity: 10,
      asset: "near",
      creditsBalance: null,
      network: "testnet",
    });
    await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: null,
      readCredits: async () => 10n,
    });
    expect(sendNear).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationDeposit: REGISTRATION_YOCTO,
        purchaseDeposit: quote.purchaseAmount,
      }),
    );
  });

  it("does not treat a bare hash as confirmed credits", async () => {
    sendNear.mockResolvedValue({ transaction: { hash: "only-hash" } });
    const quote = quoteBuyCredits({
      config,
      quantity: 1,
      asset: "near",
      creditsBalance: 0n,
      network: "testnet",
    });
    const result = await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: 0n,
      readCredits: async () => 100n,
    });
    expect(result.status).toBe("confirmation_delayed");
    if (result.status !== "confirmed") {
      expect(result.creditsAfter).toBe(0n);
    }
  });

  it.each([
    ["MpooDailyCapReached", "mpoo_cap_reached", /sold out/],
    ["MpooSalesClosed", "mpoo_sales_closed", /closed/],
    ["PriceChanged", "price_changed", /price changed/],
  ])("reports a %s token refund as failed with a chain-read balance", async (log, code, words) => {
    sendToken.mockResolvedValue({
      transaction: { hash: "refund-tx" },
      status: { SuccessValue: btoa('"0"') },
      receipts_outcome: [{ outcome: { logs: [`purchase_rejected: ${log}`] } }],
    });
    const quote = quoteBuyCredits({
      config,
      quantity: 4,
      asset: "token",
      creditsBalance: 7n,
      network: "testnet",
      tokenDecimals: 18,
      tokenSymbol: "tPOO",
    });
    const readCredits = vi.fn(async () => 7n);
    const result = await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: 7n,
      readCredits,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.code).toBe(code);
      expect(result.message).toMatch(words);
      expect(result.message).toContain("tPOO was sent back");
      expect(result.creditsAfter).toBe(7n);
    }
    expect(readCredits).toHaveBeenCalledTimes(1);
  });

  it("treats a resolver that used 0 tokens as a refund even without a log", async () => {
    sendToken.mockResolvedValue({
      transaction: { hash: "refund-tx" },
      status: { SuccessValue: btoa('"0"') },
      receipts_outcome: [],
    });
    const quote = quoteBuyCredits({
      config,
      quantity: 1,
      asset: "token",
      creditsBalance: 2n,
      network: "testnet",
      tokenDecimals: 18,
    });
    const result = await submitBuyCredits({
      quote,
      accountId: "alice.testnet",
      networkId: "testnet",
      pageNetwork: "testnet",
      tokenContractId: config.mpooToken,
      creditsBefore: 2n,
      readCredits: async () => 2n,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.code).toBe("token_refunded");
    }
  });
});
