import { describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { reviewSelfCustodyKey, parseCustodyPublicKey, privyPublicKey, getPrivyPendingSelfCustodyKey, setPrivyPendingSelfCustodyKey, custodyKeyPermission, type PendingSelfCustodyKey } from "./self-custody";
const host = {accountId: "ab".repeat(32), networkId: "testnet" as const, sessionEpoch: 2};
const publicKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
const pending = (): PendingSelfCustodyKey => ({...host, publicKey, kind: "add-full-access", createdAtMs: Date.now()});
const tx = (key = publicKey) => ({receiverId: host.accountId, actions: [{type: "AddKey", params: {publicKey: key, accessKey: {permission: "FullAccess"}}}]});
describe("self-custody boundary", () => {
  it("masks the suffix and requires a matching independently checked pending key", () => {
    const review = reviewSelfCustodyKey([tx()], host, pending(), null)!;
    expect(review.confirm?.suffix).toBe(publicKey.slice(-8));
    expect(JSON.stringify({...review, confirm: undefined})).not.toContain(publicKey.slice(-8));
    expect(() => reviewSelfCustodyKey([tx()], host, null, null)).toThrow();
    expect(() => reviewSelfCustodyKey([tx()], host, pending(), "FullAccess")).toThrow();
  });
  it("rejects expired, future and switched-epoch intents", () => {
    for (const change of [{createdAtMs: Date.now()-600001}, {createdAtMs: Date.now()+60000}, {sessionEpoch: 3}]) expect(() => reviewSelfCustodyKey([tx()], host, {...pending(), ...change}, null)).toThrow();
  });
  it("never authorizes Privy's own key or the drawing key", () => {
    const own = privyPublicKey(host.accountId);
    expect(() => reviewSelfCustodyKey([tx(own)], host, {...pending(), publicKey: own}, null)).toThrow();
    expect(() => reviewSelfCustodyKey([tx()], host, pending(), null, publicKey)).toThrow();
    expect(() => reviewSelfCustodyKey([{receiverId: host.accountId, actions: [{type: "DeleteKey", params: {publicKey: own}}]}], host, {...pending(), publicKey: own, kind: "remove-own-key"}, "FullAccess")).toThrow();
  });
  it("does not claim mixed batches", () => {
    expect(reviewSelfCustodyKey([tx(), tx()], host, pending(), null)).toBeNull();
    expect(reviewSelfCustodyKey([{...tx(), actions: [...tx().actions, ...tx().actions]}], host, pending(), null)).toBeNull();
  });
  it("refuses private keys and phrases", () => {
    expect(parseCustodyPublicKey(publicKey)).toBe(publicKey);
    for (const input of [KeyPair.fromRandom("ed25519").toString(), "word ".repeat(12), "ab".repeat(32), "secp256k1:abc"]) expect(() => parseCustodyPublicKey(input)).toThrow();
  });
  it("bounds persisted intent and distinguishes absent keys from unavailable RPC", async () => {
    const data = new Map<string,string>(); const storage = {getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => {data.set(k,v);}, removeItem: (k: string) => {data.delete(k);}};
    const intent = pending(); setPrivyPendingSelfCustodyKey(intent, storage);
    expect(getPrivyPendingSelfCustodyKey(storage, intent.createdAtMs + 599999)).not.toBeNull();
    expect(getPrivyPendingSelfCustodyKey(storage, intent.createdAtMs + 600000)).toBeNull();
    await expect(custodyKeyPermission(async () => {throw {cause: {name: "UNKNOWN_ACCESS_KEY"}};}, host.accountId, publicKey)).resolves.toBeNull();
    await expect(custodyKeyPermission(async () => {throw new Error("timeout");}, host.accountId, publicKey)).rejects.toThrow(/Retry/);
  });
});
