import { describe, expect, it } from "vitest";
import { classifySend, decodeSendArgs, parseSendAmount } from "./plan";
const policy = { enabled: true, tokens: [{contractId: "toilet.testnet", symbol: "TOILET", decimals: 18}], blockedRecipients: ["board.testnet"], storageMinimums: {"toilet.testnet": "1250000000000000000000"} };
const transfer = { type: "FunctionCall", params: {methodName: "ft_transfer", args: {receiver_id: "bob.testnet", amount: "12"}, gas: "30000000000000", deposit: "1"} };
const tx = () => ({receiverId: "toilet.testnet", actions: [structuredClone(transfer)]});
describe("reviewed sends", () => {
  it("accepts only one exact token transaction", () => {
    expect(classifySend([tx()], "alice.testnet", policy)?.amount).toBe("12");
    expect(() => classifySend([tx(), tx()], "alice.testnet", policy)).toThrow();
  });
  it.each(["0", "2", "01", "1000000000000000000000000"])("rejects transfer deposit %s", deposit => {
    const t = tx(); t.actions[0].params.deposit = deposit;
    expect(() => classifySend([t], "alice.testnet", policy)).toThrow();
  });
  it("rejects duplicate JSON keys before JSON.parse can hide them", () => {
    expect(() => decodeSendArgs(new TextEncoder().encode('{"amount":"1","amount":"2"}'))).toThrow();
    expect(() => decodeSendArgs(new TextEncoder().encode('{"amount":"1","\\u0061mount":"2"}'))).toThrow();
  });
  it("rejects mixed key actions and disabled sends", () => {
    expect(() => classifySend([{...tx(), actions: [...tx().actions, {type: "AddKey", params: {accessKey: {permission: "FullAccess"}}}]}], "alice.testnet", policy)).toThrow();
    expect(() => classifySend([tx()], "alice.testnet", {...policy, enabled: false})).toThrow();
  });
  it("parses decimal amounts without floating point rounding", () => {
    expect(parseSendAmount("1.000000000000000001", 18)).toBe("1000000000000000001");
    expect(() => parseSendAmount("1e3", 18)).toThrow();
    expect(() => parseSendAmount("0.0000000000000000001", 18)).toThrow();
  });
});

describe("hostile send shapes", () => {
  it.each([
    ["unknown token", (t: ReturnType<typeof tx>) => {t.receiverId = "wrap.testnet";}],
    ["self recipient", (t: ReturnType<typeof tx>) => {t.actions[0].params.args.receiver_id = "alice.testnet";}],
    ["token recipient", (t: ReturnType<typeof tx>) => {t.actions[0].params.args.receiver_id = "toilet.testnet";}],
    ["board recipient", (t: ReturnType<typeof tx>) => {t.actions[0].params.args.receiver_id = "board.testnet";}],
    ["zero amount", (t: ReturnType<typeof tx>) => {t.actions[0].params.args.amount = "0";}],
    ["too much gas", (t: ReturnType<typeof tx>) => {t.actions[0].params.gas = "50000000000001";}],
    ["two transfers", (t: ReturnType<typeof tx>) => {t.actions.push(structuredClone(transfer));}],
  ])("rejects %s", (_name, mutate) => {
    const t = tx(); mutate(t);
    expect(() => classifySend([t], "alice.testnet", policy)).toThrow();
  });
  it("object and UTF-8 arguments describe the same transfer", () => {
    const t = tx(); const encoded = {...t, actions: [{...t.actions[0], params: {...t.actions[0].params, args: new TextEncoder().encode(JSON.stringify(t.actions[0].params.args))}}]};
    expect(classifySend([encoded], "alice.testnet", policy)).toEqual(classifySend([t], "alice.testnet", policy));
    expect(() => decodeSendArgs(new Uint8Array([0xff]))).toThrow();
    expect(() => classifySend([{...t, actions: [{...transfer, params: {...transfer.params, args: {...transfer.params.args, memo: "hidden"}}}]}], "alice.testnet", policy)).toThrow();
  });
});
