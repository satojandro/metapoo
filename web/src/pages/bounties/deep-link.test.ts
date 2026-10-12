import { describe, expect, it } from "vitest";
import {
  buildHelpPaintDeepLink,
  clampBoardCoord,
  clampZoom,
  deepLinkForBountyCrop,
  parseHelpPaintSearch,
} from "./deep-link";

describe("buildHelpPaintDeepLink", () => {
  it("builds /wall links with board, x, y, zoom, bounty, and optional template", () => {
    const href = buildHelpPaintDeepLink({
      board: "board-main",
      x: 40,
      y: 20,
      zoom: 8,
      bounty: "1",
      template: "tmpl-stall-mascot",
    });
    expect(href.startsWith("/wall?")).toBe(true);
    const params = new URLSearchParams(href.slice("/wall?".length));
    expect(params.get("board")).toBe("board-main");
    expect(params.get("x")).toBe("40");
    expect(params.get("y")).toBe("20");
    expect(params.get("zoom")).toBe("8");
    expect(params.get("bounty")).toBe("1");
    expect(params.get("template")).toBe("tmpl-stall-mascot");
  });

  it("omits template when absent", () => {
    const href = buildHelpPaintDeepLink({
      board: "board-main",
      x: 0,
      y: 0,
      zoom: 4,
      bounty: "2",
    });
    expect(href.includes("template=")).toBe(false);
  });

  it("clamps coordinates and zoom", () => {
    expect(clampBoardCoord(-3)).toBe(0);
    expect(clampBoardCoord(200)).toBe(127);
    expect(clampZoom(0)).toBe(8);
    expect(clampZoom(100)).toBe(64);
    const href = buildHelpPaintDeepLink({
      board: "board-main",
      x: 999,
      y: -1,
      zoom: 0,
      bounty: "9",
    });
    const params = new URLSearchParams(href.slice("/wall?".length));
    expect(params.get("x")).toBe("127");
    expect(params.get("y")).toBe("0");
    expect(params.get("zoom")).toBe("8");
  });
});

describe("deepLinkForBountyCrop", () => {
  it("focuses the crop origin for Help paint", () => {
    const href = deepLinkForBountyCrop(
      "1",
      "board-main",
      { x: 40, y: 20, width: 24, height: 24 },
      "tmpl-stall-mascot",
    );
    expect(href).toContain("bounty=1");
    expect(href).toContain("x=40");
    expect(href).toContain("y=20");
    expect(href).toContain("template=tmpl-stall-mascot");
  });
});

describe("parseHelpPaintSearch", () => {
  it("parses and clamps query params", () => {
    expect(parseHelpPaintSearch("?board=board-main&x=10&y=11&zoom=4&bounty=1")).toEqual(
      {
        board: "board-main",
        x: 10,
        y: 11,
        zoom: 4,
        bounty: "1",
        template: null,
      },
    );
  });

  it("rejects non-integer coordinates", () => {
    const parsed = parseHelpPaintSearch("?board=b&x=1.5&y=abc&zoom=nope&bounty=1");
    expect(parsed.x).toBeNull();
    expect(parsed.y).toBeNull();
    expect(parsed.zoom).toBeNull();
  });
});
