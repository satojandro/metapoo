/**
 * Beta-round notice: the board and TOILET on this deployment are for testing only.
 *
 * Not dismissible on purpose. Testers spend real NEAR here, and the one thing every
 * one of them must know is that this board will be paused and its TOILET is worthless.
 */

import { BETA_BANNER_ENABLED, BETA_GUIDE_URL, BETA_REPORT_URL } from "../config";

export interface BetaBannerOptions {
  enabled: boolean;
  guideUrl: string;
  reportUrl: string;
}

const DEFAULTS: BetaBannerOptions = {
  enabled: BETA_BANNER_ENABLED,
  guideUrl: BETA_GUIDE_URL,
  reportUrl: BETA_REPORT_URL,
};

/** Only absolute http(s) links reach the page; anything else is dropped. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function link(href: string, label: string, kind: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = `beta-banner-link beta-banner-${kind}`;
  a.textContent = label;
  return a;
}

/** The banner element, or null when the deployment has turned it off. */
export function createBetaBanner(options: Partial<BetaBannerOptions> = {}): HTMLElement | null {
  const { enabled, guideUrl, reportUrl } = { ...DEFAULTS, ...options };
  if (!enabled) return null;

  const banner = document.createElement("aside");
  banner.className = "beta-banner";
  banner.setAttribute("role", "note");
  banner.setAttribute("aria-label", "Beta test notice");

  const tag = document.createElement("strong");
  tag.className = "beta-banner-tag";
  tag.textContent = "Beta test";

  // Long copy for wide screens, short copy for phones; CSS shows one of them.
  // Screen readers get the long one only.
  const long = document.createElement("span");
  long.className = "beta-banner-text beta-banner-long";
  long.innerHTML =
    "This board and <b>TOILET</b> are for testing only. The board will be paused and " +
    "this TOILET will be worthless. NEAR you spend here is real.";
  const short = document.createElement("span");
  short.className = "beta-banner-text beta-banner-short";
  short.setAttribute("aria-hidden", "true");
  short.innerHTML = "Test board: it will be paused and <b>TOILET</b> will be worthless. NEAR spent is real.";

  banner.append(tag, long, short);

  const links: HTMLAnchorElement[] = [];
  const guide = safeUrl(guideUrl);
  if (guide) links.push(link(guide, "Tester guide", "guide"));
  const report = safeUrl(reportUrl);
  if (report) links.push(link(report, "Report an issue", "report"));
  if (links.length > 0) {
    const nav = document.createElement("span");
    nav.className = "beta-banner-links";
    nav.append(...links);
    banner.append(nav);
  }

  return banner;
}
