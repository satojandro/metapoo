#!/usr/bin/env node
/**
 * Layout check: nothing may sit on top of the wall, and the wall is never cut off.
 *
 * Loads a running dev server at desktop (1440 × 900) and phone (390 × 844) sizes, in
 * Look and in Paint mode, and fails if any visible element overlaps the board canvas
 * (#board), other than the board's own ancestors and the overlays inside
 * #board-viewport (selection ring, pointer preview, pending marks), or if the board
 * sticks out sideways past the window or a clipping ancestor (the page scroller).
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

const modes = ["look", "paint"];

const browser = await chromium.launch();
let failures = 0;
try {
  for (const size of sizes) for (const mode of modes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: size.mobile,
      hasTouch: size.mobile,
    });
    const page = await context.newPage();
    // The board polls, so the network never goes idle: wait for load, then settle.
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(3000);
    if (mode === "paint") {
      const paint = await page.$("#wall-mode-paint");
      if (paint) {
        await paint.click();
        await page.waitForTimeout(500);
      }
    }

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
      // Cut off sideways: past the window, or past an ancestor that clips its overflow.
      const clipped = [];
      if (b.left < -1 || b.right > window.innerWidth + 1) clipped.push(`window (0–${window.innerWidth})`);
      for (let el = board.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (!/(hidden|auto|scroll|clip)/.test(style.overflowX)) continue;
        if (viewport && (el === viewport || viewport.contains(el))) continue; // the camera's own clip
        const r = el.getBoundingClientRect();
        if (b.left < r.left - 1 || b.right > r.right + 1) {
          const name = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
          clipped.push(`${name} (${Math.round(r.left)}–${Math.round(r.right)})`);
        }
      }
      return {
        board: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
        overlaps,
        clipped,
      };
    });

    const label = `${size.name} ${mode}`;
    if (report.error) {
      failures += 1;
      console.log(`${label}: FAIL ${report.error}`);
    } else if (report.overlaps.length > 0 || report.clipped.length > 0) {
      failures += 1;
      console.log(`${label}: FAIL board ${JSON.stringify(report.board)}`);
      for (const line of report.overlaps) console.log(`  overlapped by ${line}`);
      for (const line of report.clipped) console.log(`  cut off by ${line}`);
    } else {
      console.log(`${label}: ok, nothing overlaps or cuts off the board ${JSON.stringify(report.board)}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
