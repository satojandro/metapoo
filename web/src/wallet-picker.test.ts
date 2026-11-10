import { describe, expect, it, vi } from "vitest";
import { HIDDEN_WALLET_IDS, promoteWallet } from "./wallet";
import { PRIVY_WALLET_ID } from "./integrations/privy/config";

const wallet = (id: string) => ({ manifest: { id } });

describe("wallet picker", () => {
  it("moves Privy from the end of the list to the top and tells the selector", () => {
    const target = {
      wallets: [wallet("hot-wallet"), wallet("meteor-wallet"), wallet(PRIVY_WALLET_ID)],
      events: { emit: vi.fn() },
    };
    promoteWallet(target as never, PRIVY_WALLET_ID);
    expect(target.wallets.map((w) => w.manifest.id)).toEqual([
      PRIVY_WALLET_ID,
      "hot-wallet",
      "meteor-wallet",
    ]);
    expect(target.events.emit).toHaveBeenCalledWith("selector:walletsChanged", {});
  });
  it("leaves the list alone when the wallet is missing or already first", () => {
    const target = {
      wallets: [wallet(PRIVY_WALLET_ID), wallet("hot-wallet")],
      events: { emit: vi.fn() },
    };
    promoteWallet(target as never, PRIVY_WALLET_ID);
    promoteWallet(target as never, "absent");
    expect(target.wallets.map((w) => w.manifest.id)).toEqual([PRIVY_WALLET_ID, "hot-wallet"]);
    expect(target.events.emit).not.toHaveBeenCalled();
  });
  it("hides the developer, bridge, treasury and hardware entries, never HOT", () => {
    expect([...HIDDEN_WALLET_IDS].sort()).toEqual(
      ["ethereum-wallets", "ledger", "near-cli", "trezu-wallet"],
    );
    expect(HIDDEN_WALLET_IDS).not.toContain("hot-wallet" as never);
  });
});
