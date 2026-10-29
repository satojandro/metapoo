import { describe, expect, it } from "vitest";
import { buildWallLink, clampBoardCoord, clampZoom, parseWallLinkSearch } from "./wall-link";

describe("buildWallLink", () => {
  it("builds /wall links with board, x, y and zoom", () => {
    const href = buildWallLink({ board: "board-main", x: 40, y: 20, zoom: 8 });
    expect(href.startsWith("/wall?")).toBe(true);
    const params = new URLSearchParams(href.slice("/wall?".length));
    expect(params.get("board")).toBe("board-main");
    expect(params.get("x")).toBe("40");
    expect(params.get("y")).toBe("20");
    expect(params.get("zoom")).toBe("8");
  });

  it("clamps coordinates and zoom", () => {
    expect(clampBoardCoord(-3)).toBe(0);
    expect(clampBoardCoord(200)).toBe(127);
    expect(clampZoom(0)).toBe(8);
    expect(clampZoom(100)).toBe(64);
    const href = buildWallLink({ board: "board-main", x: 999, y: -1, zoom: 0 });
    const params = new URLSearchParams(href.slice("/wall?".length));
    expect(params.get("x")).toBe("127");
    expect(params.get("y")).toBe("0");
    expect(params.get("zoom")).toBe("8");
  });
});

describe("parseWallLinkSearch", () => {
  it("parses and clamps query params", () => {
    expect(parseWallLinkSearch("?board=board-main&x=10&y=11&zoom=4")).toEqual({
      board: "board-main",
      x: 10,
      y: 11,
      zoom: 4,
    });
  });

  it("rejects non-integer coordinates", () => {
    const parsed = parseWallLinkSearch("?board=b&x=1.5&y=abc&zoom=nope");
    expect(parsed.x).toBeNull();
    expect(parsed.y).toBeNull();
    expect(parsed.zoom).toBeNull();
  });
});
