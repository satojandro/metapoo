/**
 * @vitest-environment happy-dom
 *
 * NAMES on the wall: the "Get a name →" link in the Tile card, "Who holds the wall",
 * "Right now" and Your tiles. Only beside the viewer's own hex id; nothing with the flag off.
 */
import { describe, expect, it } from "vitest";
import type { PixelView } from "@shared/types.ts";
import { createTileInspector } from "./tile-inspector";
import { wallStats } from "./wall-invite";
import { createWallScope } from "./wall-scope";
import { createWallStory } from "./wall-story";
import type { ViewTunables } from "./wall-views";
import { createWallYours } from "./wall-yours";

const MIN = 60_000_000_000n;
const ME = `fcd66acf${"0".repeat(48)}3076f59e`;
const THEM = `aa${"1".repeat(60)}bb`;
const tunables: ViewTunables = {
  repaint_young_ns: Number(10n * MIN), repaint_mid_ns: Number(60n * MIN),
  repaint_young_credits: 4, repaint_mid_credits: 2, repaint_base_credits: 1,
};
const px = (x: number, artist: string): PixelView => ({
  x, y: 0, colorIndex: 3, artistAccountId: artist, lastWriteTimestampNs: (BigInt(x + 1) * MIN).toString(),
});
const links = () => Array.from(document.querySelectorAll<HTMLAnchorElement>("a.name-link"));

function inspector(painter: string, viewer: string | null, namesGuide: boolean | undefined) {
  document.body.innerHTML = `<section class="wall-inspect"><p class="summary"></p><div id="host" hidden></div></section>`;
  createTileInspector({
    scope: createWallScope(),
    card: document.querySelector<HTMLElement>(".wall-inspect")!,
    host: document.querySelector<HTMLElement>("#host")!,
    selected: () => ({ x: 1, y: 0 }),
    cachedPixel: () => px(1, painter),
    viewer: () => viewer,
    tunables: () => tunables,
    free: () => ({ kind: "unknown" }),
    knownCost: () => undefined,
    network: "testnet",
    prime: () => {},
    paintOver: () => {},
    pageUrl: () => "https://meta.poo/",
    now: () => 1_000_000,
    namesGuide,
  }).render();
  return document.querySelector<HTMLElement>("#host")!;
}

function story(pixels: PixelView[], viewer: string | null, namesGuide: boolean | undefined) {
  document.body.innerHTML = `
    <section class="wall-invite"><p data-wall-earn hidden></p></section>
    <div data-wall-pulse hidden><div data-wall-meter><i></i></div><span data-wall-meter-label></span><span data-pulse-blank></span><span data-pulse-wet></span><span data-wall-happy hidden></span></div>
    <section class="wall-holders" hidden><ol data-wall-holders></ol><p data-wall-holders-note></p></section>
    <section class="wall-recent" hidden><ol data-wall-recent></ol><p class="wall-legend-note">Latest paint.</p></section>
    <div data-wall-rules></div><p id="stroke-earn" hidden></p>`;
  const q = (s: string) => document.querySelector<HTMLElement>(s)!;
  createWallStory({
    scope: createWallScope(), invite: q(".wall-invite"), pulse: q("[data-wall-pulse]"), holders: q(".wall-holders"),
    recent: q(".wall-recent"), strokeEarn: q("#stroke-earn"), rules: q("[data-wall-rules]"), flyTo: () => {},
    pixels: () => pixels, stats: () => wallStats(pixels, 0n, tunables), viewer: () => viewer, tunables: () => tunables,
    colorOf: () => "#73d7ee", readEmission: async () => null,
    readEarningCells: async () => { throw new Error("MethodNotFound"); }, now: () => 1_000_000, namesGuide,
  }).render();
  return q;
}

function yours(viewer: string | null, namesGuide: boolean | undefined) {
  document.body.innerHTML = `
    <section class="wall-yours" hidden>
      <div data-away hidden><button data-away-dismiss></button><p data-away-text></p><p data-away-note hidden></p>
        <button data-away-show hidden></button><button data-away-paint hidden></button></div>
      <span data-yours-tiles>…</span><p class="wall-yours-note">Only tiles you painted with credits earn TOILET.</p>
      <button data-yours-show-mine hidden></button><div data-yours-claim></div>
    </section>`;
  createWallYours({
    scope: createWallScope(), section: document.querySelector<HTMLElement>(".wall-yours")!, board: "board",
    pixels: () => (viewer ? [px(0, viewer)] : []), loaded: () => true, viewer: () => viewer,
    store: { read: () => null, write: () => {} }, readCovers: null, visits: { read: () => null, write: () => {} },
    now: () => 1_000_000, watchSeen: () => () => {}, mountClaim: () => () => {}, showMine: () => {}, flyTo: () => {},
    paintBack: () => {}, namesGuide,
  }).render();
}

describe("Get a name on the wall", () => {
  it("Tile card: the link shows only for the viewer's own hex id", () => {
    const own = inspector(ME, ME, true);
    expect(links()).toHaveLength(1);
    expect(own.querySelector(".tile-painter a.name-link")?.getAttribute("href")).toBe("/how-it-works#hiw-name");
    // The id beside it is still short, never whole.
    expect(own.textContent).toContain("fcd66acf…3076f59e");
    expect(own.textContent).not.toContain(ME);

    inspector(THEM, ME, true);
    expect(links()).toHaveLength(0);
    inspector(ME, null, true);
    expect(links()).toHaveLength(0);
  });

  it("Tile card: named accounts never see it", () => {
    inspector("alice.near", "alice.near", true);
    expect(links()).toHaveLength(0);
    inspector(ME, "alice.near", true);
    expect(links()).toHaveLength(0);
  });

  it("Who holds the wall: the link sits in the viewer's own hex row and no other", () => {
    const q = story([px(0, ME), px(1, THEM), px(2, THEM), px(3, "alice.near")], ME, true);
    const rows = Array.from(q("[data-wall-holders]").children) as HTMLElement[];
    const withLink = rows.filter((li) => li.querySelector("a.name-link"));
    expect(withLink).toHaveLength(1);
    expect(withLink[0]!.dataset.you).toBe("true");
    expect(withLink[0]!.textContent).toContain("fcd66acf…3076f59e (you)");
    // Every hex id in both lists is short.
    expect(document.body.textContent).not.toContain(ME);
    expect(document.body.textContent).not.toContain(THEM);
    expect(document.body.textContent).toContain("aa111111…111111bb");
  });

  it("Right now: one line under the list while the viewer's own stroke is in it", () => {
    const q = story([px(0, ME), px(1, THEM)], ME, true);
    const note = q("[data-wall-recent]").nextElementSibling as HTMLElement;
    expect(note.className).toBe("name-note");
    expect(note.textContent).toBe("The wall signs your tiles fcd66acf…3076f59e. Get a name →");
    // Not inside a row: each row is a button, and a link cannot sit in a button.
    expect(q("[data-wall-recent]").querySelector("a.name-link")).toBeNull();

    const other = story([px(1, THEM)], ME, true);
    expect(other("[data-wall-recent]").nextElementSibling?.className).toBe("wall-legend-note");
  });

  it("the wall lists: named accounts and signed-out visitors never see it", () => {
    story([px(0, "alice.near"), px(1, ME)], "alice.near", true);
    expect(links()).toHaveLength(0);
    story([px(0, ME), px(1, THEM)], null, true);
    expect(links()).toHaveLength(0);
  });

  it("Your tiles: a hex viewer gets the line, a named one does not", () => {
    yours(ME, true);
    expect(links()).toHaveLength(1);
    expect(document.querySelector(".wall-yours-note")!.nextElementSibling?.className).toBe("name-note");
    yours("alice.near", true);
    expect(links()).toHaveLength(0);
    yours(null, true);
    expect(links()).toHaveLength(0);
  });

  it("flag off renders nothing anywhere on the wall", () => {
    for (const flag of [false, undefined]) {
      inspector(ME, ME, flag);
      expect(links()).toHaveLength(0);
      story([px(0, ME), px(1, THEM)], ME, flag);
      expect(links()).toHaveLength(0);
      expect(document.querySelector(".name-note")).toBeNull();
      yours(ME, flag);
      expect(links()).toHaveLength(0);
      expect(document.querySelector(".name-note")).toBeNull();
    }
  });
});
