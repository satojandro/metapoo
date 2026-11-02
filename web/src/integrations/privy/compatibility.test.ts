import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVY_CORE_VERSION, PRIVY_PACKAGE_VERSION } from "./config";
import { checkedSdkWallet } from "./sdk-wallet";

const require = createRequire(import.meta.url);
describe("pinned Privy adapter compatibility", () => {
  it("serves the exact inspected executor bytes, including blocked-popup and readiness timeout handling", () => {
    const executor = require.resolve("@peerfolio/privy-near-connect/executor");
    const installed = readFileSync(executor, "utf8");
    const vendored = readFileSync(
      new URL("./vendor-executor.js", import.meta.url),
      "utf8",
    );
    expect(vendored).toBe(installed);
    expect(createHash("sha256").update(vendored).digest("hex")).toBe(
      "16b05e82289d0d56bcada4df387cb63e4ccbe1390907c3cf6fe9e94f7e31c132",
    );
    expect(vendored).toContain("READY_TIMEOUT_MS");
    expect(vendored).toContain("popup.windowIdPromise");
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(executor), "../package.json"),
        "utf8",
      ),
    );
    expect(pkg.version).toBe(PRIVY_PACKAGE_VERSION);
    const coreEntry = require.resolve("@privy-io/js-sdk-core");
    const corePkg = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(coreEntry), "../../package.json"),
        "utf8",
      ),
    );
    expect(corePkg.version).toBe(PRIVY_CORE_VERSION);
  });
  it("requires the real complete embedded wallet metadata rather than casting incomplete records", () => {
    const minimal = {
      type: "wallet",
      chain_type: "near",
      id: "wallet-1",
      address: "12".repeat(32),
    };
    expect(() => checkedSdkWallet(minimal)).toThrow("incomplete");
    const full = {
      ...minimal,
      chain_id: "near",
      connector_type: "embedded",
      delegated: false,
      first_verified_at: 1,
      imported: false,
      latest_verified_at: 1,
      public_key: "provider-key",
      recovery_method: "privy-v2",
      verified_at: 1,
      wallet_client: "privy",
      wallet_client_type: "privy",
      wallet_index: 0,
      user_can_sign: true,
    };
    expect(checkedSdkWallet(full)).toBe(full);
    expect(() => checkedSdkWallet({ ...full, user_can_sign: false })).toThrow(
      "non-signing",
    );
  });
});
