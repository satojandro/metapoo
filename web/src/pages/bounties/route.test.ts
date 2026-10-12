import { describe, expect, it } from "vitest";
import {
  isBountyPath,
  normalizePath,
  parseBountyPath,
  parseListSearch,
  parseStatusFilter,
} from "./route";

describe("parseBountyPath", () => {
  it("recognizes the browse and create routes", () => {
    expect(parseBountyPath("/bounties")).toEqual({ name: "list" });
    expect(parseBountyPath("/bounties/")).toEqual({ name: "list" });
    expect(parseBountyPath("/bounties/new")).toEqual({ name: "create" });
  });

  it("parses decimal-string and fixture bounty ids", () => {
    expect(parseBountyPath("/bounties/1")).toEqual({ name: "detail", id: "1" });
    expect(parseBountyPath("/bounties/42")).toEqual({
      name: "detail",
      id: "42",
    });
    expect(parseBountyPath("/bounties/lag")).toEqual({
      name: "detail",
      id: "lag",
    });
  });

  it("rejects unsafe or nested paths", () => {
    expect(parseBountyPath("/bounties/../x")).toEqual({ name: "unknown" });
    expect(parseBountyPath("/bounties/1/edit")).toEqual({ name: "unknown" });
    expect(parseBountyPath("/wall")).toEqual({ name: "unknown" });
  });

  it("strips query and hash before matching", () => {
    expect(normalizePath("/bounties/3?x=1#top")).toBe("/bounties/3");
    expect(parseBountyPath("/bounties/3?funded=1")).toEqual({
      name: "detail",
      id: "3",
    });
  });
});

describe("parseListSearch", () => {
  it("defaults to funded-only browse", () => {
    expect(parseListSearch("")).toEqual({
      fundedOnly: true,
      status: "ALL",
      query: "",
    });
  });

  it("parses filter query params", () => {
    expect(parseListSearch("?funded=0&status=ACTIVE&q=mural")).toEqual({
      fundedOnly: false,
      status: "ACTIVE",
      query: "mural",
    });
  });

  it("ignores unsupported status values", () => {
    expect(parseStatusFilter("nope")).toBe("ALL");
    expect(parseStatusFilter("review")).toBe("REVIEW");
  });
});

describe("isBountyPath", () => {
  it("matches the bounty package prefix only", () => {
    expect(isBountyPath("/bounties")).toBe(true);
    expect(isBountyPath("/bounties/new")).toBe(true);
    expect(isBountyPath("/bounties/9")).toBe(true);
    expect(isBountyPath("/history")).toBe(false);
  });
});
