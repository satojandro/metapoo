import { describe, expect, it, vi } from "vitest";
import { checkSend, checkSendRecipient } from "./checks";
const policy = {enabled: true, tokens: [{contractId: "toilet.testnet", symbol: "TOILET", decimals: 18}], blockedRecipients: [], storageMinimums: {}};
const transfer = {type: "FunctionCall", params: {methodName: "ft_transfer", args: {receiver_id: "bob.testnet", amount: "1"}, deposit: "1", gas: "30000000000000"}};
const tx = {receiverId: "toilet.testnet", actions: [transfer]};
const result = (v: unknown) => ({result: Array.from(new TextEncoder().encode(JSON.stringify(v)))});
describe("independent send reads", () => {
  it("never treats a timeout as an absent account, but permits a fresh NEAR implicit account", async () => {
    const rpc = vi.fn(async () => { throw new Error("timeout"); });
    await expect(checkSendRecipient(rpc, "bob.testnet")).rejects.toThrow(/couldn't check/);
    await expect(checkSendRecipient(rpc, "ab".repeat(32))).resolves.toBeUndefined();
    await expect(checkSendRecipient(rpc, "0x"+"ab".repeat(20))).rejects.toThrow();
  });
  it("rejects decimals drift and unregistered recipients without changing their transaction", async () => {
    const rpc = vi.fn(async (_m: string, p: Record<string,unknown>) => p.request_type === "view_account" ? {} : result(p.method_name === "ft_metadata" ? {decimals: 24} : null));
    await expect(checkSend([tx], "alice.testnet", policy, rpc)).rejects.toThrow(/token/);
    rpc.mockImplementation(async (_m, p) => p.request_type === "view_account" ? {} : result(p.method_name === "ft_metadata" ? {decimals: 18} : null));
    await expect(checkSend([tx], "alice.testnet", policy, rpc)).rejects.toThrow(/registered/);
    expect(tx.actions).toHaveLength(1);
  });
  it("requires its own exact minimum for atomic recipient registration", async () => {
    const reg = {type: "FunctionCall", params: {methodName: "storage_deposit", args: {account_id: "bob.testnet", registration_only: true}, gas: "10000000000000", deposit: "1250000000000000000000"}};
    const rpc = vi.fn(async (_m: string, p: Record<string,unknown>) => p.request_type === "view_account" ? {} : result(p.method_name === "ft_metadata" ? {decimals: 18} : p.method_name === "storage_balance_bounds" ? {min: reg.params.deposit} : null));
    await expect(checkSend([{...tx, actions: [reg, transfer]}], "alice.testnet", policy, rpc)).resolves.toMatchObject({send: {registrationDeposit: reg.params.deposit}});
    await expect(checkSend([{...tx, actions: [{...reg, params: {...reg.params, deposit: "1"}}, transfer]}], "alice.testnet", policy, rpc)).rejects.toThrow();
  });
  it("self-registration retains its old path without any RPC reads", async () => {
    const rpc = vi.fn();
    await expect(checkSend([{receiverId: "toilet.testnet", actions: [{type: "FunctionCall", params: {methodName: "storage_deposit", args: {account_id: "alice.testnet"}}}]}], "alice.testnet", policy, rpc)).resolves.toMatchObject({send: null});
    expect(rpc).not.toHaveBeenCalled();
  });
});
