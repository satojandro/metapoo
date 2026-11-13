#!/usr/bin/env node
/**
 * Layout check: every route fits the screen, and on the wall the board is never
 * cut off sideways.
 *
 * Loads each route at desktop (1440 × 900) and phone (390 × 844) and fails when:
 *
 *   1. **the page scrolls sideways.** The 2026-11-11 UI review measured a 553 px
 *      content column on `/toilet` at 390 px. `documentElement.scrollWidth` does
 *      NOT catch that: `#page-outlet` is `overflow-x: auto`, so the document stays
 *      as wide as the window while the outlet scrolls inside it. So the check
 *      looks for any element that is horizontally *scrollable* (content reachable
 *      only by scrolling) or whose right edge is past the window.
 *   2. **the board is cut off** by the window or by a clipping ancestor.
 *
 * Two things are reported but do NOT fail, deliberately:
 *
 *   - **Content silently clipped** by an `overflow: hidden` box. The wall's
 *     "Right now" rows cut 64-character ids this way; the review files that as
 *     B4 (batch 3, shorten the ids), not as a layout break.
 *   - **Controls lying over the board.** The design puts the view tabs, zoom and
 *     hint on the art (owner, 6–7 Nov). The review's complaint about them is B7
 *     (they sit on the artwork) — a UX decision, not an overlap bug. Before
 *     2026-11-11 this script failed on exactly that, which is why it had stopped
 *     being runnable.
 *
 * Measured against a **production** build: the ids and figures that overflow come
 * from the live board, so a default dev server shows nothing. Either point the
 * script at the deployed alias, or run the dev server in production mode:
 *
 *   npx vite --mode production --port 5174
 *   node scripts/layout-check.mjs [base-url]        # default http://localhost:5174
 *
 * Uses Playwright and the machine's installed Chrome; it is not an npm dependency.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = await import("playwright"));
}

const base = (process.argv[2] ?? "http://localhost:5174").replace(/\/$/, "");
/** Routes a player can reach, including one that does not exist. */
const routes = ["/", "/toilet", "/how-it-works", "/money", "/wall", "/stake", "/hall", "/nope"];
/** Only these render a board; the board assertions are skipped elsewhere. */
const boardRoutes = new Set(["/", "/wall"]);
const sizes = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  // 360 is the common Android width and the one this check was missing: `/stake`
  // held a 347 px min-content in a 336 px column and nothing here ever loaded it.
  { name: "phone-360", width: 360, height: 800, mobile: true },
  { name: "phone", width: 390, height: 844, mobile: true },
];

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
} catch {
  browser = await chromium.launch();
}

let failures = 0;
try {
  for (const route of routes) {
    for (const size of sizes) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: size.mobile,
        hasTouch: size.mobile,
      });
      const page = await context.newPage();
      const label = `${size.name} ${route}`;
      try {
        // The board polls, so the network never goes idle: wait for load, then settle.
        await page.goto(`${base}${route}`, { waitUntil: "load", timeout: 60000 });
        await page.waitForTimeout(6000);

        const report = await page.evaluate((checkBoard) => {
          const width = window.innerWidth;
          const nameOf = (el) =>
            el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].join(".")}` : ""}`;

          const scrolls = []; // sideways-scrollable: the defect
          const past = []; // pushed past the window: the defect
          const clipped = []; // hidden by design/ellipsis: report only

          for (const el of document.body.querySelectorAll("*")) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
            // Content of a closed <details> has boxes but is not on screen.
            if (el.closest("details:not([open])") && el.tagName !== "SUMMARY") continue;
            const r = el.getBoundingClientRect();
            // Under 2 px is a screen-reader-only or collapsed box, not content.
            if (r.width < 2 || r.height < 2 || el.clientWidth < 2) continue;

            const overflowX = /(auto|scroll)/.test(cs.overflowX);
            const hidesX = /(hidden|clip)/.test(cs.overflowX);
            const wider = el.scrollWidth > el.clientWidth + 1;

            if (overflowX && wider) {
              scrolls.push(`${nameOf(el)} scrolls sideways (content ${el.scrollWidth} px in a ${el.clientWidth} px box)`);
            } else if (hidesX && wider) {
              clipped.push(`${nameOf(el)} clips ${el.scrollWidth - el.clientWidth} px (content ${el.scrollWidth} px in ${el.clientWidth} px)`);
            }
            if (r.right > width + 1) {
              past.push(`${nameOf(el)} reaches ${Math.round(r.right)} px`);
            }
          }

          const base = {
            contentWidth: Math.round(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)),
            scrolls: scrolls.slice(0, 6),
            past: past.slice(0, 6),
            clipped: clipped.slice(0, 4),
          };
          if (!checkBoard) return { ...base, hasBoard: false };

          const board = document.querySelector("#board");
          const viewport = document.querySelector("#board-viewport");
          if (!board) return { ...base, hasBoard: false, error: "#board not found" };
          const b = board.getBoundingClientRect();

          // Informational: what lies over the art. B7 in the UI review.
          const over = new Set();
          for (const el of document.body.querySelectorAll("*")) {
            if (el === board || el.contains(board)) continue;
            if (viewport && viewport.contains(el)) continue;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
            const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
            if (w > 1 && h > 1) over.add(nameOf(el).split(".")[0]);
          }

          // The board must not be cut off, by the window or by a clipping ancestor.
          const cut = [];
          if (b.left < -1 || b.right > window.innerWidth + 1) cut.push(`window (0–${window.innerWidth})`);
          for (let el = board.parentElement; el && el !== document.documentElement; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (!/(hidden|auto|scroll|clip)/.test(cs.overflowX)) continue;
            if (viewport && (el === viewport || viewport.contains(el))) continue; // the camera's own clip
            const r = el.getBoundingClientRect();
            if (b.left < r.left - 1 || b.right > r.right + 1) cut.push(`${nameOf(el)} (${Math.round(r.left)}–${Math.round(r.right)})`);
          }

          return {
            ...base,
            hasBoard: true,
            board: { width: Math.round(b.width), height: Math.round(b.height) },
            over: [...over],
            cut,
          };
        }, boardRoutes.has(route));

        const problems = [...report.scrolls, ...report.past];
        if (report.error) problems.push(report.error);
        if (report.cut && report.cut.length > 0) problems.push(`board cut off by ${report.cut.join(", ")}`);

        if (problems.length > 0) {
          failures += 1;
          console.log(`${label}: FAIL (content width ${report.contentWidth} px)`);
          for (const line of problems) console.log(`  ${line}`);
        } else {
          const board = report.hasBoard ? `, board ${report.board.width}×${report.board.height}` : "";
          console.log(`${label}: ok, content ${report.contentWidth} px in a ${size.width} px window${board}`);
        }
        for (const line of report.clipped ?? []) console.log(`  clipped (B4, not a failure): ${line}`);
        if (report.over && report.over.length > 0) console.log(`  over the board (B7, not a failure): ${report.over.join(", ")}`);
      } catch (error) {
        failures += 1;
        console.log(`${label}: FAIL ${error.message}`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failures === 0 ? "\nall routes fit" : `\n${failures} failing page/size pair(s)`);
process.exit(failures === 0 ? 0 : 1);
