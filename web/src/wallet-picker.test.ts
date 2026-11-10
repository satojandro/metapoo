import { describe, expect, it, vi } from "vitest";
import {
  HIDDEN_WALLET_IDS,
  SELECTED_WALLET_KEY,
  pickerExcludedWallets,
  promoteWallet,
} from "./wallet";
import { PRIVY_WALLET_ID } from "./integrations/privy/config";

const wallet = (id: string) => ({ manifest: { id } });
const storageWith = (selected: string | null) => ({
  getItem: (key: string) => (key === SELECTED_WALLET_KEY ? selected : null),
});


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
  it("keeps the wallet a returning player is signed in with, so the session still restores", () => {
    // near-connect resolves the stored `selected-wallet` against its own wallet list, so an
    // excluded id means "No wallet selected" and the stored id is deleted on the next lookup.
    for (const id of HIDDEN_WALLET_IDS) {
      const excluded = pickerExcludedWallets(storageWith(id));
      expect(excluded).not.toContain(id);
      expect(excluded).toHaveLength(HIDDEN_WALLET_IDS.length - 1);
    }
    expect(pickerExcludedWallets(storageWith("ledger")).sort()).toEqual([
      "ethereum-wallets",
      "near-cli",
      "trezu-wallet",
    ]);
  });
  it("hides all four when nothing is selected, and survives storage that throws", () => {
    expect(pickerExcludedWallets(storageWith(null))).toEqual([...HIDDEN_WALLET_IDS]);
    expect(pickerExcludedWallets(storageWith("hot-wallet"))).toEqual([...HIDDEN_WALLET_IDS]);
    expect(
      pickerExcludedWallets({
        getItem: () => {
          throw new Error("storage blocked");
        },
      }),
    ).toEqual([...HIDDEN_WALLET_IDS]);
    expect(pickerExcludedWallets(undefined)).toEqual([...HIDDEN_WALLET_IDS]);
  });
});
