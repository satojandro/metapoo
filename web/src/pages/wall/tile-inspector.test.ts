/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import type { PixelView } from "@shared/types.ts";
import { createTileInspector, formatAgo, inspectorModel, parseTileHash, tileLink } from "./tile-inspector";
import { createWallScope } from "./wall-scope";
import type { ViewTunables } from "./wall-views";

const MIN = 60_000_000_000n;
const NOW = 1_000_000n * MIN;
const tunables: ViewTunables = {
  repaint_young_ns: Number(10n * MIN),
  repaint_mid_ns: Number(60n * MIN),
  repaint_young_credits: 4,
  repaint_mid_credits: 2,
  repaint_base_credits: 1,
};
const painted = (minutesAgo: number, artist = "alice.testnet"): PixelView => ({
  x: 3,
  y: 4,
  colorIndex: 11,
  artistAccountId: artist,
  lastWriteTimestampNs: (NOW - BigInt(minutesAgo) * MIN).toString(),
});
const base = {
  cell: { x: 3, y: 4 },
  viewer: "me.testnet",
  now: NOW,
  tunables,
  free: { kind: "unknown" as const },
  knownCost: undefined,
  network: "testnet",
  pageUrl: "https://meta.poo/wall?x=1#old",
};

describe("tile hash", () => {
  it("parses #tile-x-y on the wall", () => {
    expect(parseTileHash("#tile-12-80")).toEqual({ x: 12, y: 80 });
    expect(parseTileHash("#tile-0-0")).toEqual({ x: 0, y: 0 });
    expect(parseTileHash("#tile-127-127")).toEqual({ x: 127, y: 127 });
  });

  it("ignores anything else", () => {
    for (const bad of ["", "#", "#tile-128-0", "#tile-1-200", "#tile--1-2", "#tile-a-b", "#tile-1-2-3", "#cell-1-2", "tile-1-2", null, undefined]) {
      expect(parseTileHash(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it("builds a link that replaces any existing hash", () => {
    expect(tileLink("https://meta.poo/wall?x=1#old", { x: 5, y: 6 })).toBe("https://meta.poo/wall?x=1#tile-5-6");
  });
});

describe("inspector content", () => {
  it("a wet tile: painter, minutes ago, wet, 4 credits", () => {
    const model = inspectorModel({ ...base, pixel: painted(3) });
    expect(model.colour?.name).toBe("Bubblegum");
    expect(model.painter).toEqual({ account: "alice.testnet", you: false, href: "https://testnet.nearblocks.io/address/alice.testnet" });
    expect(model.ago).toBe("3 min ago");
    expect(model.wetness).toBe("wet");
    expect(model.cost).toBe("4 credits");
    expect(model.link).toBe("https://meta.poo/wall?x=1#tile-3-4");
  });

  it("your own dry tile", () => {
    const model = inspectorModel({ ...base, pixel: painted(180, "me.testnet") });
    expect(model.painter?.you).toBe(true);
    expect(model.ago).toBe("3 h ago");
    expect(model.wetness).toBe("dry");
    expect(model.cost).toBe("1 credit");
  });

  it("a blank tile is free only when free paints are known to remain", () => {
    expect(inspectorModel({ ...base, pixel: null }).cost).toBe("1 credit");
    const free = inspectorModel({ ...base, pixel: null, free: { kind: "yes", remaining: 7 } });
    expect(free.cost).toBe("Free for you · 7 free first paints left");
    expect(free.colour).toBeNull();
    expect(free.painter).toBeNull();
    expect(free.ago).toBeNull();
  });

  it("prefers the chain quote, and says price unavailable rather than guessing", () => {
    expect(inspectorModel({ ...base, pixel: painted(3), knownCost: 8 }).cost).toBe("8 credits");
    expect(inspectorModel({ ...base, pixel: painted(3), knownCost: 0 }).cost).toBe("Free for you");
    expect(inspectorModel({ ...base, pixel: painted(3), tunables: null }).cost).toBe("Price unavailable");
  });

  it("says the wall is loading, not that a tile is blank, before the first read", () => {
    const loading = inspectorModel({ ...base, pixel: null, loaded: false });
    expect(loading.loading).toBe(true);
    expect(loading.colour).toBeNull();
    expect(loading.cost).toBe("");
    // A tile already in the cache (for example, just painted) shows its facts anyway.
    expect(inspectorModel({ ...base, pixel: painted(3), loaded: false }).loading).toBe(false);
    expect(inspectorModel({ ...base, pixel: null, loaded: true }).loading).toBe(false);
  });

  it("formats ages", () => {
    expect(formatAgo(0n)).toBe("just now");
    expect(formatAgo(59n * MIN)).toBe("59 min ago");
    expect(formatAgo(47n * 60n * MIN)).toBe("47 h ago");
    expect(formatAgo(72n * 60n * MIN)).toBe("3 days ago");
  });
});

describe("Tile card", () => {
  function setup(selected: { x: number; y: number } | null, copy = vi.fn(async () => {})) {
    document.body.innerHTML = `<section class="wall-inspect"><p class="summary"></p><div id="host" hidden></div></section>`;
    const scope = createWallScope();
    const paintOver = vi.fn();
    const prime = vi.fn();
    const inspector = createTileInspector({
      scope,
      card: document.querySelector<HTMLElement>(".wall-inspect")!,
      host: document.querySelector<HTMLElement>("#host")!,
      selected: () => selected,
      cachedPixel: () => painted(30),
      viewer: () => null,
      tunables: () => tunables,
      free: () => ({ kind: "unknown" }),
      knownCost: () => undefined,
      network: "testnet",
      prime,
      paintOver,
      pageUrl: () => "https://meta.poo/",
      now: () => Number(NOW / 1_000_000n),
      copy,
    });
    inspector.render();
    return { scope, paintOver, prime, copy };
  }

  it("stays empty with nothing selected", () => {
    setup(null);
    expect(document.querySelector<HTMLElement>("#host")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".wall-inspect")!.dataset.filled).toBe("false");
  });

  it("shows the tile and wires Paint over this and Copy link", async () => {
    const { paintOver, prime, copy } = setup({ x: 3, y: 4 });
    const host = document.querySelector<HTMLElement>("#host")!;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toMatch(/alice\.testnet/);
    expect(host.textContent).toMatch(/30 min ago/);
    expect(host.textContent).toMatch(/drying/);
    expect(host.textContent).toMatch(/2 credits/);
    expect(prime).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLButtonElement>(".tile-paint-over")!.click();
    expect(paintOver).toHaveBeenCalledWith({ x: 3, y: 4 });
    host.querySelector<HTMLButtonElement>(".tile-copy")!.click();
    expect(copy).toHaveBeenCalledWith("https://meta.poo/#tile-3-4");
    await vi.waitFor(() => expect(host.textContent).toMatch(/Link copied/));
  });

  it("falls back to a selected text field when the clipboard refuses", async () => {
    setup({ x: 3, y: 4 }, vi.fn(async () => {
      throw new Error("denied");
    }));
    const host = document.querySelector<HTMLElement>("#host")!;
    host.querySelector<HTMLButtonElement>(".tile-copy")!.click();
    await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(".tile-link-field")?.value).toBe("https://meta.poo/#tile-3-4"));
  });
});
