import { describe, expect, it, vi } from "vitest";
import {
  attributedNativeTransfer,
  createDestinationReconciler,
} from "./receipt";
import {
  FIXTURE_CONTEXT,
  FIXTURE_TIME,
  FIXTURE_TOKEN,
  fixtureQuote,
  fixtureStatus,
} from "./fixtures";
import type { FundingOperation } from "./types";

function trace(receiver = "player.near") {
  return {
    transaction: { hash: "destination-transaction" },
    status: { SuccessValue: "" },
    receipts: [
      {
        receipt_id: "receipt",
        receiver_id: receiver,
        receipt: {
          Action: {
            actions: [{ Transfer: { deposit: "1000000000000000000000000" } }],
          },
        },
      },
    ],
    receipts_outcome: [
      {
        id: "receipt",
        outcome: { executor_id: receiver, status: { SuccessValue: "" } },
      },
    ],
  };
}
describe("native destination attribution", () => {
  it("requires the quoted destination, hash and executed native Transfer action", () => {
    expect(
      attributedNativeTransfer(
        trace(),
        "destination-transaction",
        "player.near",
        "1",
      )?.receiptId,
    ).toBe("receipt");
    expect(
      attributedNativeTransfer(
        trace("attacker.near"),
        "destination-transaction",
        "player.near",
        "1",
      ),
    ).toBeNull();
    expect(
      attributedNativeTransfer(
        trace(),
        "unrelated-transaction",
        "player.near",
        "1",
      ),
    ).toBeNull();
    expect(
      attributedNativeTransfer(
        { ...trace(), receipts: [] },
        "destination-transaction",
        "player.near",
        "1",
      ),
    ).toBeNull();
    const failed = trace();
    failed.receipts_outcome[0].outcome.status = {
      Failure: "failed",
    } as unknown as { SuccessValue: string };
    expect(
      attributedNativeTransfer(
        failed,
        "destination-transaction",
        "player.near",
        "1",
      ),
    ).toBeNull();
  });
  it("never credits an unrelated larger balance without a matching receipt", async () => {
    const quote = fixtureQuote({ ...fixtureQuote().quoteRequest, dry: false });
    const operation: FundingOperation = {
      version: 1,
      id: FIXTURE_CONTEXT.operationId,
      context: FIXTURE_CONTEXT,
      token: FIXTURE_TOKEN,
      quote,
      createdAtMs: FIXTURE_TIME,
      updatedAtMs: FIXTURE_TIME,
      phase: "settled_verifying",
    };
    const readiness = vi.fn(async () => ({
      state: "ready" as const,
      spendableBeforeGasYocto: "999999999999999999999999999",
    }));
    const reconcile = createDestinationReconciler({
      readTransaction: async () => ({ ...trace(), receipts: [] }),
      readReadiness: readiness,
    });
    expect(
      (await reconcile(operation, fixtureStatus(quote, "SUCCESS"))).state,
    ).toBe("pending");
    expect(readiness).not.toHaveBeenCalled();
  });
  it("can verify named-account delivery while logged out, without pretending to verify an implicit key", async () => {
    const quote = fixtureQuote({ ...fixtureQuote().quoteRequest, dry: false });
    const operation: FundingOperation = {
      version: 1,
      id: FIXTURE_CONTEXT.operationId,
      context: FIXTURE_CONTEXT,
      token: FIXTURE_TOKEN,
      quote,
      createdAtMs: FIXTURE_TIME,
      updatedAtMs: FIXTURE_TIME,
      phase: "settled_verifying",
    };
    const reconcile = createDestinationReconciler({
      readTransaction: async () => trace(),
      readReadiness: async () => ({
        state: "ready",
        expectedKeyMatches: false,
        spendableBeforeGasYocto: "1000",
      }),
    });
    expect(
      (await reconcile(operation, fixtureStatus(quote, "SUCCESS"))).state,
    ).toBe("verified_native");
    operation.context = { ...operation.context, accountId: "a".repeat(64) };
    operation.quote.quoteRequest.recipient = operation.context.accountId;
    const implicitReconcile = createDestinationReconciler({
      readTransaction: async () => trace(operation.context.accountId),
      readReadiness: async () => ({
        state: "ready",
        expectedKeyMatches: false,
        spendableBeforeGasYocto: "1000",
      }),
    });
    expect(
      (
        await implicitReconcile(
          operation,
          fixtureStatus(operation.quote, "SUCCESS"),
        )
      ).state,
    ).toBe("pending");
  });
});
