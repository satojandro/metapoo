import { describe, expect, it } from "vitest";
import { buildHref, matchRoute, normalizePath, parseQuery } from "./routes";

describe("normalizePath", () => {
  it("keeps root and strips trailing slashes", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/wall/")).toBe("/wall");
    expect(normalizePath("bounties")).toBe("/bounties");
  });
});

describe("matchRoute", () => {
  it("maps the documented app routes", () => {
    expect(matchRoute("/").pageId).toBe("home");
    expect(matchRoute("/wall").pageId).toBe("wall");
    expect(matchRoute("/bounties").pageId).toBe("bounties");
    expect(matchRoute("/bounties/new").pageId).toBe("bounties/new");
    expect(matchRoute("/bounties/abc%201").pageId).toBe("bounties/:id");
    expect(matchRoute("/bounties/abc%201").params.id).toBe("abc 1");
    expect(matchRoute("/history").pageId).toBe("history");
    expect(matchRoute("/prints/p1").pageId).toBe("prints/:id");
    expect(matchRoute("/prints/p1").params.id).toBe("p1");
    expect(matchRoute("/account").pageId).toBe("account");
    expect(matchRoute("/nope").pageId).toBe("not-found");
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
    expect(parseQuery("?token=ed1").token).toBe("ed1");
    expect(buildHref("/prints/p1", { token: "ed1" })).toBe("/prints/p1?token=ed1");
    expect(buildHref("/wall", { x: undefined, y: "" })).toBe("/wall");
  });
});
