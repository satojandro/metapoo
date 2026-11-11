/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import type { PixelView } from "@shared/types.ts";
import {
  assignTurfColors,
  blankIsFree,
  createWallViews,
  legendFor,
  parseFreeFirst,
  readViewPalette,
  repaintTier,
  tileAgeNs,
  tilePainterFor,
  topPainters,
  turfColor,
  turfHue,
  wetnessOf,
  type ViewTunables,
} from "./wall-views";
import { createWallScope } from "./wall-scope";

const MIN = 60_000_000_000n;
const NOW = 1_000_000n * MIN;
const tunables: ViewTunables = {
  repaint_young_ns: (10n * MIN).toString(),
  repaint_mid_ns: Number(60n * MIN),
  repaint_young_credits: 4,
  repaint_mid_credits: 2,
  repaint_base_credits: 1,
};
const at = (minutesAgo: number) => (NOW - BigInt(minutesAgo) * MIN).toString();
const px = (x: number, artist: string | null, minutesAgo = 120, colorIndex: number | null = 3): PixelView => ({
  x,
  y: 0,
  colorIndex,
  artistAccountId: artist,
  lastWriteTimestampNs: colorIndex === null ? null : at(minutesAgo),
});
const palette = readViewPalette(null);

describe("repaint tiers (mirror Tunables::cost)", () => {
  it("prices wet, drying, dry and blank tiles from the board's tunables", () => {
    expect(repaintTier(at(0), NOW, tunables)).toEqual({ credits: 4, wetness: "wet" });
    expect(repaintTier(at(9), NOW, tunables)).toEqual({ credits: 4, wetness: "wet" });
    expect(repaintTier(at(10), NOW, tunables)).toEqual({ credits: 2, wetness: "drying" });
    expect(repaintTier(at(59), NOW, tunables)).toEqual({ credits: 2, wetness: "drying" });
    expect(repaintTier(at(60), NOW, tunables)).toEqual({ credits: 1, wetness: "dry" });
    expect(repaintTier(null, NOW, tunables)).toEqual({ credits: 1, wetness: null });
  });

  it("uses the board's numbers, not a built-in table", () => {
    const pricier = { ...tunables, repaint_young_credits: 8, repaint_mid_credits: 3, repaint_base_credits: 2 };
    expect(repaintTier(at(1), NOW, pricier).credits).toBe(8);
    expect(repaintTier(at(30), NOW, pricier).credits).toBe(3);
    expect(repaintTier(null, NOW, pricier).credits).toBe(2);
  });

  it("treats a future stamp as just painted and junk as blank", () => {
    expect(tileAgeNs((NOW + MIN).toString(), NOW)).toBe(0n);
    expect(tileAgeNs("not-a-number", NOW)).toBeNull();
  });
});

describe("age buckets", () => {
  it("falls back to 10 / 60 minutes while the board's windows are unknown", () => {
    expect(wetnessOf(at(5), NOW, null)).toBe("wet");
    expect(wetnessOf(at(30), NOW, null)).toBe("drying");
    expect(wetnessOf(at(90), NOW, null)).toBe("dry");
    expect(wetnessOf(null, NOW, null)).toBeNull();
  });

});

describe("free tint", () => {
  it("is free only when free first paints are known to remain", () => {
    expect(blankIsFree({ kind: "yes", remaining: 3 })).toBe(true);
    expect(blankIsFree({ kind: "no" })).toBe(false);
    expect(blankIsFree({ kind: "unknown" })).toBe(false);
  });

  it("parses the contract view and never turns a bad answer into free", () => {
    expect(parseFreeFirst({ used: 2, remaining: 23, active: true, allowance: 25, registered: true })).toEqual({ kind: "yes", remaining: 23 });
    expect(parseFreeFirst({ used: 25, remaining: 0, active: true })).toEqual({ kind: "no" });
    expect(parseFreeFirst({ remaining: 5, active: false })).toEqual({ kind: "no" });
    expect(parseFreeFirst(null)).toEqual({ kind: "unknown" });
    expect(parseFreeFirst({ remaining: "5" })).toEqual({ kind: "unknown" });
  });

  it("tints blank tiles free in Fresh view only when the viewer has free paints", () => {
    const base = { mode: "fresh" as const, now: NOW, tunables, viewer: "me.testnet", palette };
    const free = tilePainterFor({ ...base, free: { kind: "yes", remaining: 5 } })!;
    const unknown = tilePainterFor({ ...base, free: { kind: "unknown" } })!;
    expect(free.empty(0, 0)).not.toBe(unknown.empty(0, 0));
    expect(unknown.empty(0, 0)).toBe(tilePainterFor({ ...base, free: { kind: "no" } })!.empty(0, 0));
  });

  it("shows price unavailable instead of guessing when tunables can't be read", () => {
    const painter = tilePainterFor({ mode: "fresh", now: NOW, tunables: null, free: { kind: "unknown" }, viewer: null, palette })!;
    expect(painter.empty(0, 0)).toBeNull();
    const legend = legendFor({ mode: "fresh", now: NOW, tunables: null, free: { kind: "unknown" }, viewer: null, palette, pixels: [] });
    // B1: the bands and their windows are still true without tunables; only the
    // credit figures are unknown, and the note says so instead of printing a number.
    expect(legend.title).toBe("Fresh");
    expect(legend.note).toMatch(/Prices are unavailable/);
    expect(legend.items.map((i) => i.label)).toEqual([
      "Wet · under 10 min", "Drying · under an hour", "Dry", "Blank",
    ]);
  });

  it("one Fresh legend carries both the band's price and its window (UI review B1)", () => {
    const legend = legendFor({ mode: "fresh", now: NOW, tunables, free: { kind: "unknown" }, viewer: null, palette, pixels: [] });
    expect(legend.items.map((i) => i.label)).toEqual([
      "Wet · 4 credits · under 10 min",
      "Drying · 2 credits · under an hour",
      "Dry · 1 credit",
      "Blank · 1 credit",
    ]);
    expect(legend.note).toBe("Fresh paint costs more to cover, so new work gets a moment on the wall.");
  });
});

describe("turf", () => {
  it("gives an account the same colour every time, and never the 'you' yellow band", () => {
    expect(turfColor("alice.testnet")).toBe(turfColor("alice.testnet"));
    expect(turfHue("alice.testnet")).not.toBe(turfHue("bob.testnet"));
    for (const name of ["a", "bb", "alice.testnet", "x".repeat(64), "0000000000000000"]) {
      const hue = turfHue(name);
      expect(hue < 40 || hue >= 80).toBe(true);
      expect(hue).toBeLessThan(360);
    }
  });

  it("ranks painters by tiles held, ties alphabetically, and keeps the viewer in view", () => {
    const pixels = [
      px(0, "carol"), px(1, "carol"), px(2, "carol"),
      px(3, "bob"), px(4, "bob"),
      px(5, "alice"), px(6, "alice"),
      px(7, "dan"), px(8, "erin"), px(9, "frank"),
      px(10, null), px(11, "zed", 1, null),
    ];
    const rows = topPainters(pixels, "frank", 3);
    expect(rows.map((r) => [r.account, r.tiles, r.rank])).toEqual([
      ["carol", 3, 1], ["alice", 2, 2], ["bob", 2, 3], ["frank", 1, 6],
    ]);
    expect(rows[3].you).toBe(true);
    expect(topPainters(pixels, null, 3)).toHaveLength(3);
  });

  it("colours your tiles in the 'you' colour", () => {
    const painter = tilePainterFor({ mode: "turf", now: NOW, tunables: null, free: { kind: "unknown" }, viewer: "me", palette })!;
    expect(painter.painted(px(0, "me"))).toBe(palette.you);
    expect(painter.painted(px(0, "other"))).toBe(turfColor("other"));
  });

  it("gives the top painters distinct colours by rank, you excluded, hash colour beyond the set", () => {
    const colors = ["#111111", "#222222", "#333333"];
    const pixels = [
      px(0, "carol"), px(1, "carol"), px(2, "carol"),
      px(3, "bob"), px(4, "bob"),
      px(5, "alice"), px(6, "alice"),
      px(7, "me"), px(8, "me"), px(9, "me"), px(10, "me"),
      px(11, "dan"),
    ];
    const map = assignTurfColors(pixels, "me", colors);
    expect([...map.entries()]).toEqual([
      ["carol", "#111111"], ["alice", "#222222"], ["bob", "#333333"], ["dan", turfColor("dan")],
    ]);
    expect(map.has("me")).toBe(false);
    // Ten distinct colours, none of them the "you" yellow.
    expect(new Set(palette.turf).size).toBe(10);
    expect(palette.turf).not.toContain(palette.you);
    const painter = tilePainterFor({ mode: "turf", now: NOW, tunables: null, free: { kind: "unknown" }, viewer: "me", palette, turf: map })!;
    expect(painter.painted(px(0, "carol"))).toBe("#111111");
    expect(painter.painted(px(0, "me"))).toBe(palette.you);
  });
});

describe("view controller", () => {
  function setup() {
    const scope = createWallScope();
    document.body.innerHTML = `<div>${["art", "fresh", "turf"]
      .map((v) => `<button data-wall-view="${v}" disabled>${v}</button>`)
      .join("")}</div><section id="legend" hidden></section>`;
    const chips = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-wall-view]"));
    const legend = document.querySelector<HTMLElement>("#legend")!;
    const render = vi.fn();
    const readTunables = vi.fn(async () => tunables);
    const readFreeFirst = vi.fn(async () => ({ remaining: 4, active: true }));
    let tick: (() => void) | null = null;
    const views = createWallViews({
      scope,
      chips,
      legend,
      pixels: () => [px(0, "me", 5), px(1, "you2", 200)],
      viewer: () => "me",
      readTunables,
      readFreeFirst,
      render,
      now: () => Number(NOW / 1_000_000n),
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    return { views, chips, legend, render, readTunables, readFreeFirst, tick: () => tick?.() };
  }

  it("enables every chip and starts in Art with no legend", () => {
    const { views, chips, legend } = setup();
    expect(chips.every((c) => !c.disabled)).toBe(true);
    expect(views.mode()).toBe("art");
    expect(views.painter()).toBeNull();
    expect(legend.hidden).toBe(true);
  });

  it("switching to Fresh reads tunables and free paints once, and the legend says free for you", async () => {
    const { views, chips, legend, readTunables, readFreeFirst, render } = setup();
    chips[1].click();
    await vi.waitFor(() => expect(views.free()).toEqual({ kind: "yes", remaining: 4 }));
    await vi.waitFor(() => expect(views.tunables()).not.toBeNull());
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    expect(legend.hidden).toBe(false);
    expect(legend.textContent).toMatch(/free for you/);
    expect(readTunables).toHaveBeenCalledTimes(1);
    expect(readFreeFirst).toHaveBeenCalledWith("me");
    expect(render).toHaveBeenCalled();
    chips[1].click();
    chips[0].click();
    chips[1].click();
    expect(readTunables).toHaveBeenCalledTimes(1);
  });

  it("re-renders on the timer so paint visibly dries", () => {
    const { views, render, tick } = setup();
    views.setMode("fresh");
    render.mockClear();
    tick();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("Turf lists who holds the wall and marks you", () => {
    const { views, legend } = setup();
    views.setMode("turf");
    expect(legend.textContent).toMatch(/me \(you\)/);
    expect(legend.querySelector('[data-you="true"]')).not.toBeNull();
  });
});
