/**
 * Any unknown path — a 404 a player can use (A6).
 *
 * It reuses the /admin signed-out hero: `.admin-head`, `.admin-head-text`,
 * `.admin-visitor` and `.admin-head-actions`, all styled by admin-page.css, with
 * the shared `.mp-btn.mp-btn-primary` button. No second hero.
 *
 * The `.admin` page frame is deliberately left off: its `.admin a` rule repaints
 * every link cyan, which would override the primary button's ink text. The hero
 * classes above are the ones that make the layout; `.admin` only adds the page's
 * max-width and padding, which the outlet already provides. not-found-page.css
 * carries the single rule those classes cannot express (the anchor underline).
 *
 * The page needs no data, so it mounts synchronously and has nothing to dispose
 * but its own element.
 */
import type { PageContext, PageDispose } from "./page-registry";
import "./admin-page.css";
import "./not-found-page.css";

const TEMPLATE = `<article class="admin-head not-found" aria-labelledby="not-found-title">
  <div class="admin-head-text">
    <h2 id="not-found-title" data-route-heading="true">Nothing painted here.</h2>
    <p class="admin-visitor">That page isn't on the wall.</p>
    <div class="admin-head-actions">
      <a class="mp-btn mp-btn-primary" href="/wall">Go to the wall</a>
    </div>
  </div>
</article>`;

export function mountNotFoundPage(root: HTMLElement, _ctx: PageContext): PageDispose {
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".admin-head")!;
  return () => {
    page.remove();
  };
}
