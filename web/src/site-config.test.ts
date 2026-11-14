/**
 * The deploy config is load-bearing for agents: `/skill.md` is fetched by
 * machines, not people.
 *
 * The catch-all rewrite `/(.*)` → index.html meant a missing file returned the
 * app HTML with a 200. An agent asking for a path that does not exist would
 * receive a web page, decide the wall has no rules, and stop — with no error to
 * act on. These tests pin the exclusion and the files it protects.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string }>;
};

/** The SPA catch-all. It is not the first rewrite: `/api/*` is proxied to the board server before it. */
function spaRewrite(): { source: string; destination: string } {
  const rewrite = config.rewrites.find((r) => r.destination === "/index.html");
  if (!rewrite) throw new Error("vercel.json has no rewrite to /index.html");
  return rewrite;
}

describe("vercel.json", () => {
  it("proxies /api/* to the board server before the SPA catch-all", () => {
    const api = config.rewrites.findIndex((r) => r.source === "/api/:path*");
    expect(api).toBeGreaterThanOrEqual(0);
    expect(api).toBeLessThan(config.rewrites.indexOf(spaRewrite()));
  });

  it("does not send file paths through the SPA rewrite", () => {
    const rewrite = spaRewrite();
    expect(rewrite.destination).toBe("/index.html");
    // `/skill.md`, `/llms.txt`, `/robots.txt`, `/favicon.ico` must 404 when absent
    // rather than return index.html with a 200.
    for (const path of ["/skill.md", "/llms.txt", "/robots.txt", "/favicon.ico", "/art/one.png"]) {
      expect(path).not.toMatch(new RegExp(`^${rewrite.source}$`));
    }
  });

  it("still routes app paths to the shell", () => {
    const rewrite = spaRewrite();
    const pattern = new RegExp(`^${rewrite.source}$`);
    for (const path of ["/", "/wall", "/agents", "/how-it-works"]) {
      expect(pattern.test(path)).toBe(true);
    }
  });

  it("ships the files agents are told to fetch", () => {
    for (const file of ["public/skill.md", "public/llms.txt"]) {
      const path = resolve(root, file);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(500);
    }
  });
});
