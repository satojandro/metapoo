/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import type { PixelView } from "@shared/types.ts";
import { createWallInvite, freeFirstOffer, inviteModel, WALL_TILES, wallStats } from "./wall-invite";
import { createWallScope } from "./wall-scope";
import type { ViewTunables } from "./wall-views";

const MIN = 60_000_000_000n;
const NOW = 1_000_000n * MIN;
const tunables: ViewTunables & { free_first_paints_per_account: number } = {
  repaint_young_ns: (10n * MIN).toString(),
  repaint_mid_ns: (60n * MIN).toString(),
  repaint_young_credits: 4,
  repaint_mid_credits: 2,
  repaint_base_credits: 1,
  free_first_paints_per_account: 25,
};

function px(x: number, minutesAgo: number | null, artist = "a.testnet"): PixelView {
  return {
    x,
    y: 0,
    colorIndex: minutesAgo === null ? null : 3,
    artistAccountId: minutesAgo === null ? null : artist,
    lastWriteTimestampNs: minutesAgo === null ? null : (NOW - BigInt(minutesAgo) * MIN).toString(),
  };
}

describe("wall stats", () => {
  it("counts painted, never painted and wet tiles from loaded data", () => {
    const stats = wallStats([px(0, 3), px(1, 30), px(2, 600), px(3, null)], NOW, tunables);
    expect(stats).toEqual({ painted: 3, neverPainted: WALL_TILES - 3, wetNow: 1, nearlyEmpty: true });
  });

  it("doesn't guess the wet count without the board's window", () => {
    expect(wallStats([px(0, 3)], NOW, null).wetNow).toBeNull();
  });

  it("is nearly empty below 2% of the wall", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => px(i, 600));
    expect(wallStats(many(327), NOW, null).nearlyEmpty).toBe(true);
    expect(wallStats(many(328), NOW, null).nearlyEmpty).toBe(false);
  });
});

describe("free first paints offer", () => {
  it("comes from the board's tunables while the wall still has blank tiles", () => {
    const stats = wallStats([px(0, 3)], NOW, tunables);
    expect(freeFirstOffer(tunables, stats)).toBe(25);
    expect(freeFirstOffer({ ...tunables, free_first_paints_per_account: 0 }, stats)).toBeNull();
    expect(freeFirstOffer(null, stats)).toBeNull();
    expect(freeFirstOffer({ repaint_base_credits: 1 }, stats)).toBeNull();
    expect(freeFirstOffer(tunables, { ...stats, neverPainted: 0 })).toBeNull();
  });
});

describe("invite model", () => {
  const stats = wallStats([px(0, 3)], NOW, tunables);
  const base = { loaded: true, stats, offer: 25, viewerFree: { kind: "unknown" } as const, connected: false };

  it("a nearly empty wall leads with getting on it first and the free paints", () => {
    const model = inviteModel(base);
    expect(model.title).toBe("The wall is almost blank.");
    expect(model.accent).toBe("Get on it first.");
    expect(model.body).toContain("Only 1 of 16,384 tiles");
    expect(model.free).toBe("Your first 25 tiles are free while the wall fills up.");
  });

  it("an untouched wall says nobody has painted yet", () => {
    expect(inviteModel({ ...base, stats: wallStats([], NOW, tunables) }).body).toContain("Nobody has painted here yet");
  });

  it("a busy wall keeps the normal invite with the same real counts", () => {
    const busy = wallStats(Array.from({ length: 2000 }, (_, i) => px(i, 600)), NOW, tunables);
    const model = inviteModel({ ...base, stats: busy });
    expect(model.title).toBe("Leave your mark.");
    expect(model.stats?.painted).toBe(2000);
  });

  it("names no free number when the board doesn't say, and uses the viewer's own when known", () => {
    expect(inviteModel({ ...base, offer: null }).free).toBeNull();
    expect(inviteModel({ ...base, connected: true, viewerFree: { kind: "yes", remaining: 7 } }).free)
      .toBe("You have 7 free first paints left. Blank tiles cost you nothing.");
    expect(inviteModel({ ...base, connected: true, viewerFree: { kind: "no" } }).free).toBeNull();
  });

  it("before the first read, shows no counts and not the nearly-empty pitch", () => {
    const model = inviteModel({ ...base, loaded: false, stats: wallStats([], NOW, null) });
    expect(model.title).toBe("Leave your mark.");
    expect(model.stats).toBeNull();
  });
});

describe("invite card", () => {
  function setup(loaded: boolean, pixels: PixelView[]) {
    document.body.innerHTML = `
      <section class="wall-invite"><p class="mp-eyebrow"></p><h3></h3>
        <dl class="wall-stats"></dl><p class="wall-invite-body"></p><p class="wall-invite-free" hidden></p></section>`;
    const card = document.querySelector<HTMLElement>(".wall-invite")!;
    const invite = createWallInvite({
      scope: createWallScope(),
      card,
      pixels: () => pixels,
      loaded: () => loaded,
      tunables: () => tunables,
      viewerFree: () => ({ kind: "unknown" }),
      connected: () => false,
      now: () => Number(NOW / 1_000_000n),
    });
    invite.render();
    return card;
  }

  it("loading: placeholders, no pitch", () => {
    const card = setup(false, []);
    expect(card.dataset.state).toBe("loading");
    expect(card.querySelector(".wall-stats")!.textContent).toBe("Painted…Never painted…Wet now…");
  });

  it("nearly empty: real counts and the free line", () => {
    const card = setup(true, [px(0, 3), px(1, 600)]);
    expect(card.dataset.state).toBe("nearly-empty");
    expect(card.querySelector("h3")!.textContent).toBe("The wall is almost blank. Get on it first.");
    expect(card.querySelector(".wall-stats")!.textContent).toBe("Painted2Never painted16,382Wet now1");
    const free = card.querySelector<HTMLElement>(".wall-invite-free")!;
    expect(free.hidden).toBe(false);
    expect(free.textContent).toContain("first 25 tiles are free");
  });
});
