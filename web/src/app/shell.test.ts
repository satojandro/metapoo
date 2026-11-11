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
import type { AppServices } from "./services";
import { createOperationsStore } from "./operations";
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

  it("gives the money route a phone-sized nav label without renaming the page", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const money = host.querySelector<HTMLAnchorElement>('a[href="/money"]')!;
    expect(money.querySelector(".app-nav-long")?.textContent).toBe("Where the money goes");
    expect(money.querySelector(".app-nav-short")?.textContent).toBe("Money");
    // One link, one accessible name: the abbreviation is layout only.
    expect(money.getAttribute("aria-label")).toBe("Where the money goes");
    // The tab title and PAGE_NAMES keep the full label (batch 1's rule).
    const { pageTitle } = await import("./shell");
    expect(pageTitle("money")).toBe("Where the money goes · Meta Poo");
    shell.dispose();
  });

  it("shows one wallet control: Connect while disconnected, the panel hidden", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());

    const connect = host.querySelector<HTMLButtonElement>("#connect-button")!;
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;
    expect(connect.textContent).toBe("Connect wallet");
    // Connecting is the first-time player's main call to action: it stays the primary
    // button. Disconnect, once connected, is not (review, 11 Nov).
    expect(connect.classList.contains("mp-btn-primary")).toBe(true);
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
    // The label says what the key does and what it cannot do (UI review B3): the old
    // text named the mechanism ("without a popup") and left the player to guess.
    expect(optIn.textContent).toContain("Paint without approving every stroke");
    expect(optIn.textContent).toContain("only paint here");
    expect(optIn.textContent).toContain("can’t move your funds");
    expect(optIn.querySelector(".drawing-session-opt-in-note")).not.toBeNull();
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

  it("orders the wallet panel: balances, buy, claim, move funds, links, technical details, disconnect", () => {
    const host = document.createElement("div");
    document.body.append(host);
    // A connected session puts Disconnect inside the panel, which is the order under test.
    const services: AppServices = {
      wallet: {
        getSession: () => ({ accountId: "alice.near", networkId: "mainnet" }),
        connect: async () => {},
        disconnect: async () => {},
        subscribe: () => () => {},
        whenReady: Promise.resolve({ accountId: "alice.near", networkId: "mainnet" }),
      },
      operations: createOperationsStore(),
    };
    const shell = mountShell(host, services);
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;

    const order = [
      ".wallet-account-head",
      "#paint-wallet-panel",
      "#toilet-wallet-panel",
      "#wallet-move-funds",
      ".wallet-links",
      ".wallet-technical",
      "#connect-button",
    ].map((selector) => details.querySelector(selector));
    for (const element of order) expect(element).not.toBeNull();
    // compareDocumentPosition: FOLLOWING means the element after it comes later in the panel.
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Disconnect is not the same weight as Claim and Add funds.
    expect(order.at(-1)!.className).not.toContain("mp-btn-primary");
    shell.dispose();
  });

  it("keeps the header to one row and the chain detail closed and short", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shell = mountShell(host, createAppServices());
    const details = host.querySelector<HTMLDetailsElement>("details.wallet-details")!;

    // Address, copy and Close share the header row; the copy is an icon button with a label.
    const head = details.querySelector(".wallet-account-head")!;
    expect(head.querySelector("[data-account-id]")).not.toBeNull();
    expect(head.querySelector(".wallet-account-copy")?.getAttribute("aria-label")).toBe("Copy address");
    expect(head.querySelector(".wallet-details-close")).not.toBeNull();
    // The 64-character id is not repeated as a second box.
    expect(details.querySelectorAll("[data-account-id]")).toHaveLength(1);
    expect(details.querySelector("h2")?.textContent).not.toBe("Connection details");
    const technical = details.querySelector<HTMLDetailsElement>("details.wallet-technical")!;
    expect(technical.open).toBe(false);
    expect(technical.querySelector("summary")!.textContent).toBe("Technical details");
    shell.dispose();
  });
});
