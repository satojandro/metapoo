import { describe, expect, it } from "vitest";
import {
  buildAddFunctionCallKeyParams,
  classifyDrawingKeyAccessKey,
  describeDrawingSession,
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  DRAWING_SESSION_METHODS,
  encodeBase58,
  forgetDrawingSessionLocally,
  formatAllowanceNear,
  loadDrawingSessionRecord,
  makeAuthorizedSessionRecord,
  saveDrawingSessionRecord,
  type DrawingSessionRecord,
  isDrawingKeyLow,
} from "./drawing-session";

/** Tiny in-memory Storage stand-in for unit tests (no browser required). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function sampleRecord(
  overrides: Partial<DrawingSessionRecord> = {},
): DrawingSessionRecord {
  return {
    ...makeAuthorizedSessionRecord({
      accountId: "artist.testnet",
      networkId: "testnet",
      contractId: "board.example.testnet",
      publicKey: "ed25519:11111111111111111111111111111111",
      secretKey: "ed25519:SecretKeyForTestsOnlyNotReal",
      secretKeyHex: "",
      gasAllowanceYocto: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
      authorizedAt: "2026-10-12T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("formatAllowanceNear", () => {
  it("formats whole NEAR amounts", () => {
    expect(formatAllowanceNear("1000000000000000000000000")).toBe("1 NEAR");
    expect(formatAllowanceNear("0")).toBe("0 NEAR");
  });

  it("formats the experimental 0.05 NEAR allowance", () => {
    expect(formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO)).toBe(
      "0.05 NEAR",
    );
  });

  it("rejects non-numeric input without throwing", () => {
    expect(formatAllowanceNear("not-a-number")).toBe("(invalid allowance)");
    expect(formatAllowanceNear("")).toBe("(invalid allowance)");
  });
});

describe("encodeBase58", () => {
  it("encodes an empty buffer as an empty string", () => {
    expect(encodeBase58(new Uint8Array())).toBe("");
  });

  it("encodes a known short value", () => {
    // 0x00 → "1" (leading zero → leading '1')
    expect(encodeBase58(new Uint8Array([0]))).toBe("1");
    // 0x00 0x00 → "11"
    expect(encodeBase58(new Uint8Array([0, 0]))).toBe("11");
  });
});

describe("buildAddFunctionCallKeyParams", () => {
  it("limits methods to the paint methods with a limited gas allowance", () => {
    const params = buildAddFunctionCallKeyParams(
      "board.example.testnet",
      "ed25519:SomePublicKey",
    );
    expect(params.contractId).toBe("board.example.testnet");
    expect(params.publicKey).toBe("ed25519:SomePublicKey");
    expect(params.allowMethods).toEqual({
      anyMethod: false,
      methodNames: [...DRAWING_SESSION_METHODS],
    });
    expect(params.gasAllowance).toEqual({
      kind: "limited",
      amount: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    });
  });

  it("never grants full access or an unrestricted method list", () => {
    const params = buildAddFunctionCallKeyParams(
      "board.example.testnet",
      "ed25519:SomePublicKey",
    );
    // A session key must not be able to move funds or call unrelated methods.
    expect(params.allowMethods.anyMethod).toBe(false);
    expect(params.allowMethods.methodNames).not.toContain("transfer");
    expect(params.allowMethods.methodNames).not.toContain("new");
    // Only the board's paint entry points are reachable.
    expect([...params.allowMethods.methodNames].sort()).toEqual(["draw", "draw_many"]);
  });
});

describe("describeDrawingSession state machine", () => {
  it("says not available when the contract id is missing", () => {
    const status = describeDrawingSession({
      contractId: "",
      accountId: null,
      networkId: null,
      record: null,
    });
    expect(status.phase).toBe("contract_missing");
    expect(status.message).toMatch(/contract id/i);
  });

  it("says not active when disconnected", () => {
    const status = describeDrawingSession({
      contractId: "board.example.testnet",
      accountId: null,
      networkId: null,
      record: null,
    });
    expect(status.phase).toBe("inactive");
    expect(status.message).toMatch(/ordinary wallet/i);
  });

  it("says not active when connected without a stored session", () => {
    const status = describeDrawingSession({
      contractId: "board.example.testnet",
      accountId: "artist.testnet",
      networkId: "testnet",
      record: null,
    });
    expect(status.phase).toBe("inactive");
    expect(status.message).toMatch(/No experimental drawing session/i);
  });

  it("says active and prefers local signing with revoke guidance", () => {
    const status = describeDrawingSession({
      contractId: "board.example.testnet",
      accountId: "artist.testnet",
      networkId: "testnet",
      record: sampleRecord(),
    });
    expect(status.phase).toBe("active");
    expect(status.title).toMatch(/experimental/i);
    expect(status.message).toMatch(/local signing/i);
    expect(status.message).toMatch(/Revoke on chain/i);
    expect(status.allowanceLabel).toBe("0.05 NEAR");
  });

  it("says forgotten locally without claiming on-chain revoke", () => {
    const status = describeDrawingSession({
      contractId: "board.example.testnet",
      accountId: "artist.testnet",
      networkId: "testnet",
      record: {
        ...sampleRecord(),
        forgottenLocally: true,
        secretKey: "",
        secretKeyHex: "",
      },
    });
    expect(status.phase).toBe("forgotten_locally");
    expect(status.message).toMatch(/does not delete/i);
  });

  it("flags an account / network / contract mismatch", () => {
    const status = describeDrawingSession({
      contractId: "board.example.testnet",
      accountId: "other.testnet",
      networkId: "testnet",
      record: sampleRecord(),
    });
    expect(status.phase).toBe("account_mismatch");
    expect(status.message).toMatch(/other\.testnet/);
  });
});

describe("localStorage session persistence", () => {
  it("round-trips an authorized record", () => {
    const storage = memoryStorage();
    const record = sampleRecord();
    saveDrawingSessionRecord(record, storage);
    expect(loadDrawingSessionRecord(storage)).toEqual(record);
  });

  it("forget clears the secret and marks forgottenLocally", () => {
    const storage = memoryStorage();
    saveDrawingSessionRecord(sampleRecord(), storage);
    const forgotten = forgetDrawingSessionLocally(storage);
    expect(forgotten?.forgottenLocally).toBe(true);
    expect(forgotten?.secretKey).toBe("");
    expect(forgotten?.secretKeyHex).toBe("");
    expect(loadDrawingSessionRecord(storage)?.forgottenLocally).toBe(true);
  });

  it("rejects malformed stored JSON", () => {
    const storage = memoryStorage();
    storage.setItem("metapoo.experimental.drawingSession.v1", "{not-json");
    expect(loadDrawingSessionRecord(storage)).toBeNull();
  });
});

describe("classifyDrawingKeyAccessKey", () => {
  const board = "board.testnet";
  const fc = (over: { receiver_id?: string; method_names?: string[]; allowance?: string | null }) => ({
    FunctionCall: {
      receiver_id: over.receiver_id ?? board,
      method_names: over.method_names ?? ["draw", "draw_many"],
      allowance: over.allowance === undefined ? DRAWING_SESSION_GAS_ALLOWANCE_YOCTO : over.allowance,
    },
  });

  it("accepts a key scoped to the drawing methods", () => {
    expect(classifyDrawingKeyAccessKey(fc({}), board)).toBe("scoped");
  });

  it("accepts, and names, a wallet-wide key: Meteor adds method_names: []", () => {
    // Observed on testnet 2026-11-03: near-connect forwards allowMethods.methodNames and
    // Meteor stores an empty filter. Rejecting it broke every authorize attempt.
    expect(classifyDrawingKeyAccessKey(fc({ method_names: [] }), board)).toBe("wildcard");
  });

  it("rejects what a session must never use", () => {
    expect(classifyDrawingKeyAccessKey("FullAccess", board)).toBe("rejected");
    expect(classifyDrawingKeyAccessKey(null, board)).toBe("absent");
    expect(classifyDrawingKeyAccessKey(fc({ receiver_id: "other.testnet" }), board)).toBe("rejected");
    expect(classifyDrawingKeyAccessKey(fc({ method_names: ["draw"] }), board)).toBe("rejected");
    expect(classifyDrawingKeyAccessKey(fc({ allowance: null }), board)).toBe("rejected");
    expect(
      classifyDrawingKeyAccessKey(
        fc({ allowance: (BigInt(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO) + 1n).toString() }),
        board,
      ),
    ).toBe("rejected");
  });

  it("treats the exact requested allowance as acceptable", () => {
    expect(classifyDrawingKeyAccessKey(fc({ allowance: DRAWING_SESSION_GAS_ALLOWANCE_YOCTO }), board)).toBe("scoped");
  });
});

describe("isDrawingKeyLow", () => {
  it("recognises the chain's NotEnoughAllowance, as the user saw it", () => {
    expect(isDrawingKeyLow(
      "Access Key {account_id}:{public_key} does not have enough balance 0.0308734581660761 for transaction costing 0.0309213099526195",
    )).toBe(true);
    expect(isDrawingKeyLow("Access Key alice.testnet:ed25519:abc does not have enough balance 1 for transaction costing 2")).toBe(true);
    expect(isDrawingKeyLow('{"InvalidTxError":{"InvalidAccessKeyError":{"NotEnoughAllowance":{}}}}')).toBe(true);
  });

  it("recognises this app's own pre-send refusals", () => {
    expect(isDrawingKeyLow("This drawing session has too little gas allowance for the next batch.")).toBe(true);
    expect(isDrawingKeyLow("The drawing-session gas allowance is exhausted.")).toBe(true);
  });

  it("does not blame the key when the account itself is short: a new key would not help", () => {
    expect(isDrawingKeyLow("Sender alice.testnet does not have enough balance 1 for transaction costing 2")).toBe(false);
    expect(isDrawingKeyLow("Price rose above max")).toBe(false);
    expect(isDrawingKeyLow(null)).toBe(false);
  });
});
