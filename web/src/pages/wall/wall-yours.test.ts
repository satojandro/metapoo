/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import type { PixelView } from "@shared/types.ts";
import type { AccountCovers } from "../../board-server/account-covers";
import { createWallScope } from "./wall-scope";
import {
  AWAY_BROWSER_NOTE,
  AWAY_WINDOW_MS,
  awaySince,
  chooseAwayCard,
  coveredLine,
  coveredSince,
  createWallYours,
  heldKeys,
  localHeldStore,
  localVisitStore,
  observeSeen,
  serverCoveredLine,
  type HeldStore,
  type VisitStore,
} from "./wall-yours";

function px(x: number, y: number, artist: string | null): PixelView {
  return { x, y, colorIndex: artist ? 2 : null, artistAccountId: artist, lastWriteTimestampNs: artist ? "1" : null };
}

const ME = "me.near";
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const IMPLICIT = `fcd66acf${"0".repeat(48)}3076f59e`;

describe("covered since you last looked", () => {
  const before = ["0.0", "1.0", "2.0", "3.0", "4.0"];

  it("counts your old tiles that someone else holds now, and names who covered most", () => {
    const now = [px(0, 0, ME), px(1, 0, "sunny.near"), px(2, 0, "sunny.near"), px(3, 0, "egg.near"), px(4, 0, ME)];
    const result = coveredSince(before, now, ME);
    expect(result).toEqual({ count: 3, top: { account: "sunny.near", tiles: 2 }, first: { x: 1, y: 0 } });
    expect(coveredLine(result)).toBe("Since you last looked, 3 of your tiles were covered, 2 by sunny.near.");
  });

  it("says 'all by' when one painter covered every one", () => {
    const now = [px(0, 0, "sunny.near"), px(1, 0, ME)];
    expect(coveredLine(coveredSince(["0.0", "1.0"], now, ME))).toBe(
      "Since you last looked, 1 of your tiles was covered, all by sunny.near.",
    );
  });

  it("a tile missing from the cache is not counted as covered", () => {
    expect(coveredSince(before, [px(0, 0, ME)], ME).count).toBe(0);
  });

  it("nothing covered and no earlier visit both say nothing", () => {
    expect(coveredLine(coveredSince(["0.0"], [px(0, 0, ME)], ME))).toBeNull();
    expect(coveredLine(null)).toBeNull();
  });

  it("held keys are yours only, painted only, and sorted", () => {
    expect(heldKeys([px(3, 1, ME), px(0, 2, ME), px(1, 1, "x.near"), px(5, 5, null)], ME)).toEqual(["0.2", "3.1"]);
  });
});

describe("the server's line", () => {
  const covers = (count: number, by: AccountCovers["by"]): AccountCovers => ({ count, by, first: count ? { x: 1, y: 1 } : null });

  it("names the top coverer, and says the window when 'since' was capped at 30 days", () => {
    expect(serverCoveredLine(covers(14, [{ account: "misfits-validator.near", tiles: 9 }, { account: "egg.near", tiles: 5 }]), false)).toBe(
      "Since your last visit, 14 of your tiles were covered, 9 by misfits-validator.near.",
    );
    expect(serverCoveredLine(covers(3, [{ account: "b.near", tiles: 3 }]), true)).toBe(
      "In the last 30 days, 3 of your tiles were covered, all by b.near.",
    );
  });

  it("shortens implicit ids, and names nobody when the server named nobody", () => {
    expect(serverCoveredLine(covers(2, [{ account: IMPLICIT, tiles: 2 }]), false)).toBe(
      "Since your last visit, 2 of your tiles were covered, all by fcd66acf…3076f59e.",
    );
    expect(serverCoveredLine(covers(2, []), false)).toBe("Since your last visit, 2 of your tiles were covered.");
  });

  it("nothing covered is no line", () => {
    expect(serverCoveredLine(covers(0, []), false)).toBeNull();
  });
});

describe("since", () => {
  it("is the last seen summary when it is inside 30 days", () => {
    expect(awaySince(NOW - 2 * DAY, NOW)).toEqual({ sinceMs: NOW - 2 * DAY, capped: false });
  });

  it("is 30 days ago for a browser that never saw this account, an older visit, or a time in the future", () => {
    const floor = { sinceMs: NOW - AWAY_WINDOW_MS, capped: true };
    expect(awaySince(null, NOW)).toEqual(floor);
    expect(awaySince(NOW - 45 * DAY, NOW)).toEqual(floor);
    expect(awaySince(NOW + DAY, NOW)).toEqual(floor);
  });
});

describe("which source the card uses", () => {
  const browser = { count: 2, top: { account: "egg.near", tiles: 2 }, first: { x: 7, y: 7 } };
  const answered = (covers: AccountCovers) => ({ status: "answered" as const, capped: false, covers });

  it("the server's answer wins, even when it says nothing was covered", () => {
    expect(chooseAwayCard(answered({ count: 1, by: [{ account: "b.near", tiles: 1 }], first: { x: 1, y: 2 } }), browser)).toEqual({
      source: "server",
      line: "Since your last visit, 1 of your tiles was covered, all by b.near.",
      first: { x: 1, y: 2 },
    });
    expect(chooseAwayCard(answered({ count: 0, by: [], first: null }), browser)).toBeNull();
  });

  it("while the server is being asked, nothing is shown, not even this browser's number", () => {
    expect(chooseAwayCard({ status: "pending", capped: false }, browser)).toBeNull();
  });

  it("no server, or no answer: this browser's memory, if it has anything", () => {
    expect(chooseAwayCard({ status: "unavailable" }, browser)?.source).toBe("browser");
    expect(chooseAwayCard({ status: "unavailable" }, null)).toBeNull();
    expect(chooseAwayCard({ status: "unavailable" }, { count: 0, top: null, first: null })).toBeNull();
  });
});

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

describe("this browser's memory", () => {
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

  it("the last seen summary round-trips per board and account; junk and blocked storage read as never", () => {
    const storage = memoryStorage();
    const visits = localVisitStore(() => storage);
    expect(visits.read("board", ME)).toBeNull();
    visits.write("board", ME, NOW + 0.9);
    expect(visits.read("board", ME)).toBe(NOW);
    expect(visits.read("other-board", ME)).toBeNull();
    storage.setItem("metapoo:away-seen:v1:board:x.near", "soon");
    expect(visits.read("board", "x.near")).toBeNull();
    const blocked = localVisitStore(() => { throw new Error("SecurityError"); });
    expect(blocked.read("board", ME)).toBeNull();
    expect(() => blocked.write("board", ME, NOW)).not.toThrow();
  });
});

describe("the Your tiles section", () => {
  interface SetupOptions {
    viewer: string | null;
    previous: string[] | null;
    pixels: PixelView[];
    loaded?: boolean;
    /** No server (VITE_BOARD_SERVER_URL unset) when omitted. */
    server?: (account: string, sinceMs: number) => Promise<AccountCovers | null>;
    lastSeen?: number | null;
  }

  function setup(opts: SetupOptions) {
    document.body.innerHTML = `
      <section class="wall-yours" hidden>
        <div data-away hidden>
          <button data-away-dismiss></button>
          <p data-away-text></p>
          <p data-away-note hidden></p>
          <button data-away-show hidden></button>
          <button data-away-paint hidden></button>
        </div>
        <span data-yours-tiles>…</span>
        <button data-yours-show-mine hidden></button>
        <div data-yours-claim></div>
      </section>`;
    const writes: string[][] = [];
    const store: HeldStore = { read: () => opts.previous, write: (_b, _a, keys) => void writes.push([...keys]) };
    let lastSeen = opts.lastSeen ?? null;
    const seenWrites: number[] = [];
    const visits: VisitStore = {
      read: () => lastSeen,
      write: (_b, _a, at) => { seenWrites.push(at); lastSeen = at; },
    };
    const asked: Array<{ account: string; sinceMs: number }> = [];
    let viewer = opts.viewer;
    let pixels = opts.pixels;
    const flown: Array<{ x: number; y: number }> = [];
    const painted: Array<{ x: number; y: number }> = [];
    let seen: (() => void) | null = null;
    let mounted = 0;
    let shown = 0;
    const scope = createWallScope();
    const yours = createWallYours({
      scope,
      section: document.querySelector<HTMLElement>(".wall-yours")!,
      board: "board",
      pixels: () => pixels,
      loaded: () => opts.loaded ?? true,
      viewer: () => viewer,
      store,
      readCovers: opts.server
        ? (account, sinceMs) => { asked.push({ account, sinceMs }); return opts.server!(account, sinceMs); }
        : null,
      visits,
      now: () => NOW,
      watchSeen: (_el, onSeen) => { seen = onSeen; return () => { seen = null; }; },
      mountClaim: () => { mounted += 1; return () => undefined; },
      showMine: () => { shown += 1; },
      flyTo: (cell) => void flown.push(cell),
      paintBack: (cell) => void painted.push(cell),
    });
    const q = (s: string) => document.querySelector<HTMLElement>(s)!;
    /** Every number on the card, as printed. */
    const numbers = () => (q("[data-away]").hidden ? [] : (q("[data-away-text]").textContent ?? "").match(/\d[\d,]*/g) ?? []);
    return {
      yours, q, writes, flown, painted, asked, seenWrites, scope, numbers,
      mounted: () => mounted,
      shown: () => shown,
      /** The card was on screen long enough to count as read. */
      readCard: () => seen?.(),
      watching: () => seen !== null,
      setViewer: (v: string | null) => { viewer = v; },
      setPixels: (p: PixelView[]) => { pixels = p; },
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("signed out: hidden, no claim panel, nothing stored, no server request", () => {
    const t = setup({ viewer: null, previous: null, pixels: [px(0, 0, ME)], server: async () => null });
    expect(t.q(".wall-yours").hidden).toBe(true);
    expect(t.mounted()).toBe(0);
    expect(t.writes).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  describe("with no board server (fallback)", () => {
    it("your count, the claim panel, and this browser's comparison with its caveat; Show me flies there", () => {
      const t = setup({ viewer: ME, previous: ["0.0", "1.0"], pixels: [px(0, 0, ME), px(1, 0, "sunny.near"), px(2, 0, ME)] });
      expect(t.q(".wall-yours").hidden).toBe(false);
      expect(t.mounted()).toBe(1);
      expect(t.q("[data-yours-tiles]").textContent).toBe("2");
      expect(t.q("[data-away]").hidden).toBe(false);
      expect(t.q("[data-away]").dataset.source).toBe("browser");
      expect(t.q("[data-away-text]").textContent).toBe("Since you last looked, 1 of your tiles was covered, all by sunny.near.");
      expect(t.q("[data-away-note]").hidden).toBe(false);
      expect(t.q("[data-away-note]").textContent).toBe(AWAY_BROWSER_NOTE);
      t.q("[data-away-show]").click();
      expect(t.flown).toEqual([{ x: 1, y: 0 }]);
      t.q("[data-away-paint]").click();
      expect(t.painted).toEqual([{ x: 1, y: 0 }]);
      t.q("[data-yours-show-mine]").click();
      expect(t.shown()).toBe(1);
      expect(t.writes).toEqual([["0.0", "2.0"]]);
    });

    it("compares once per visit: later board updates don't change the card, but are remembered", () => {
      const t = setup({ viewer: ME, previous: ["0.0", "1.0"], pixels: [px(0, 0, ME), px(1, 0, "egg.near")] });
      const line = t.q("[data-away-text]").textContent;
      t.setPixels([px(0, 0, "sunny.near"), px(5, 5, ME)]);
      t.yours.render();
      expect(t.q("[data-away-text]").textContent).toBe(line);
      expect(t.writes).toEqual([["0.0"], ["5.5"]]);
    });

    it("nothing covered: no card", () => {
      const t = setup({ viewer: ME, previous: ["0.0"], pixels: [px(0, 0, ME)] });
      expect(t.q(".wall-yours").hidden).toBe(false);
      expect(t.q("[data-away]").hidden).toBe(true);
    });

    it("a first visit stores what it sees and shows no card: there is no number it could back", () => {
      const t = setup({ viewer: ME, previous: null, pixels: [px(0, 0, ME), px(1, 0, "sunny.near")] });
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.numbers()).toEqual([]);
      expect(t.writes).toEqual([["0.0"]]);
    });

    it("waits for the wall to be read before comparing or storing", () => {
      const t = setup({ viewer: ME, previous: ["0.0"], pixels: [], loaded: false });
      expect(t.q(".wall-yours").hidden).toBe(false);
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.writes).toEqual([]);
    });
  });

  describe("with the board server", () => {
    const fourteen: AccountCovers = {
      count: 14,
      by: [{ account: "misfits-validator.near", tiles: 9 }, { account: "egg.near", tiles: 5 }],
      first: { x: 12, y: 40 },
    };

    it("asks from 30 days ago in a browser that never saw the account, and shows the server's numbers", async () => {
      // Spec's done-when: a fresh browser gets the card with the server's count and name.
      const t = setup({ viewer: ME, previous: null, pixels: [px(0, 0, ME)], server: async () => fourteen });
      expect(t.asked).toEqual([{ account: ME, sinceMs: NOW - AWAY_WINDOW_MS }]);
      await flush();
      expect(t.q("[data-away]").hidden).toBe(false);
      expect(t.q("[data-away]").dataset.source).toBe("server");
      expect(t.q("[data-away-text]").textContent).toBe("In the last 30 days, 14 of your tiles were covered, 9 by misfits-validator.near.");
      expect(t.q("[data-away-note]").hidden).toBe(true);
      t.q("[data-away-show]").click();
      expect(t.flown).toEqual([{ x: 12, y: 40 }]);
      t.q("[data-away-paint]").click();
      expect(t.painted).toEqual([{ x: 12, y: 40 }]);
    });

    it("asks from the last seen summary when there is one", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [], server: async () => fourteen, lastSeen: NOW - 3 * DAY });
      expect(t.asked).toEqual([{ account: ME, sinceMs: NOW - 3 * DAY }]);
      await flush();
      expect(t.q("[data-away-text]").textContent).toMatch(/^Since your last visit, 14 /);
    });

    it("the server's numbers replace this browser's, and are shown before the wall has loaded", async () => {
      const t = setup({
        viewer: ME, previous: ["0.0"], pixels: [px(0, 0, "sunny.near")], loaded: false,
        server: async () => fourteen,
      });
      await flush();
      expect(t.numbers()).toEqual(["30", "14", "9"]);
    });

    it("shows nothing while the server is being asked, then this browser's memory if it fails", async () => {
      let answer!: (covers: AccountCovers | null) => void;
      const t = setup({
        viewer: ME, previous: ["0.0"], pixels: [px(0, 0, "sunny.near")],
        server: () => new Promise((resolve) => { answer = resolve; }),
      });
      expect(t.q("[data-away]").hidden).toBe(true);
      answer(null);
      await flush();
      expect(t.q("[data-away]").dataset.source).toBe("browser");
      expect(t.numbers()).toEqual(["1"]);
    });

    it("a rejected request falls back too", async () => {
      const t = setup({ viewer: ME, previous: ["0.0"], pixels: [px(0, 0, "egg.near")], server: async () => { throw new Error("down"); } });
      await flush();
      expect(t.q("[data-away]").dataset.source).toBe("browser");
    });

    it("server says nothing was covered: no card, even when this browser's memory disagrees, and 'since' moves on", async () => {
      const t = setup({
        viewer: ME, previous: ["0.0"], pixels: [px(0, 0, "sunny.near")],
        server: async () => ({ count: 0, by: [], first: null }),
      });
      await flush();
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.seenWrites).toEqual([NOW]);
    });

    it("no number the page cannot back: server failed and this browser has no earlier visit", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [px(0, 0, "sunny.near")], server: async () => null });
      await flush();
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.numbers()).toEqual([]);
      // Nothing was shown, so nothing was read: "since" stays where it was.
      expect(t.seenWrites).toEqual([]);
    });

    it("'since' moves on only once the card has been read, so a reload before that shows it again", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [], server: async () => fourteen });
      await flush();
      expect(t.watching()).toBe(true);
      expect(t.seenWrites).toEqual([]);
      t.readCard();
      expect(t.seenWrites).toEqual([NOW]);
      expect(t.q("[data-away]").hidden).toBe(false);
    });

    it("using the card counts as reading it", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [], server: async () => fourteen });
      await flush();
      t.q("[data-away-show]").click();
      expect(t.seenWrites).toEqual([NOW]);
      expect(t.watching()).toBe(false);
    });

    it("dismiss hides the card for this visit and counts as read", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [], server: async () => fourteen });
      await flush();
      t.q("[data-away-dismiss]").click();
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.seenWrites).toEqual([NOW]);
      t.yours.render();
      expect(t.q("[data-away]").hidden).toBe(true);
    });

    it("an answer that arrives after the account signed out is dropped", async () => {
      let answer!: (covers: AccountCovers | null) => void;
      const t = setup({ viewer: ME, previous: null, pixels: [], server: () => new Promise((resolve) => { answer = resolve; }) });
      t.setViewer(null);
      t.yours.render();
      answer(fourteen);
      await flush();
      expect(t.q("[data-away]").hidden).toBe(true);
      expect(t.seenWrites).toEqual([]);
    });

    it("asks once per account per visit, and again for a different account", async () => {
      const t = setup({ viewer: ME, previous: null, pixels: [], server: async () => fourteen });
      t.yours.render();
      t.yours.render();
      expect(t.asked.map((a) => a.account)).toEqual([ME]);
      t.setViewer("other.near");
      t.yours.render();
      expect(t.asked.map((a) => a.account)).toEqual([ME, "other.near"]);
    });
  });
});

describe("when the card counts as read", () => {
  type Entry = { isIntersecting: boolean; intersectionRatio: number };

  it("half on screen for the dwell time; scrolling away first resets it", async () => {
    vi.useFakeTimers();
    let fire: ((entries: Entry[]) => void) | null = null;
    let disconnected = 0;
    class FakeObserver {
      constructor(cb: (entries: Entry[]) => void) { fire = cb; }
      observe() {}
      disconnect() { disconnected += 1; }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      let seen = 0;
      const stop = observeSeen(document.createElement("div"), () => { seen += 1; }, 1_000);
      fire!([{ isIntersecting: true, intersectionRatio: 0.6 }]);
      await vi.advanceTimersByTimeAsync(900);
      fire!([{ isIntersecting: false, intersectionRatio: 0 }]);
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toBe(0);
      fire!([{ isIntersecting: true, intersectionRatio: 1 }]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toBe(1);
      expect(disconnected).toBe(1);
      stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("without IntersectionObserver nothing counts as read on its own", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    try {
      let seen = 0;
      observeSeen(document.createElement("div"), () => { seen += 1; })();
      expect(seen).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
