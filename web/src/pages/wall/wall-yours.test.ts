/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import type { PixelView } from "@shared/types.ts";
import { createWallScope } from "./wall-scope";
import {
  coveredLine,
  coveredSince,
  createWallYours,
  heldKeys,
  localHeldStore,
  type HeldStore,
} from "./wall-yours";

function px(x: number, y: number, artist: string | null): PixelView {
  return { x, y, colorIndex: artist ? 2 : null, artistAccountId: artist, lastWriteTimestampNs: artist ? "1" : null };
}

const ME = "me.near";

describe("covered since you last looked", () => {
  const before = ["0.0", "1.0", "2.0", "3.0", "4.0"];

  it("counts your old tiles that someone else holds now, and names who covered most", () => {
    const now = [px(0, 0, ME), px(1, 0, "sunny.near"), px(2, 0, "sunny.near"), px(3, 0, "egg.near"), px(4, 0, ME)];
    const result = coveredSince(before, now, ME);
    expect(result).toEqual({ count: 3, top: { account: "sunny.near", tiles: 2 }, first: { x: 1, y: 0 } });
    expect(coveredLine(result)).toBe("Since you last looked, 3 of your tiles were painted over, 2 by sunny.near.");
  });

  it("says 'all by' when one painter covered every one", () => {
    const now = [px(0, 0, "sunny.near"), px(1, 0, ME)];
    expect(coveredLine(coveredSince(["0.0", "1.0"], now, ME))).toBe(
      "Since you last looked, 1 of your tiles was painted over, all by sunny.near.",
    );
  });

  it("a tile missing from the cache is not counted as covered", () => {
    expect(coveredSince(before, [px(0, 0, ME)], ME).count).toBe(0);
  });

  it("nothing covered says so; no earlier visit says nothing", () => {
    expect(coveredLine(coveredSince(["0.0"], [px(0, 0, ME)], ME))).toBe(
      "None of your tiles were painted over since you last looked.",
    );
    expect(coveredLine(null)).toBeNull();
  });

  it("held keys are yours only, painted only, and sorted", () => {
    expect(heldKeys([px(3, 1, ME), px(0, 2, ME), px(1, 1, "x.near"), px(5, 5, null)], ME)).toEqual(["0.2", "3.1"]);
  });
});

describe("this browser's memory", () => {
  function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      get length() { return data.size; },
    };
  }

  it("round-trips per board and account, and treats junk as absent tiles", () => {
    const storage = memoryStorage();
    const store = localHeldStore(() => storage);
    expect(store.read("board", ME)).toBeNull();
    store.write("board", ME, ["1.2", "3.4"]);
    expect(store.read("board", ME)).toEqual(["1.2", "3.4"]);
    expect(store.read("other-board", ME)).toBeNull();
    store.write("board", ME, []);
    expect(store.read("board", ME)).toEqual([]);
    storage.setItem("metapoo:held:v1:board:x.near", "1.2;<script>;9999.1");
    expect(store.read("board", "x.near")).toEqual(["1.2"]);
  });

  it("blocked storage reads as nothing and writes without throwing", () => {
    const store = localHeldStore(() => { throw new Error("SecurityError"); });
    expect(store.read("board", ME)).toBeNull();
    expect(() => store.write("board", ME, ["1.2"])).not.toThrow();
  });
});

describe("the Your tiles section", () => {
  function setup(opts: { viewer: string | null; previous: string[] | null; pixels: PixelView[]; loaded?: boolean }) {
    document.body.innerHTML = `
      <section class="wall-yours" hidden>
        <p data-yours-covered hidden><span data-yours-covered-text></span><button data-yours-show-covered hidden></button></p>
        <span data-yours-tiles>…</span>
        <button data-yours-show-mine hidden></button>
        <div data-yours-claim></div>
      </section>`;
    const writes: string[][] = [];
    const store: HeldStore = { read: () => opts.previous, write: (_b, _a, keys) => void writes.push([...keys]) };
    let viewer = opts.viewer;
    let pixels = opts.pixels;
    const flown: Array<{ x: number; y: number }> = [];
    let mounted = 0;
    let shown = 0;
    const yours = createWallYours({
      scope: createWallScope(),
      section: document.querySelector<HTMLElement>(".wall-yours")!,
      board: "board",
      pixels: () => pixels,
      loaded: () => opts.loaded ?? true,
      viewer: () => viewer,
      store,
      mountClaim: () => { mounted += 1; return () => undefined; },
      showMine: () => { shown += 1; },
      flyTo: (cell) => void flown.push(cell),
    });
    const q = (s: string) => document.querySelector<HTMLElement>(s)!;
    return {
      yours, q, writes, flown,
      mounted: () => mounted,
      shown: () => shown,
      setViewer: (v: string | null) => { viewer = v; },
      setPixels: (p: PixelView[]) => { pixels = p; },
    };
  }

  it("signed out: hidden, no claim panel, nothing stored", () => {
    const t = setup({ viewer: null, previous: null, pixels: [px(0, 0, ME)] });
    expect(t.q(".wall-yours").hidden).toBe(true);
    expect(t.mounted()).toBe(0);
    expect(t.writes).toEqual([]);
  });

  it("signed in: your count, the claim panel, what was covered, and Show me flies there", () => {
    const t = setup({ viewer: ME, previous: ["0.0", "1.0"], pixels: [px(0, 0, ME), px(1, 0, "sunny.near"), px(2, 0, ME)] });
    expect(t.q(".wall-yours").hidden).toBe(false);
    expect(t.mounted()).toBe(1);
    expect(t.q("[data-yours-tiles]").textContent).toBe("2");
    expect(t.q("[data-yours-covered]").hidden).toBe(false);
    expect(t.q("[data-yours-covered-text]").textContent).toBe(
      "Since you last looked, 1 of your tiles was painted over, all by sunny.near.",
    );
    t.q("[data-yours-show-covered]").click();
    expect(t.flown).toEqual([{ x: 1, y: 0 }]);
    t.q("[data-yours-show-mine]").click();
    expect(t.shown()).toBe(1);
    expect(t.writes).toEqual([["0.0", "2.0"]]);
  });

  it("compares once per visit: later board updates don't change the message, but are remembered", () => {
    const t = setup({ viewer: ME, previous: ["0.0"], pixels: [px(0, 0, ME)] });
    expect(t.q("[data-yours-covered-text]").textContent).toBe("None of your tiles were painted over since you last looked.");
    t.setPixels([px(0, 0, "sunny.near"), px(5, 5, ME)]);
    t.yours.render();
    expect(t.q("[data-yours-covered-text]").textContent).toBe("None of your tiles were painted over since you last looked.");
    expect(t.writes).toEqual([["0.0"], ["5.5"]]);
  });

  it("a first visit stores what it sees and says nothing about covering", () => {
    const t = setup({ viewer: ME, previous: null, pixels: [px(0, 0, ME)] });
    expect(t.q("[data-yours-covered]").hidden).toBe(true);
    expect(t.writes).toEqual([["0.0"]]);
  });

  it("waits for the wall to be read before comparing or storing", () => {
    const t = setup({ viewer: ME, previous: ["0.0"], pixels: [], loaded: false });
    expect(t.q(".wall-yours").hidden).toBe(false);
    expect(t.q("[data-yours-covered]").hidden).toBe(true);
    expect(t.writes).toEqual([]);
  });
});
