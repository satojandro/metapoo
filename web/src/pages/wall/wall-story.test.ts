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
  ruleCards,
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

function px(x: number, artist: string | null): PixelView {
  return {
    x,
    y: 0,
    colorIndex: artist ? 3 : null,
    artistAccountId: artist,
    lastWriteTimestampNs: artist ? "1" : null,
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
  it("states the board's own rate", () => {
    expect(perTileDayFrom(EMISSION)).toBe(PER_DAY);
    expect(earnLine(PER_DAY)).toBe("Every tile you hold earns 86.4 TOILET a day until someone paints over it.");
  });

  it("says nothing when emission is off, malformed or unread", () => {
    expect(perTileDayFrom({ ...EMISSION, per_cell_second: "0" })).toBeNull();
    expect(perTileDayFrom({ per_cell_second: 5 })).toBeNull();
    expect(perTileDayFrom(undefined)).toBeNull();
    expect(earnLine(null)).toBeNull();
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

  it("ranks holders with their TOILET a day, the viewer marked", () => {
    const rows = holderRows(pixels, "me.near", PER_DAY);
    expect(rows.map((r) => [r.account, r.tiles, r.perDay, r.you])).toEqual([
      ["b.near", 2, "173", false],
      ["a.near", 1, "86.4", false],
      ["me.near", 1, "86.4", true],
    ]);
  });

  it("leaves earnings out while the rate is unknown", () => {
    expect(holderRows(pixels, null, null).every((r) => r.perDay === null)).toBe(true);
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
      <div data-wall-rules></div>`;
    const pixels = opts.pixels ?? [px(0, "b.near"), px(1, "b.near"), px(2, "a.near")];
    const loaded = opts.loaded ?? true;
    const story = createWallStory({
      scope: createWallScope(),
      invite: document.querySelector<HTMLElement>(".wall-invite")!,
      holders: document.querySelector<HTMLElement>(".wall-holders")!,
      rules: document.querySelector<HTMLElement>("[data-wall-rules]")!,
      pixels: () => pixels,
      stats: () => (loaded ? wallStats(pixels, 0n, tunables) : null),
      viewer: () => null,
      tunables: () => tunables,
      colorOf: () => "#73d7ee",
      readEmission: opts.emission,
      now: () => SATURDAY_NOON,
    });
    return { story, q: <T extends HTMLElement>(s: string) => document.querySelector<T>(s)! };
  }

  it("fills the meter, the earning line, the holders and the rules from live reads", async () => {
    const { q } = setup({ emission: async () => EMISSION });
    await Promise.resolve();
    await Promise.resolve();
    const meter = q("[data-wall-meter]");
    expect(meter.hidden).toBe(false);
    expect(meter.getAttribute("aria-label")).toBe(`3 of ${wallTiles().toLocaleString("en-US")} tiles painted`);
    expect(q("[data-wall-earn]").hidden).toBe(false);
    expect(q("[data-wall-earn]").textContent).toBe("Every tile you hold earns 86.4 TOILET a day until someone paints over it.");
    expect(q("[data-wall-earn] b").textContent).toBe("86.4 TOILET a day");
    expect(q("[data-wall-happy]").textContent).toBe("Happy hour starts once the wall is full.");
    expect(q(".wall-holders").hidden).toBe(false);
    expect(q("[data-wall-holders]").textContent).toBe("1b.near2 tiles173/day2a.near1 tile86.4/day");
    expect(document.querySelectorAll(".wall-rule a").length).toBe(3);
  });

  it("a failed emission read leaves the earning line out, and the rest stands", async () => {
    const { q } = setup({ emission: async () => { throw new Error("rpc down"); } });
    await Promise.resolve();
    await Promise.resolve();
    expect(q("[data-wall-earn]").hidden).toBe(true);
    expect(q("[data-wall-holders]").textContent).toBe("1b.near2 tiles2a.near1 tile");
    expect(q("[data-wall-holders-note]").textContent).toBe("Tiles held now. Paint over a tile and it’s yours.");
  });

  it("before the wall is read, shows no meter and no holders", () => {
    const { q } = setup({ emission: () => new Promise(() => undefined), loaded: false });
    expect(q("[data-wall-meter]").hidden).toBe(true);
    expect(q(".wall-holders").hidden).toBe(true);
  });
});
