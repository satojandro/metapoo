/**
 * The share tags are the one part of the page a crawler reads before any JavaScript
 * runs, so they are written into index.html with `%VITE_SITE_URL%` and resolved at
 * build time. This pins both halves of that arrangement: the placeholder is used, and
 * no host is baked in — a domain move must be one environment variable, not an edit
 * here (review, 11 Nov). `vite.config.ts` fails the build outright if it is unset.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");

describe("share tags", () => {
  it("builds every absolute URL from VITE_SITE_URL, not from a hard-coded host", () => {
    expect(html).toContain('property="og:url" content="%VITE_SITE_URL%"');
    expect(html).toContain("%VITE_SITE_URL%/og.png");
    expect(html).not.toMatch(/https?:\/\/metapoo-testnet\.vercel\.app/);
  });

  it("keeps the card and the favicon reachable at the path the tags point at", () => {
    expect(html).toContain('rel="icon"');
    expect(html).toContain('content="summary_large_image"');
  });
});
