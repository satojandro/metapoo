/**
 * Site footer: where Meta Poo lives elsewhere.
 *
 * Mounted inside the page outlet (see `shell.placeFooter`) rather than as a flex
 * sibling of it: `#app` is a 100dvh column and the outlet is its only scrolling
 * child, so a fixed footer bar would steal height from `/wall` on every route and
 * force a new term into `--wall-size`.
 *
 * No heading on purpose: the router focuses the route's first `h1/h2` after mount,
 * and chrome must never take that focus target. Text labels only — no icon fonts,
 * no embeds, no trackers, so the page keeps zero third-party requests.
 */

import "./site-footer.css";
import { socialLinks, type SocialLink, type SocialLinkEnv } from "../social-links";

export interface SiteFooterOptions {
  links?: SocialLink[];
  env?: SocialLinkEnv;
}

function linkElement(link: SocialLink): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "site-foot-link";
  a.href = link.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.socialLink = link.id;
  a.setAttribute("aria-label", link.ariaLabel);

  const label = document.createElement("span");
  label.className = "site-foot-label";
  label.textContent = link.label;

  const mark = document.createElement("span");
  mark.className = "site-foot-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "↗";

  a.append(label, mark);
  return a;
}

/**
 * The footer element. Always returns one: the public routes all carry it, and a
 * build with no community links left is a bug worth seeing on the page.
 */
export function createSiteFooter(options: SiteFooterOptions = {}): HTMLElement {
  const links = options.links ?? socialLinks(options.env ?? {});

  const footer = document.createElement("footer");
  footer.className = "site-foot";

  const brand = document.createElement("p");
  brand.className = "site-foot-brand";
  brand.textContent = "meta poo.";

  const nav = document.createElement("nav");
  nav.className = "site-foot-links";
  nav.setAttribute("aria-label", "Meta Poo on other platforms");
  nav.append(...links.map(linkElement));

  footer.append(brand, nav);
  return footer;
}
