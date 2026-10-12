/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { mountWall } from "./mount-wall";

describe("mountWall dispose", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="flow-state"></p>
      <p id="compact-status"></p>
      <div id="wallet-error"></div>
      <div id="root"></div>
    `;
    vi.spyOn(window, "setTimeout");
    vi.spyOn(window, "clearTimeout");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("clears the wall DOM and does not clear shared operations", () => {
    const services = createAppServices();
    services.operations.upsert({
      id: "paint:keep",
      kind: "paint",
      phase: "submitted",
      accountId: "alice.testnet",
      networkId: "testnet",
      transactionId: "tx-keep",
      title: "Paint",
      detail: "must survive dispose",
    });

    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    expect(root.querySelector("#board")).not.toBeNull();
    expect(root.querySelector("#palette")).not.toBeNull();

    dispose();
    expect(root.querySelector("#board")).toBeNull();
    expect(root.childElementCount).toBe(0);
    expect(services.operations.listRecoverable()).toHaveLength(1);
    expect(services.operations.get("paint:keep")?.transactionId).toBe("tx-keep");
  });

  it("is safe to call dispose twice", () => {
    const services = createAppServices();
    const root = document.querySelector<HTMLElement>("#root")!;
    const dispose = mountWall(root, services);
    dispose();
    expect(() => dispose()).not.toThrow();
  });
});
