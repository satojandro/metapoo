/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "./router";
import {
  clearPageMounts,
  registerPageMount,
  type PageDispose,
} from "./page-registry";
import { createOperationsStore } from "./operations";
import type { AppServices } from "./services";
import type { WalletSession } from "../wallet";

function fakeServices(): AppServices {
  let session: WalletSession = { accountId: null, networkId: null };
  return {
    wallet: {
      getSession: () => session,
      connect: async () => {
        session = { accountId: "a.testnet", networkId: "testnet" };
      },
      disconnect: async () => {
        session = { accountId: null, networkId: null };
      },
      subscribe: (listener) => {
        listener(session);
        return () => undefined;
      },
      whenReady: Promise.resolve(session),
    },
    operations: createOperationsStore(),
  };
}

describe("router dispose", () => {
  beforeEach(() => {
    clearPageMounts();
    document.body.innerHTML = '<div id="outlet"></div>';
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    clearPageMounts();
    document.body.innerHTML = "";
  });

  it("calls the previous page dispose when navigating away", () => {
    const disposed: string[] = [];
    const timersCleared: number[] = [];

    registerPageMount("home", (root) => {
      root.textContent = "home";
      const handle = window.setInterval(() => undefined, 60_000);
      const dispose: PageDispose = () => {
        window.clearInterval(handle);
        timersCleared.push(handle);
        disposed.push("home");
        root.replaceChildren();
      };
      return dispose;
    });

    registerPageMount("wall", (root) => {
      root.textContent = "wall";
      return () => {
        disposed.push("wall");
        root.replaceChildren();
      };
    });

    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({
      outlet,
      services: fakeServices(),
    });
    router.start();
    expect(outlet.textContent).toBe("home");

    router.navigate("/wall");
    expect(disposed).toEqual(["home"]);
    expect(outlet.textContent).toBe("wall");
    expect(timersCleared).toHaveLength(1);

    router.navigate("/");
    expect(disposed).toEqual(["home", "wall"]);

    router.stop();
    // stop disposes the current (home remount)
    expect(disposed).toContain("home");
    expect(outlet.textContent).toBe("");
  });

  it("keeps operations store contents across dispose", () => {
    const services = fakeServices();
    services.operations.upsert({
      id: "paint:1",
      kind: "paint",
      phase: "submitted",
      accountId: "a.testnet",
      networkId: "testnet",
      transactionId: "tx1",
      title: "Paint",
      detail: "in flight",
    });

    registerPageMount("home", (root) => {
      root.textContent = "home";
      return () => root.replaceChildren();
    });
    registerPageMount("wall", (root) => {
      root.textContent = "wall";
      return () => root.replaceChildren();
    });

    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services });
    router.start();
    router.navigate("/wall");
    router.navigate("/");

    expect(services.operations.listRecoverable()).toHaveLength(1);
    expect(services.operations.listRecoverable()[0].transactionId).toBe("tx1");
    router.stop();
  });

  it("lets a later registerPageMount override an earlier one", () => {
    registerPageMount("wall", (root) => {
      root.textContent = "stub";
      return () => root.replaceChildren();
    });

    // Later registration wins.
    registerPageMount("wall", (root) => {
      root.textContent = "override";
      return () => root.replaceChildren();
    });

    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services: fakeServices() });
    router.start();
    router.navigate("/wall");
    expect(outlet.textContent).toBe("override");
    router.stop();
  });

  it("removes popstate listener on stop", () => {
    const spy = vi.spyOn(window, "removeEventListener");
    registerPageMount("home", (root) => {
      root.textContent = "home";
      return () => root.replaceChildren();
    });
    const outlet = document.querySelector<HTMLElement>("#outlet")!;
    const router = createRouter({ outlet, services: fakeServices() });
    router.start();
    router.stop();
    expect(spy).toHaveBeenCalledWith("popstate", expect.any(Function));
    spy.mockRestore();
  });
});
