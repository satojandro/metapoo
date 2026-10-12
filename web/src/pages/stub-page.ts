/**
 * Empty / fixture stub pages for routes Worker G/H will fill.
 * Every stub is labelled so it cannot be mistaken for live product data.
 */

import type { PageDispose, PageMount } from "../app/page-registry";

const DEMO_BANNER =
  "Demo shell — no funds, NFTs, or live bounty/history data on this page yet.";

export function createStubPage(options: {
  title: string;
  body: string;
  /** Extra note under the demo banner. */
  note?: string;
}): PageMount {
  return (root, ctx): PageDispose => {
    const section = document.createElement("section");
    section.className = "page-stub";

    const banner = document.createElement("p");
    banner.className = "demo-banner";
    banner.textContent = DEMO_BANNER;

    const heading = document.createElement("h2");
    heading.dataset.routeHeading = "true";
    heading.textContent = options.title;

    const body = document.createElement("p");
    body.textContent = options.body;

    section.append(banner, heading, body);

    if (options.note) {
      const note = document.createElement("p");
      note.className = "help";
      note.textContent = options.note;
      section.append(note);
    }

    // Surface path params so deep links are visibly handled.
    const params = Object.entries(ctx.route.params);
    if (params.length > 0) {
      const paramLine = document.createElement("p");
      paramLine.className = "help";
      paramLine.textContent = `Route params: ${params
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`;
      section.append(paramLine);
    }

    const back = document.createElement("p");
    const wallLink = document.createElement("a");
    wallLink.href = "/wall";
    wallLink.textContent = "Open wall";
    back.append(wallLink);
    section.append(back);

    root.append(section);
    return () => {
      root.replaceChildren();
    };
  };
}
