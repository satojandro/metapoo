import { describe, expect, it } from "vitest";
import { buildHref, matchRoute, normalizePath, parseQuery } from "./routes";

describe("normalizePath", () => {
  it("keeps root and strips trailing slashes", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/wall/")).toBe("/wall");
    expect(normalizePath("wall")).toBe("/wall");
  });
});

describe("matchRoute", () => {
  it("maps the documented app routes", () => {
    expect(matchRoute("/").pageId).toBe("home");
    expect(matchRoute("/wall").pageId).toBe("wall");
    expect(matchRoute("/nope").pageId).toBe("not-found");
  });

  it("sends retired routes to not-found", () => {
    for (const path of ["/bounties", "/bounties/1", "/history", "/prints/p1", "/account"]) {
      expect(matchRoute(path).pageId).toBe("not-found");
    }
  });

  it("parses known query keys without treating them as trusted prices", () => {
    const route = matchRoute("/wall", "?x=3&y=4&zoom=2&board=main&bogus=1");
    expect(route.query.x).toBe("3");
    expect(route.query.y).toBe("4");
    expect(route.query.zoom).toBe("2");
    expect(route.query.board).toBe("main");
    expect(route.query.bogus).toBe("1");
  });
});

describe("parseQuery / buildHref", () => {
  it("round-trips simple query objects", () => {
    expect(parseQuery("?x=3").x).toBe("3");
    expect(buildHref("/wall", { x: "3" })).toBe("/wall?x=3");
    expect(buildHref("/wall", { x: undefined, y: "" })).toBe("/wall");
  });
});
