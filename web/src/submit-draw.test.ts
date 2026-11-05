import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ local: vi.fn(), wallet: vi.fn() }));
vi.mock("./contract", () => ({ isContractConfigured: () => true, confirmPixelAfterDraw: vi.fn() }));
vi.mock("./wallet", () => ({ signAndSendDraw: mocks.wallet }));
vi.mock("./local-draw", async () => {
  const actual = await vi.importActual<typeof import("./local-draw")>("./local-draw");
  return { ...actual, canUseLocalDrawingSession: () => true, signAndSendDrawLocally: mocks.local };
});
import { LocalDrawError } from "./local-draw";
import { submitDraw } from "./submit-draw";

const input = { x: 1, y: 2, colorIndex: 3, accountId: "alice.near", networkId: "mainnet" as const, maxCredits: 1 };

beforeEach(() => vi.clearAllMocks());

describe("painting with an active drawing session", () => {
  // Issue #70: a throttled pre-send read opened the wallet even though the
  // painter had already authorized a drawing key.
  it("reports a busy network instead of opening the wallet", async () => {
    mocks.local.mockRejectedValueOnce(new LocalDrawError("rpc", "Network busy. Please retry shortly."));
    const result = await submitDraw(input);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", title: "Network busy — paint not sent", transactionId: null });
  });

  it("asks for a renewed session instead of opening the wallet when the key is gone", async () => {
    mocks.local.mockRejectedValueOnce(new LocalDrawError("key_missing", "The drawing-session key is not on this account anymore."));
    const result = await submitDraw(input);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", title: "Drawing session needs renewing" });
  });

  it("never resubmits through the wallet after a possible broadcast", async () => {
    mocks.local.mockRejectedValueOnce(new LocalDrawError("rpc", "lost response", true));
    const result = await submitDraw(input);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(result.status).toBe("confirmation_delayed");
  });
});
