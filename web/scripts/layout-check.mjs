#!/usr/bin/env node
/**
 * Layout check: nothing may sit on top of the wall.
 *
 * Loads a running dev server at desktop (1440 × 900) and phone (390 × 844) sizes and
 * fails if any visible element overlaps the board canvas (#board), other than the
 * board's own ancestors and the overlays inside #board-viewport (selection ring,
 * pointer preview, pending marks).
 *
 * Uses the machine's Playwright and Chromium; it is not an npm dependency.
 *
 *   npx vite --port 5174          # in another terminal, from web/
 *   node scripts/layout-check.mjs [http://localhost:5174/]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = await import("playwright"));
}

const url = process.argv[2] ?? "http://localhost:5174/";
const sizes = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
];

const browser = await chromium.launch();
let failures = 0;
try {
  for (const size of sizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: size.mobile,
      hasTouch: size.mobile,
    });
    const page = await context.newPage();
    // The board polls, so the network never goes idle: wait for load, then settle.
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(3000);

    const report = await page.evaluate(() => {
      const board = document.querySelector("#board");
      const viewport = document.querySelector("#board-viewport");
      if (!board) return { error: "#board not found" };
      const b = board.getBoundingClientRect();
      const overlaps = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (el === board || el.contains(board)) continue; // the board and its ancestors
        if (viewport && viewport.contains(el)) continue; // selection and pending overlays
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
        const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
        if (w > 1 && h > 1) {
          const name = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
          overlaps.push(`${name} (${Math.round(w)} × ${Math.round(h)} px)`);
        }
      }
      return {
        board: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
        overlaps,
      };
    });

    if (report.error) {
      failures += 1;
      console.log(`${size.name}: FAIL ${report.error}`);
    } else if (report.overlaps.length > 0) {
      failures += 1;
      console.log(`${size.name}: FAIL board ${JSON.stringify(report.board)} is overlapped by:`);
      for (const line of report.overlaps) console.log(`  ${line}`);
    } else {
      console.log(`${size.name}: ok, nothing overlaps the board ${JSON.stringify(report.board)}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
