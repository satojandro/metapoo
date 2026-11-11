/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { createSiteFooter } from "./site-footer";
import { GITHUB_ISSUES_URL, MPOO_CHART_URL } from "../social-links";

describe("site footer", () => {
  it("renders the brand and one link per destination, in order", () => {
    const footer = createSiteFooter({ env: {} });
    expect(footer.tagName).toBe("FOOTER");
    expect(footer.querySelector(".site-foot-brand")?.textContent).toBe("meta poo.");
    const links = [...footer.querySelectorAll<HTMLAnchorElement>("a[data-social-link]")];
    expect(links.map((a) => a.dataset.socialLink)).toEqual([
      "x",
      "telegram",
      "github",
      "mpoo-chart",
    ]);
    expect(links.map((a) => a.querySelector(".site-foot-label")?.textContent)).toEqual([
      "X",
      "Telegram",
      "GitHub",
      "$mPOO chart",
    ]);
    expect(links[3].getAttribute("href")).toBe(MPOO_CHART_URL);
  });

  it("opens every link in a new tab without handing over the opener", () => {
    const footer = createSiteFooter({ env: {} });
    for (const a of footer.querySelectorAll<HTMLAnchorElement>("a")) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
      expect(a.getAttribute("aria-label")).toMatch(/opens .*in a new tab/i);
      // The arrow is decoration; the label is what a screen reader reads.
      expect(a.querySelector(".site-foot-mark")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("carries no heading, so it can never take the route's focus target", () => {
    const footer = createSiteFooter({ env: {} });
    expect(footer.querySelector("h1, h2, h3")).toBeNull();
    expect(footer.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Meta Poo on other platforms",
    );
  });

  it("omits the TOILET chart while no pair exists", () => {
    const footer = createSiteFooter({ env: { VITE_DEXSCREENER_TOILET_URL: "" } });
    expect(footer.querySelector('[data-social-link="toilet-chart"]')).toBeNull();
  });

  it("shows the TOILET chart when a pair URL is configured", () => {
    const footer = createSiteFooter({
      env: { VITE_DEXSCREENER_TOILET_URL: "https://dexscreener.com/near/toilet-pair" },
    });
    const toilet = footer.querySelector<HTMLAnchorElement>('[data-social-link="toilet-chart"]');
    expect(toilet?.href).toBe("https://dexscreener.com/near/toilet-pair");
  });

  it("offers a report link, always, to the public issue tracker (UI review B9)", () => {
    const footer = createSiteFooter({ env: {} });
    const report = footer.querySelector<HTMLAnchorElement>('[data-footer-link="report"]');
    expect(report?.href).toBe(GITHUB_ISSUES_URL);
    expect(report?.querySelector(".site-foot-label")?.textContent).toBe("Report a problem");
    expect(report?.getAttribute("aria-label")).toMatch(/report a problem/);
  });

  it("renders the guide only when an operator configured one, never a dead link", () => {
    expect(createSiteFooter({ env: {} }).querySelector('[data-footer-link="guide"]')).toBeNull();
    expect(createSiteFooter({ env: {}, guideUrl: "   " }).querySelector('[data-footer-link="guide"]')).toBeNull();
    const guide = createSiteFooter({ env: {}, guideUrl: "https://metapoo.example/guide" })
      .querySelector<HTMLAnchorElement>('[data-footer-link="guide"]');
    expect(guide?.href).toBe("https://metapoo.example/guide");
  });
});
