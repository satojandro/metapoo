/** Provider-shaped fixtures, not live quote/signature evidence. */
import type { OperationContext } from "../types";
import type {
  FundingQuoteRequest,
  FundingQuote,
  FundingStatus,
  IntentsToken,
} from "./types";
import { makeQuoteRequest } from "./quote";
import { parseQuote } from "./client";

export const FIXTURE_TIME = Date.parse("2026-11-03T00:00:00.000Z");
export const FIXTURE_CONTEXT: OperationContext = {
  operationId: "fixture-operation",
  accountId: "player.near",
  networkId: "mainnet",
  sessionEpoch: 1,
};
export const FIXTURE_TOKEN: IntentsToken = {
  assetId: "nep141:base-usdc.omft.near",
  blockchain: "base",
  symbol: "USDC",
  decimals: 6,
  contractAddress: "0x1111111111111111111111111111111111111111",
};
export const FIXTURE_REFUND = "0x2222222222222222222222222222222222222222";
export function fixtureQuote(
  request: FundingQuoteRequest = makeQuoteRequest(
    FIXTURE_TOKEN,
    "1000000",
    FIXTURE_CONTEXT.accountId,
    FIXTURE_REFUND,
    FIXTURE_TIME,
  ),
): FundingQuote {
  return parseQuote({
    correlationId: request.dry ? "fixture-preview" : "fixture-committed",
    timestamp: new Date(FIXTURE_TIME).toISOString(),
    signature: "fixture-not-a-real-signature",
    quoteRequest: { ...request },
    quote: {
      amountIn: request.amount,
      amountOut: "1000000000000000000000000",
      minAmountOut: "990000000000000000000000",
      timeEstimate: 120,
      ...(request.dry
        ? {}
        : {
            depositAddress: "0x3333333333333333333333333333333333333333",
            deadline: request.deadline,
          }),
    },
  });
}
export function fixtureStatus(
  quote: FundingQuote,
  status: FundingStatus["status"] = "PROCESSING",
): FundingStatus {
  return {
    status,
    providerStatus: status,
    quoteResponse: quote,
    updatedAt: new Date(FIXTURE_TIME).toISOString(),
    originHashes: ["source-transaction"],
    destinationHashes: status === "SUCCESS" ? ["destination-transaction"] : [],
    refundHashes: [],
  };
}
