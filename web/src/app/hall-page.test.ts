// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOperationsStore } from "./operations";
import type { PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { mountHallPage } from "./hall-page";
import { HALL_MENU_MIN, hallEntryProblem, hallInMenu, hallWallHref, parseHall, type HallEntry } from "./hall";
import { navItems, pageTitle } from "./shell";

const entry = (over: Partial<HallEntry> = {}): HallEntry => ({
  id: "first-fill",
  title: "The first fill",
  date: "2026-11-11",
  block: 224000000,
  painters: ["misfits-validator.near", "2db3956c9f6a4b1e8d7c5a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6afea0b0"],
  x: 40,
  y: 35,
  zoom: 12,
  image: "/hall/first-fill.png",
  ...over,
});

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

function ctx(): PageContext {
  return {
    services: {
      wallet: {
        getSession: () => ({ accountId: null, networkId: null }),
        connect: async () => {},
        disconnect: async () => {},
        subscribe: () => () => {},
        whenReady: Promise.resolve({ accountId: null, networkId: null }),
      },
      operations: createOperationsStore(),
    },
    route: matchRoute("/hall"),
    navigate: () => {},
  };
}

function mount(entries: HallEntry[], timelapseHasData: () => Promise<boolean> = async () => false) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountHallPage(root, ctx(), { entries, timelapseHasData });
  cleanup.push(() => {
    dispose();
    root.remove();
  });
  return { root, dispose };
}

describe("hall.json", () => {
  it("ships only usable entries, so a half-filled snapshot cannot be committed", () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "hall.json"), "utf8")) as unknown[];
    expect(Array.isArray(raw)).toBe(true);
    for (const item of raw) expect(hallEntryProblem(item)).toBeNull();
    // Every entry's still is in web/public.
    for (const item of raw as HallEntry[]) {
      expect(() => readFileSync(resolve(__dirname, "../../public", item.image.slice(1)))).not.toThrow();
    }
  });
});

describe("parseHall", () => {
  it("orders newest first by block and drops duplicates", () => {
    const list = parseHall([entry({ id: "a", block: 1 }), entry({ id: "b", block: 3 }), entry({ id: "a", block: 9 })]);
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("refuses the snapshot tool's TODO fields and malformed values", () => {
    expect(hallEntryProblem(entry({ title: "TODO" }))).toMatch(/title/);
    expect(hallEntryProblem(entry({ painters: ["TODO"] }))).toMatch(/painter/);
    expect(hallEntryProblem(entry({ image: "https://evil.example/x.png" }))).toMatch(/image/);
    expect(hallEntryProblem(entry({ x: 200 }))).toMatch(/x/);
    expect(hallEntryProblem(entry({ date: "11 Nov" }))).toMatch(/date/);
    expect(hallEntryProblem(entry())).toBeNull();
  });

  it("links back to the existing wall deep link", () => {
    expect(hallWallHref(entry())).toBe("/wall?x=40&y=35&zoom=12");
  });
});

describe("the menu", () => {
  it(`links the Hall only once it has ${HALL_MENU_MIN} entries`, () => {
    const two = [entry({ id: "a" }), entry({ id: "b" })];
    const three = [...two, entry({ id: "c" })];
    expect(hallInMenu(two)).toBe(false);
    expect(hallInMenu(three)).toBe(true);
    expect(navItems(false).map((i) => i.href)).not.toContain("/hall");
    expect(navItems(true).map((i) => i.href)).toContain("/hall");
  });

  it("names the tab even while the Hall is out of the menu", () => {
    expect(pageTitle("hall")).toBe("Hall of Fame · Meta Poo");
    expect(matchRoute("/hall").pageId).toBe("hall");
  });
});

describe("mountHallPage", () => {
  it("renders one card per entry with a crisp still, short ids and a wall link", () => {
    const { root } = mount([entry()]);
    const cards = root.querySelectorAll(".hall-card");
    expect(cards).toHaveLength(1);
    const img = root.querySelector<HTMLImageElement>(".hall-card img")!;
    expect(img.getAttribute("src")).toBe("/hall/first-fill.png");
    expect(img.alt).toMatch(/The first fill/);
    const painters = root.querySelector(".hall-painters")!.textContent!;
    expect(painters).toContain("misfits-validator.near");
    // A 64-character id never prints in full (UI review A1/B4).
    expect(painters).toContain("2db3956c…6afea0b0");
    expect(root.querySelector<HTMLAnchorElement>(".hall-link")!.getAttribute("href")).toBe("/wall?x=40&y=35&zoom=12");
    expect(root.querySelector<HTMLElement>("[data-hall-empty]")!.hidden).toBe(true);
  });

  it("says plainly when nothing is hung yet", () => {
    const { root } = mount([]);
    expect(root.querySelector<HTMLElement>("[data-hall-empty]")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-hall-grid]")!.hidden).toBe(true);
  });

  it("teases the timelapse at the foot, as text, while there is no recording to play", async () => {
    const { root } = mount([]);
    await Promise.resolve();
    expect(root.querySelector(".hall-soon")!.textContent).toMatch(/timelapse is coming soon/i);
    expect(root.querySelector(".hall-soon a")).toBeNull();
    // A check that fails is "no", not a broken page.
    const failing = mount([], async () => {
      throw new Error("board server down");
    });
    await new Promise((r) => setTimeout(r));
    expect(failing.root.querySelector(".hall-soon")!.textContent).toMatch(/coming soon/i);
    expect(failing.root.querySelector(".hall-soon a")).toBeNull();
  });

  it("links the foot line to /timelapse once the recording has something in it", async () => {
    const { root } = mount([], async () => true);
    await new Promise((r) => setTimeout(r));
    const link = root.querySelector<HTMLAnchorElement>(".hall-soon a")!;
    expect(link.getAttribute("href")).toBe("/timelapse");
    expect(root.querySelector(".hall-soon")!.textContent).not.toMatch(/coming soon/i);
  });

  it("keeps the timelapse out of the menu either way", () => {
    for (const withHall of [true, false]) expect(navItems(withHall).map((i) => i.href)).not.toContain("/timelapse");
    expect(matchRoute("/timelapse").pageId).toBe("timelapse");
    expect(pageTitle("timelapse")).toBe("Timelapse · Meta Poo");
  });

  it("does not touch the page if the answer arrives after it was left", async () => {
    let answer!: (has: boolean) => void;
    const { root, dispose } = mount([], () => new Promise<boolean>((resolve) => (answer = resolve)));
    dispose();
    answer(true);
    await new Promise((r) => setTimeout(r));
    expect(root.querySelector("a[href='/timelapse']")).toBeNull();
  });

  it("removes itself on dispose", () => {
    const { root, dispose } = mount([entry()]);
    dispose();
    expect(root.querySelector(".hall")).toBeNull();
  });
});
