/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PixelView } from "@shared/types.ts";
import type { HappyHourSchedule } from "../../app/how-it-works";
import { wallStats, wallTiles } from "./wall-invite";
import { createWallScope } from "./wall-scope";
import {
  createWallStory,
  earnLine,
  formatToilet,
  happyHourLine,
  holderRows,
  perTileDayFrom,
  recentStrokes,
  ruleCards,
  strokeEarnLine,
} from "./wall-story";
import type { ViewTunables } from "./wall-views";

const MIN = 60_000_000_000n;
const TOILET = 10n ** 18n;
/** 0.001 TOILET a second: 86.4 a day, the mainnet testing round's rate on 7 Nov. */
const EMISSION = {
  per_cell_second: (TOILET / 1000n).toString(),
  accrued_total: "0",
  cap: (1_000_000_000n * TOILET).toString(),
  remaining: (1_000_000_000n * TOILET).toString(),
};
const PER_DAY = (TOILET / 1000n) * 86_400n;

const tunables: ViewTunables & Record<string, unknown> = {
  repaint_young_ns: (10n * MIN).toString(),
  repaint_mid_ns: (60n * MIN).toString(),
  repaint_young_credits: 4,
  repaint_mid_credits: 2,
  repaint_base_credits: 1,
  happy_hour_enabled: false,
  happy_hour_requires_purchase: true,
  happy_hour_weekday: 6,
  happy_hour_start_s: 72_000,
  happy_hour_length_s: 3_600,
  happy_hour_cap_per_account: 100,
};

function px(x: number, artist: string | null, atMin = 0, y = 0): PixelView {
  return {
    x,
    y,
    colorIndex: artist ? 3 : null,
    artistAccountId: artist,
    lastWriteTimestampNs: artist ? (BigInt(atMin) * MIN + 1n).toString() : null,
  };
}

const sunday: HappyHourSchedule = {
  enabled: true, weekday: 6, startS: 72_000, lengthS: 3_600, cap: 100, requiresPurchase: true,
};
// Sunday 8 Nov 2026, 20:15 UTC: fifteen minutes into the hour.
const SUNDAY_2015 = Date.UTC(2026, 10, 8, 20, 15);
// Saturday 7 Nov 2026, 12:00 UTC.
const SATURDAY_NOON = Date.UTC(2026, 10, 7, 12, 0);

describe("formatToilet", () => {
  it("keeps one decimal for small amounts and shortens large ones", () => {
    expect(formatToilet(PER_DAY)).toBe("86.4");
    expect(formatToilet(PER_DAY * 14n)).toBe("1,210");
    expect(formatToilet(PER_DAY * 261n)).toBe("22.6k");
    expect(formatToilet(1_250_000n * TOILET)).toBe("1.3M");
    expect(formatToilet(0n)).toBe("0");
  });
});

describe("the earning line", () => {
  it("states the board's own rate, and that only credit-paid paint earns", () => {
    expect(perTileDayFrom(EMISSION)).toBe(PER_DAY);
    expect(earnLine(PER_DAY)).toBe(
      "Every tile you paint with credits earns 86.4 TOILET a day until someone paints over it. Free tiles earn nothing.",
    );
  });

  it("says nothing when emission is off, malformed or unread", () => {
    expect(perTileDayFrom({ ...EMISSION, per_cell_second: "0" })).toBeNull();
    expect(perTileDayFrom({ per_cell_second: 5 })).toBeNull();
    expect(perTileDayFrom(undefined)).toBeNull();
    expect(earnLine(null)).toBeNull();
  });

  it("a stroke's earnings count its credit-paid tiles only, as an upper bound", () => {
    expect(strokeEarnLine(12, PER_DAY)).toBe("Earns up to 1,037 TOILET a day while they survive");
    expect(strokeEarnLine(1, PER_DAY)).toBe("Earns up to 86.4 TOILET a day while it survives");
    expect(strokeEarnLine(0, PER_DAY)).toBeNull();
    expect(strokeEarnLine(5, null)).toBeNull();
  });
});

describe("happy hour", () => {
  const blank = wallStats([px(0, "a.near")], 0n, null);

  it("before the first fill, says it starts once the wall is full", () => {
    expect(happyHourLine({ ...sunday, enabled: false }, blank, SATURDAY_NOON)).toBe("Happy hour starts once the wall is full.");
  });

  it("names the next one, and says when one is open", () => {
    expect(happyHourLine(sunday, blank, SATURDAY_NOON)).toBe("Next happy hour: Sunday 20:00 UTC.");
    expect(happyHourLine(sunday, blank, SUNDAY_2015)).toBe("Happy hour is on: dry tiles are free for 45 more minutes.");
  });

  it("stays quiet without a schedule, or when switched off on a full wall", () => {
    expect(happyHourLine(null, blank, SATURDAY_NOON)).toBeNull();
    const full = { ...blank, neverPainted: 0 };
    expect(happyHourLine({ ...sunday, enabled: false }, full, SATURDAY_NOON)).toBeNull();
  });
});

describe("who holds the wall", () => {
  const pixels = [px(0, "b.near"), px(1, "b.near"), px(2, "a.near"), px(3, "me.near"), px(4, null)];

  it("ranks holders by tiles, the viewer marked, with no TOILET figure", () => {
    const rows = holderRows(pixels, "me.near");
    expect(rows.map((r) => [r.account, r.tiles, r.you])).toEqual([
      ["b.near", 2, false],
      ["a.near", 1, false],
      ["me.near", 1, true],
    ]);
    expect(rows.some((r) => "perDay" in r)).toBe(false);
  });
});

describe("right now", () => {
  it("groups each painter's paint into strokes, newest first", () => {
    const pixels = [
      // b.near: one stroke of three tiles at minutes 100–102.
      px(10, "b.near", 100), px(11, "b.near", 101), px(12, "b.near", 102),
      // a.near painted in between, and once long before.
      px(20, "a.near", 101), px(21, "a.near", 30),
      // b.near again, much earlier: a separate stroke.
      px(30, "b.near", 10),
      px(40, null),
    ];
    const strokes = recentStrokes(pixels);
    expect(strokes.map((s) => [s.artist, s.tiles])).toEqual([
      ["b.near", 3],
      ["a.near", 1],
      ["a.near", 1],
      ["b.near", 1],
    ]);
    expect(strokes[0]!.atNs).toBe(102n * MIN + 1n);
    // The tile nearest the stroke's middle, so the wall opens on the stroke.
    expect(strokes[0]!.cell).toEqual({ x: 11, y: 0 });
  });

  it("keeps to the limit and ignores blank tiles", () => {
    const pixels = Array.from({ length: 10 }, (_, i) => px(i, `p${i}.near`, i * 10));
    expect(recentStrokes(pixels, 3).map((s) => s.artist)).toEqual(["p9.near", "p8.near", "p7.near"]);
    expect(recentStrokes([px(0, null)])).toEqual([]);
  });
});

describe("rule cards", () => {
  it("quote the board's own repaint prices", () => {
    const [wet, earn, money] = ruleCards(tunables);
    expect(wet.body).toContain("less than 10 minutes old costs 4 credits");
    expect(wet.body).toContain("less than an hour old 2 credits");
    expect(earn.body).toContain("70%");
    expect([wet.href, earn.href, money.href]).toEqual(["/how-it-works", "/toilet", "/money"]);
  });

  it("fall back to words, not guessed numbers, without tunables", () => {
    expect(ruleCards(null)[0].body).not.toMatch(/\d/);
  });
});

describe("the story on the page", () => {
  afterEach(() => vi.useRealTimers());

  function setup(opts: { emission: () => Promise<unknown>; loaded?: boolean; pixels?: PixelView[] }) {
    document.body.innerHTML = `
      <section class="wall-invite">
        <div class="wall-meter" data-wall-meter hidden><i></i></div>
        <p data-wall-meter-label></p>
        <p data-wall-earn hidden></p>
        <p data-wall-happy hidden></p>
      </section>
      <section class="wall-holders" hidden><ol data-wall-holders></ol><p data-wall-holders-note></p></section>
      <section class="wall-recent" hidden><ol data-wall-recent></ol></section>
      <div data-wall-rules></div>
      <p id="stroke-earn" hidden></p>`;
    const pixels = opts.pixels ?? [px(0, "b.near"), px(1, "b.near"), px(2, "a.near")];
    const loaded = opts.loaded ?? true;
    const flown: Array<{ x: number; y: number }> = [];
    const story = createWallStory({
      scope: createWallScope(),
      invite: document.querySelector<HTMLElement>(".wall-invite")!,
      holders: document.querySelector<HTMLElement>(".wall-holders")!,
      recent: document.querySelector<HTMLElement>(".wall-recent")!,
      strokeEarn: document.querySelector<HTMLElement>("#stroke-earn")!,
      flyTo: (cell) => flown.push(cell),
      rules: document.querySelector<HTMLElement>("[data-wall-rules]")!,
      pixels: () => pixels,
      stats: () => (loaded ? wallStats(pixels, 0n, tunables) : null),
      viewer: () => null,
      tunables: () => tunables,
      colorOf: () => "#73d7ee",
      readEmission: opts.emission,
      now: () => SATURDAY_NOON,
    });
    return { story, flown, q: <T extends HTMLElement>(s: string) => document.querySelector<T>(s)! };
  }

  it("fills the meter, the earning line, the holders and the rules from live reads", async () => {
    const { q } = setup({ emission: async () => EMISSION });
    await Promise.resolve();
    await Promise.resolve();
    const meter = q("[data-wall-meter]");
    expect(meter.hidden).toBe(false);
    expect(meter.getAttribute("aria-label")).toBe(`3 of ${wallTiles().toLocaleString("en-US")} tiles painted`);
    expect(q("[data-wall-earn]").hidden).toBe(false);
    expect(q("[data-wall-earn]").textContent).toBe(
      "Every tile you paint with credits earns 86.4 TOILET a day until someone paints over it. Free tiles earn nothing.",
    );
    expect(q("[data-wall-earn] b").textContent).toBe("86.4 TOILET a day");
    expect(q("[data-wall-happy]").textContent).toBe("Happy hour starts once the wall is full.");
    expect(q(".wall-holders").hidden).toBe(false);
    expect(q("[data-wall-holders]").textContent).toBe("1b.near2 tiles2a.near1 tile");
    expect(document.querySelectorAll(".wall-rule a").length).toBe(3);
  });

  it("a failed emission read leaves the earning line out, and the rest stands", async () => {
    const { q } = setup({ emission: async () => { throw new Error("rpc down"); } });
    await Promise.resolve();
    await Promise.resolve();
    expect(q("[data-wall-earn]").hidden).toBe(true);
    expect(q("[data-wall-holders-note]").textContent).toBe("Tiles held now. Paint over a tile and it’s yours.");
  });

  it("lists the latest strokes, and a tap shows one on the wall", () => {
    const { q, flown } = setup({
      emission: async () => EMISSION,
      pixels: [px(3, "b.near", 0, 7), px(4, "b.near", 0, 7)],
    });
    expect(q(".wall-recent").hidden).toBe(false);
    const item = q<HTMLButtonElement>(".wall-recent-item");
    expect(item.textContent).toContain("b.near painted 2 tiles");
    item.click();
    expect(flown).toEqual([{ x: 3, y: 7 }]);
  });

  it("the paint footer's earnings line follows the quote and the rate", async () => {
    const { story, q } = setup({ emission: async () => EMISSION });
    await Promise.resolve();
    await Promise.resolve();
    const line = q("#stroke-earn");
    expect(line.hidden).toBe(true);
    story.onQuote(3);
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("Earns up to 259 TOILET a day while they survive");
    story.onQuote(0);
    expect(line.hidden).toBe(true);
    story.onQuote(null);
    expect(line.hidden).toBe(true);
  });

  it("before the wall is read, shows no meter and no holders", () => {
    const { q } = setup({ emission: () => new Promise(() => undefined), loaded: false });
    expect(q("[data-wall-meter]").hidden).toBe(true);
    expect(q(".wall-holders").hidden).toBe(true);
    expect(q(".wall-recent").hidden).toBe(true);
  });
});
