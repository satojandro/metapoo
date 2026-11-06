/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { createBetaBanner } from "./beta-banner";

describe("beta banner", () => {
  it("says the board and TOILET are test-only, the board will be paused and TOILET worthless", () => {
    const banner = createBetaBanner({ enabled: true, guideUrl: "", reportUrl: "" })!;
    const text = banner.querySelector(".beta-banner-long")!.textContent!;
    expect(text).toMatch(/TOILET are for testing only/);
    expect(text).toMatch(/will be paused/);
    expect(text).toMatch(/TOILET will be worthless/);
    expect(text).toMatch(/NEAR you spend here is real/);
    expect(banner.getAttribute("role")).toBe("note");
    expect(banner.querySelectorAll("a")).toHaveLength(0);
  });

  it("is on by default: a deployment without the variable still warns", () => {
    expect(createBetaBanner()).not.toBeNull();
  });

  it("disappears only when explicitly turned off", () => {
    expect(createBetaBanner({ enabled: false })).toBeNull();
  });

  it("links the guide and the report form in a new tab", () => {
    const banner = createBetaBanner({
      enabled: true,
      guideUrl: "https://example.notion.site/guide",
      reportUrl: "https://example.notion.site/form",
    })!;
    const links = [...banner.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => a.textContent)).toEqual(["Tester guide", "Report an issue"]);
    expect(links.map((a) => a.href)).toEqual([
      "https://example.notion.site/guide",
      "https://example.notion.site/form",
    ]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
  });

  it("drops links that are not http(s)", () => {
    const banner = createBetaBanner({ enabled: true, guideUrl: "javascript:alert(1)", reportUrl: "not a url" })!;
    expect(banner.querySelectorAll("a")).toHaveLength(0);
  });
});
