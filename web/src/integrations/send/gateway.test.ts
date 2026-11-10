import { describe, expect, it, vi } from "vitest";
import { createApprovedTransactionGateway, validateAcquisitionTransaction, reconcilePendingCapitalAttempt } from "../approved-transactions";
import { SEND_GAS_FLOOR_YOCTO, validateSendTransaction } from "./plan";
import type { ApprovedTransactionRequest } from "../types";
const context = {accountId: "alice.testnet", networkId: "testnet" as const, sessionEpoch: 1, operationId: "send-1"};
const policy = {enabled: true, tokens: [], blockedRecipients: [], storageMinimums: {}};
function setup() {
  const m = new Map<string,string>(), storage = {getItem: (k: string) => m.get(k) ?? null, setItem: (k: string,v: string) => {m.set(k,v);}, removeItem: (k: string) => {m.delete(k);}};
  const request: ApprovedTransactionRequest = {context, purpose: "send", transactions: [{receiverId: "bob.testnet", actions: [{type: "Transfer", params: {deposit: "10"}}]}], approval: {summary: "Send", maxNativeSpendYocto: "2000000000010"}};
  const deps = {context: () => context, storage, now: Date.now, validateTransaction: (tx: ApprovedTransactionRequest["transactions"][number], r: ApprovedTransactionRequest) => validateSendTransaction(tx,r,policy), readBudget: vi.fn(async () => ({spendableBeforeGasYocto: (BigInt(SEND_GAS_FLOOR_YOCTO)+2000000000010n).toString(), gasPriceYocto: "1", playReserveYocto: "0"})), send: vi.fn(async (): Promise<unknown> => {throw new Error("timeout after possible broadcast");})};
  return {request, deps, gateway: createApprovedTransactionGateway(deps), storage};
}
describe("send gateway", () => {
  it("enforces its floor even if a caller supplies zero reserve", async () => {
    const {request, deps, gateway} = setup(); deps.readBudget.mockResolvedValue({spendableBeforeGasYocto: "2000000000010", gasPriceYocto: "1", playReserveYocto: "0"});
    await expect(gateway(request)).rejects.toThrow(/reserve/); expect(deps.send).not.toHaveBeenCalled();
  });
  it("records uncertainty before broadcast and never automatically repeats a send", async () => {
    const {request, deps, gateway} = setup();
    expect((await gateway(request)).steps[0].status).toBe("unknown");
    await expect(gateway(request)).rejects.toThrow(/reconciliation/); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it("keeps native Transfer outside acquisition permissions", () => {
    const {request} = setup();
    expect(() => validateAcquisitionTransaction(request.transactions[0], {...request, purpose: "funding-unwrap"}, {wrapAccount: "bob.testnet", tokenAccounts: [], exchangeAccounts: [], poolIds: [], storageMaximums: {}})).toThrow();
  });
  it("reconciles only the exact recorded native transfer", async () => {
    const {request, deps, gateway, storage} = setup();
    deps.send.mockResolvedValue({transaction: {hash: "hash"}}); await gateway(request);
    const outcome = {transaction: {hash: "hash", signer_id: context.accountId, receiver_id: "bob.testnet", actions: [{Transfer: {deposit: "10"}}]}, status: {SuccessValue: ""}, receipts_outcome: [{outcome: {status: {SuccessValue: ""}}}]};
    expect(await reconcilePendingCapitalAttempt(context, storage, async () => ({...outcome, transaction: {...outcome.transaction, receiver_id: "mallory.testnet"}}))).toBe(false);
    expect(await reconcilePendingCapitalAttempt(context, storage, async () => outcome)).toBe(true);
  });
});
