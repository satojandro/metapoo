/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import { createWallScope } from "./wall-scope";

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, PAGE_NETWORK: "testnet" };
});

describe("wall scope", () => {
  it("removes every listener and runs every cleanup once, ignoring errors", () => {
    const scope = createWallScope();
    const target = new EventTarget();
    const handler = vi.fn();
    const cleanup = vi.fn();
    scope.listen(target, "ping", handler);
    scope.onDispose(() => {
      throw new Error("ignored");
    });
    scope.onDispose(cleanup);
    target.dispatchEvent(new Event("ping"));
    expect(scope.markDisposed()).toBe(true);
    expect(scope.markDisposed()).toBe(false);
    expect(scope.isDisposed()).toBe(true);
    scope.runCleanups();
    scope.runCleanups();
    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("falls back to the page network for an unknown wallet network", () => {
    const scope = createWallScope();
    expect(scope.walletNetworkId()).toBe("testnet");
    scope.setWallet("alice.near", "mainnet");
    expect(scope.walletAccount()).toBe("alice.near");
    expect(scope.walletNetworkId()).toBe("mainnet");
    scope.setWallet("alice.near", "betanet");
    expect(scope.walletNetwork()).toBe("betanet");
    expect(scope.walletNetworkId()).toBe("testnet");
  });
});
