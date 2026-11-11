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
import { matchRoute } from "./routes";

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
    expect(navHrefs).toEqual(["/wall", "/how-it-works", "/agents", "/toilet", "/stake", "/money"]);
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

  it("places the site footer inside the scrolling outlet, last, so it costs the wall no height", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());
    shell.placeFooter(matchRoute("/wall"));

    const outlet = host.querySelector(".page-outlet")!;
    expect(outlet.lastElementChild?.classList.contains("site-foot")).toBe(true);
    // Sibling of the header, not of the outlet: a footer bar outside the outlet
    // would shrink every route, including the wall.
    expect(host.querySelector(".app-shell-top + .page-outlet")).not.toBeNull();
    shell.dispose();
  });

  it("re-appends the footer after the router replaces the outlet, without duplicating it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    shell.placeFooter(matchRoute("/wall"));
    shell.outlet.replaceChildren(document.createElement("div"));
    shell.placeFooter(matchRoute("/money"));
    shell.placeFooter(matchRoute("/money"));

    expect(shell.outlet.querySelectorAll(".site-foot")).toHaveLength(1);
    expect(shell.outlet.lastElementChild?.classList.contains("site-foot")).toBe(true);
    shell.dispose();
  });

  it("keeps the owner console free of the public footer", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    shell.placeFooter(matchRoute("/admin"));
    expect(shell.outlet.querySelector(".site-foot")).toBeNull();
    shell.dispose();
  });
});
