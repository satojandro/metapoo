import { describe, expect, it } from "vitest";
import { isFastNearUrl, rpcAuthHeaders } from "./rpc-auth";

const KEY = "test-key-not-a-secret";
const FASTNEAR_TESTNET = "https://rpc.testnet.fastnear.com";

describe("rpc auth headers", () => {
  it("sends nothing when no key is configured", () => {
    expect(rpcAuthHeaders(FASTNEAR_TESTNET, FASTNEAR_TESTNET, "")).toEqual({});
  });

  it("sends the bearer token to the configured endpoint", () => {
    expect(rpcAuthHeaders(FASTNEAR_TESTNET, FASTNEAR_TESTNET, KEY)).toEqual({
      Authorization: `Bearer ${KEY}`,
    });
  });

  it("keeps the key on FastNEAR's other hosts, which share one credential", () => {
    expect(
      rpcAuthHeaders("https://archival-rpc.mainnet.fastnear.com", FASTNEAR_TESTNET, KEY),
    ).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("never sends the key to a fallback host the key was not issued for", () => {
    expect(
      rpcAuthHeaders("https://rpc.testnet.near.org", FASTNEAR_TESTNET, KEY),
    ).toEqual({});
  });

  it("refuses a malformed or relative url instead of guessing", () => {
    expect(rpcAuthHeaders("/relative", FASTNEAR_TESTNET, KEY)).toEqual({});
    expect(rpcAuthHeaders(FASTNEAR_TESTNET, "not a url", KEY)).toEqual({});
  });

describe("isFastNearUrl", () => {
  it("recognises every FastNEAR service host and nothing else", () => {
    for (const url of [
      "https://rpc.testnet.fastnear.com",
      "https://archival-rpc.mainnet.fastnear.com",
      "https://tx.main.fastnear.com",
      "https://api.fastnear.com",
    ]) expect(isFastNearUrl(url)).toBe(true);
    for (const url of ["https://rpc.near.org", "https://notfastnear.com", "https://fastnear.com.evil.test", "/relative"])
      expect(isFastNearUrl(url)).toBe(false);
  });
});
});
