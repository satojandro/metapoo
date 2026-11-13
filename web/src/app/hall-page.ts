/**
 * /hall — Hall of Fame (return/growth spec §4.1).
 *
 * A grid of stills of the wall, newest first, each with its title, date, painters and
 * a link back to the spot on the live wall. The data is `hall.json`, curated by hand.
 *
 * With no entries the page says so plainly; it is not linked from the menu until it
 * has three (owner, 11 Nov). The timelapse is teased at the foot, not given a page.
 */

import type { PageContext, PageDispose } from "./page-registry";
import { HALL_ENTRIES, hallDate, hallWallHref, type HallEntry } from "./hall";
import { shortAccount } from "../shared/short-account";
import "./hall.css";

export interface HallPageDeps {
  entries: readonly HallEntry[];
}

const TEMPLATE = `
<article class="hall" aria-labelledby="hall-title">
  <header class="hall-hero">
    <p class="mp-eyebrow">Hall of Fame</p>
    <h2 id="hall-title" data-route-heading="true">The wall, remembered.</h2>
    <p class="hall-lede">The wall never stops changing. These are the moments worth keeping — each one a still taken from the chain, with the people who painted it.</p>
  </header>
  <ol class="hall-grid" data-hall-grid></ol>
  <section class="hall-empty" data-hall-empty hidden>
    <p><strong>Nothing hung yet.</strong> The first stills go up once the wall has something worth remembering.</p>
    <a class="mp-btn mp-btn-primary" href="/wall">Go paint something</a>
  </section>
  <p class="hall-soon">Watch the wall fill, tile by tile — a timelapse is coming soon.</p>
</article>`;

/**
 * One still as a card. Shared with the agent gallery on /agents, which sits one
 * heading level lower and appends the prompt to the caption.
 */
export function hallCard(entry: HallEntry, heading: "h3" | "h4" = "h3"): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "hall-card";
  li.dataset.hallId = entry.id;

  const figure = document.createElement("figure");
  const img = document.createElement("img");
  img.src = entry.image;
  img.alt = `${entry.title}, a still of the wall`;
  img.loading = "lazy";
  img.decoding = "async";
  figure.append(img);

  const caption = document.createElement("figcaption");
  const title = document.createElement(heading);
  title.textContent = entry.title;
  const meta = document.createElement("p");
  meta.className = "hall-meta";
  const time = document.createElement("time");
  time.dateTime = entry.date;
  time.textContent = hallDate(entry.date);
  meta.append(time, document.createTextNode(` · block ${entry.block.toLocaleString("en-US")}`));
  const painters = document.createElement("p");
  painters.className = "hall-painters";
  painters.textContent = `By ${entry.painters.map(shortAccount).join(", ")}`;
  const link = document.createElement("a");
  link.className = "hall-link";
  link.href = hallWallHref(entry);
  link.textContent = "See it on the wall →";
  link.setAttribute("aria-label", `See ${entry.title} on the wall`);
  caption.append(title, meta, painters, link);

  figure.append(caption);
  li.append(figure);
  return li;
}

export function mountHallPage(root: HTMLElement, _ctx: PageContext, overrides: Partial<HallPageDeps> = {}): PageDispose {
  const deps: HallPageDeps = { entries: HALL_ENTRIES, ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".hall")!;
  const grid = page.querySelector<HTMLOListElement>("[data-hall-grid]")!;
  const empty = page.querySelector<HTMLElement>("[data-hall-empty]")!;

  grid.append(...deps.entries.map((e) => hallCard(e)));
  grid.hidden = deps.entries.length === 0;
  empty.hidden = deps.entries.length > 0;

  return () => {
    page.remove();
  };
}
