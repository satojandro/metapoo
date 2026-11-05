import { describe, expect, it } from "vitest";
import { rpcAuthHeaders } from "./rpc-auth";

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
});
