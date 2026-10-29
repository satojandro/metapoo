/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { wireWalletDetailsClose } from "./wallet-details-close";

function openPanel(): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "wallet-details";
  details.innerHTML = `<summary>Paint &amp; wallet</summary><p>balances</p>`;
  document.body.append(details);
  details.open = true;
  wireWalletDetailsClose(details);
  return details;
}

describe("wireWalletDetailsClose", () => {
  it("closes when the Close button is clicked", () => {
    const details = openPanel();
    const close = details.querySelector<HTMLButtonElement>(".wallet-details-close");
    expect(close).not.toBeNull();
    close!.click();
    expect(details.open).toBe(false);
    details.remove();
  });

  it("closes when the pointer lands outside the panel", () => {
    const details = openPanel();
    const outside = document.createElement("div");
    document.body.append(outside);
    // Capture listener on document sees the original target during the capture phase.
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(details.open).toBe(false);
    outside.remove();
    details.remove();
  });

  it("closes on Escape", () => {
    const details = openPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(details.open).toBe(false);
    details.remove();
  });

  it("does not close when the pointer stays inside the panel", () => {
    const details = openPanel();
    const inside = details.querySelector("p")!;
    const event = new PointerEvent("pointerdown", { bubbles: true });
    Object.defineProperty(event, "target", { value: inside });
    document.dispatchEvent(event);
    expect(details.open).toBe(true);
    details.remove();
  });
});
