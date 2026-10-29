/**
 * A plain text page (today: not-found) with a link back to the wall.
 */

import type { PageDispose, PageMount } from "../app/page-registry";

export function createStubPage(options: {
  title: string;
  body: string;
  /** Extra note under the body. */
  note?: string;
}): PageMount {
  return (root, ctx): PageDispose => {
    const section = document.createElement("section");
    section.className = "page-stub";

    const heading = document.createElement("h2");
    heading.dataset.routeHeading = "true";
    heading.textContent = options.title;

    const body = document.createElement("p");
    body.textContent = options.body;

    section.append(heading, body);

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
