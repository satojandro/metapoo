import { describe, expect, it } from "vitest";
import type { ReadinessRpc } from "../account-readiness";
import {
  custodyAttemptKey,
  getCustodyAttempt,
  reconcileCustodyAttempt,
  setCustodyAttempt,
  type CustodyAttempt,
} from "./custody-attempt";

const ACCOUNT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const KEY = "ed25519:11111111111111111111111111111111";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    map,
  };
}

const attempt: CustodyAttempt = {
  accountId: ACCOUNT, networkId: "testnet", sessionEpoch: 1,
  publicKey: KEY, kind: "add-full-access", createdAtMs: 1,
};

function unknownKey(): Error {
  const error = new Error("UNKNOWN_ACCESS_KEY");
  error.name = "UNKNOWN_ACCESS_KEY";
  return error;
}

/** `absent` means the chain does not know the key, i.e. the change never landed. */
function rpc(options: {
  permission?: "FullAccess" | "FunctionCall" | "absent";
  keyThrows?: boolean;
  tx?: unknown;
  txThrows?: boolean;
} = {}): ReadinessRpc {
  return async (method: string) => {
    if (method === "query") {
      if (options.keyThrows) throw new Error("network down");
      if (options.permission === undefined || options.permission === "absent") throw unknownKey();
      return { permission: options.permission };
    }
    if (method === "tx") {
      if (options.txThrows) throw new Error("transaction not found");
      return options.tx;
    }
    throw new Error(`unexpected method ${method}`);
  };
}

const failedTx = {
  status: { Failure: { ActionError: { index: 0, kind: { AddKeyAlreadyExists: {} } } } },
  transaction: { hash: "hash-1", signer_id: ACCOUNT, receiver_id: ACCOUNT },
};
const successTx = {
  status: { SuccessValue: "" },
  transaction: { hash: "hash-1", signer_id: ACCOUNT, receiver_id: ACCOUNT },
};

describe("custody attempt marker", () => {
  it("is scoped to one network and account", () => {
    expect(custodyAttemptKey("testnet", ACCOUNT)).toBe(`metapoo:custody:attempt:testnet:${ACCOUNT}`);
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)?.publicKey).toBe(KEY);
    // A marker belonging to one account must never gate another.
    expect(getCustodyAttempt(store, "testnet", OTHER)).toBeNull();
    expect(getCustodyAttempt(store, "mainnet", ACCOUNT)).toBeNull();
  });

  it("ignores a marker that is malformed or the wrong shape", () => {
    const store = storage();
    store.setItem(custodyAttemptKey("testnet", ACCOUNT), "{not json");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
    store.setItem(custodyAttemptKey("testnet", ACCOUNT), JSON.stringify({ ...attempt, kind: "delete-account" }));
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
  });

  it("reports nothing when no attempt is pending", async () => {
    await expect(reconcileCustodyAttempt(storage(), "testnet", ACCOUNT, rpc()))
      .resolves.toEqual({ state: "none", attempt: null });
  });

  it("clears the marker when the key landed", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "FullAccess" }));
    expect(settled.state).toBe("applied");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
  });

  it("releases the spending block when the key change failed on chain", async () => {
    // The regression this file exists for: a failed AddKey used to leave the marker behind
    // for good, so every later payment was refused with advice ("refresh") that could never
    // clear it. A failure on chain means nothing changed, so the block must lift.
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, { ...attempt, transactionHash: "hash-1" });
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent", tx: failedTx }));
    expect(settled.state).toBe("failed");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
  });

  it("keeps the marker when the outcome was lost and no hash was recorded", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent" }));
    expect(settled.state).toBe("unknown");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).not.toBeNull();
  });

  it("keeps the marker when the recorded transaction cannot be read back", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, { ...attempt, transactionHash: "hash-1" });
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent", txThrows: true }));
    expect(settled.state).toBe("unknown");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).not.toBeNull();
  });

  it("keeps the marker while a successful transaction has not surfaced its key", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, { ...attempt, transactionHash: "hash-1" });
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent", tx: successTx }));
    expect(settled.state).toBe("unknown");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).not.toBeNull();
  });

  it("needs an explicit override to clear a lost outcome", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent" }), { discard: true });
    expect(settled.state).toBe("discarded");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
  });

  it("never discards a change that actually landed", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "FullAccess" }), { discard: true });
    expect(settled.state).toBe("applied");
    expect(settled.attempt?.publicKey).toBe(KEY);
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).toBeNull();
  });

  it("refuses to settle on a failed key read", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, attempt);
    await expect(reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ keyThrows: true }))).rejects.toThrow(/Retry/);
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).not.toBeNull();
  });

  it("treats a missing key as an applied removal", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, { ...attempt, kind: "remove-own-key" });
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "absent" }));
    expect(settled.state).toBe("applied");
  });

  it("does not treat a still-present key as an applied removal", async () => {
    const store = storage();
    setCustodyAttempt(store, "testnet", ACCOUNT, { ...attempt, kind: "remove-own-key" });
    const settled = await reconcileCustodyAttempt(store, "testnet", ACCOUNT, rpc({ permission: "FullAccess" }));
    expect(settled.state).toBe("unknown");
    expect(getCustodyAttempt(store, "testnet", ACCOUNT)).not.toBeNull();
  });
});
