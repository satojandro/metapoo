/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_URL,
  MPOO_CHART_URL,
  TELEGRAM_URL,
  X_URL,
  safeUrl,
  socialLinks,
} from "./social-links";

describe("social links", () => {
  it("pins every community URL literally, so a typo is a red test and not a 404", () => {
    expect(X_URL).toBe("https://x.com/MetaPoo67");
    expect(TELEGRAM_URL).toBe("https://t.me/metapoo67");
    expect(GITHUB_URL).toBe("https://github.com/satojandro/metapoo");
  });

  it("pins the mPOO chart to the one pair Dexscreener serves for the token", () => {
    // pairAddress from api.dexscreener.com/token-pairs/v1/near/mpoo.nearlytrade.near
    expect(MPOO_CHART_URL).toBe(
      "https://dexscreener.com/near/refv2-diarhea.nearlytrade.near:mpoo.nearlytrade.near:10000",
    );
    // The pair path must name the on-chain token, not a lookalike.
    expect(MPOO_CHART_URL).toContain(":mpoo.nearlytrade.near:");
  });

  it("lists community links first, then markets", () => {
    const links = socialLinks();
    expect(links.map((link) => link.id)).toEqual(["x", "telegram", "github", "mpoo-chart"]);
    expect(links.map((link) => link.group)).toEqual([
      "community",
      "community",
      "community",
      "markets",
    ]);
    expect(links.map((link) => link.label)).toEqual(["X", "Telegram", "GitHub", "$mPOO chart"]);
  });

  it("only ever emits absolute http(s) links", () => {
    for (const link of socialLinks({ VITE_DEXSCREENER_TOILET_URL: "https://dexscreener.com/near/x" })) {
      expect(() => new URL(link.href)).not.toThrow();
      expect(link.href.startsWith("https://")).toBe(true);
    }
  });

  it("names the destination for screen readers, including that it leaves the site", () => {
    for (const link of socialLinks()) {
      expect(link.ariaLabel).toContain("opens in a new tab");
      expect(link.ariaLabel.toLowerCase()).toContain(link.label.replace("$", "").toLowerCase());
    }
  });

  it("omits the TOILET chart while no pair is configured, because none exists", () => {
    expect(socialLinks().some((link) => link.id === "toilet-chart")).toBe(false);
    expect(socialLinks({ VITE_DEXSCREENER_TOILET_URL: "" }).some((l) => l.id === "toilet-chart")).toBe(
      false,
    );
    expect(socialLinks({ VITE_DEXSCREENER_TOILET_URL: "   " }).some((l) => l.id === "toilet-chart")).toBe(
      false,
    );
  });

  it("adds the TOILET chart once a real pair URL is configured, last in the markets group", () => {
    const links = socialLinks({ VITE_DEXSCREENER_TOILET_URL: "https://dexscreener.com/near/pair" });
    expect(links.map((link) => link.id)).toEqual([
      "x",
      "telegram",
      "github",
      "mpoo-chart",
      "toilet-chart",
    ]);
    expect(links.at(-1)?.href).toBe("https://dexscreener.com/near/pair");
  });

  it("drops a configured URL that is not http(s)", () => {
    for (const raw of ["javascript:alert(1)", "dexscreener.com/near/x", "not a url"]) {
      expect(socialLinks({ VITE_DEXSCREENER_TOILET_URL: raw }).some((l) => l.id === "toilet-chart")).toBe(
        false,
      );
    }
  });
});

describe("safeUrl", () => {
  it("keeps absolute http(s) URLs and rejects everything else", () => {
    expect(safeUrl("https://x.com/MetaPoo67")).toBe("https://x.com/MetaPoo67");
    expect(safeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("//example.com")).toBeNull();
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
