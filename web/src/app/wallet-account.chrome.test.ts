/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountWalletChrome } from "./wallet-chrome";
import { shortAccount } from "../shared/short-account";
import type { AppServices } from "./services";

const IMPLICIT = "cc9a" + "0".repeat(56) + "d113";

function mount(accountId: string | null) {
  const root = document.createElement("div");
  root.innerHTML = `
    <button id="connect-button" type="button"></button>
    <details class="wallet-details"><summary>Wallet</summary>
      <section id="wallet-account" hidden>
        <code data-account-id></code>
        <button type="button" class="wallet-account-copy">Copy address</button>
        <p class="wallet-account-note"></p>
      </section>
      <p id="wallet-summary"></p><p id="network-summary"></p>
    </details>
    <p id="wallet-error"></p>`;
  document.body.append(root);
  const services = {
    wallet: {
      getSession: () => ({ accountId, networkId: "mainnet" }),
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
    },
    operations: { subscribe: () => () => {} },
  } as unknown as AppServices;
  return { root, dispose: mountWalletChrome(root, services) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("wallet account block", () => {
  it("shortens only 64-hex implicit ids in the header", () => {
    expect(shortAccount(IMPLICIT)).toBe("cc9a0000…0000d113");
    expect(shortAccount("alice.near")).toBe("alice.near");
  });

  it("shows the full id and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { root, dispose } = mount(IMPLICIT);
    expect(root.querySelector("summary")!.textContent).toBe("cc9a0000…0000d113");
    expect(root.querySelector("summary")!.title).toBe(IMPLICIT);
    expect(root.querySelector<HTMLElement>("#wallet-account")!.hidden).toBe(false);
    expect(root.querySelector("[data-account-id]")!.textContent).toBe(IMPLICIT);
    root.querySelector<HTMLButtonElement>(".wallet-account-copy")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(IMPLICIT);
    expect(root.querySelector(".wallet-account-note")!.textContent).toContain("Address copied");
    dispose();
  });

  it("hides the block while disconnected", () => {
    const { root, dispose } = mount(null);
    expect(root.querySelector<HTMLElement>("#wallet-account")!.hidden).toBe(true);
    dispose();
  });
});
