/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// No network in these tests: the wall mounts in preview mode.
vi.mock("../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contract")>();
  return { ...actual, isContractConfigured: () => false };
});
import { createAppServices } from "./services";
import { mountShell } from "./shell";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app shell", () => {
  it("does not list the owner console (/admin) in the public nav or the wallet panel", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const navHrefs = [...host.querySelectorAll<HTMLAnchorElement>(".app-nav a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(navHrefs).toEqual(["/wall", "/how-it-works", "/toilet", "/stake", "/money"]);
    expect(host.querySelector('a[href="/admin"]')).toBeNull();
    shell.dispose();
  });

  it("shows one wallet control: Connect while disconnected, the panel hidden", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const connect = host.querySelector<HTMLButtonElement>("#connect-button")!;
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;
    expect(connect.textContent).toBe("Connect wallet");
    expect(details.hidden).toBe(true);
    expect(details.contains(connect)).toBe(false);
    // The status line is duplicated in the paint dock; the shell copy is screen-reader only.
    expect(host.querySelector(".shell-status")?.classList.contains("visually-hidden")).toBe(true);
    shell.dispose();
  });

  it("keeps the drawing-key opt-in out of the header row (the wall shows it in its dock)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());
    const optIn = host.querySelector<HTMLLabelElement>("label.drawing-session-opt-in")!;
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;
    expect(details.contains(optIn)).toBe(true);
    expect(host.querySelector("#connect-button")!.classList.contains("mp-btn")).toBe(true);
    shell.dispose();
  });

  it("the wall borrows the opt-in into its dock and gives it back on dispose", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const services = createAppServices();
    const shell = mountShell(host, services);
    const { mountWall } = await import("../pages/wall/mount-wall");
    const page = document.createElement("div");
    shell.outlet.append(page);
    const dispose = mountWall(page, services);
    const optIn = host.querySelector<HTMLLabelElement>("label.drawing-session-opt-in")!;
    expect(page.querySelector("#wall-optin-slot")!.contains(optIn)).toBe(true);
    expect(optIn.querySelector("#authorize-drawing-session")).not.toBeNull();
    dispose();
    expect(host.querySelector("details.wallet-details")!.contains(optIn)).toBe(true);
    shell.dispose();
  });

  it("puts the beta notice above the header on every route", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());
    const banner = host.firstElementChild!;
    expect(banner.classList.contains("beta-banner")).toBe(true);
    expect(banner.nextElementSibling?.classList.contains("app-shell-top")).toBe(true);
    expect(host.classList.contains("has-beta-banner")).toBe(true);
    shell.dispose();
  });
});
