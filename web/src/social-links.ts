/**
 * Where Meta Poo lives elsewhere, in one place.
 *
 * Every URL here was resolved against its primary source before it was written
 * down (see `docs/implementation/2026-11-11-social-links-spec.md` §2). A link on a
 * page that takes real NEAR is a claim about the world: a wrong one is a 404 at
 * best and a fake market at worst, so these are constants with evidence rather
 * than settings an operator can drift.
 *
 * The one exception is the TOILET chart: there is no TOILET pool yet, so its URL
 * is configuration. Empty means "do not render the entry" — never a search page
 * standing in for a market.
 */

/** The brand account. Handle is case-insensitive on X but the profile spells it this way. */
export const X_URL = "https://x.com/MetaPoo67";

/** Public invite link; `curl -sS https://t.me/metapoo67` answers `og:title = Meta Poo ($mPoo)`. */
export const TELEGRAM_URL = "https://t.me/metapoo67";

/**
 * The repository this site is built from — public, and the same owner the
 * `/agents` page already sends contributors to for issues.
 */
export const GITHUB_URL = "https://github.com/satojandro/metapoo";

/** Issues specifically: where "tell us what you built" lands. */
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;

/**
 * The mPOO chart, and the only mPOO market that exists.
 *
 * Verified 2026-11-11: `api.dexscreener.com/token-pairs/v1/near/mpoo.nearlytrade.near`
 * returns exactly one pair with `pairAddress` equal to the path below,
 * `dexId: "rhea-finance"`, quote token DIARHEA. It is a DIARHEA pool, not a NEAR
 * one, and it is thin — label it a chart, never a price.
 */
export const MPOO_CHART_URL =
  "https://dexscreener.com/near/refv2-diarhea.nearlytrade.near:mpoo.nearlytrade.near:10000";

export type SocialLinkId = "x" | "telegram" | "github" | "mpoo-chart" | "toilet-chart";

export interface SocialLink {
  id: SocialLinkId;
  /** Short visible text. Never the whole URL: the row has to stay on one line. */
  label: string;
  href: string;
  /** Screen-reader name: says where it goes and that it leaves the site. */
  ariaLabel: string;
  /** Community first, then markets. The footer renders in this order. */
  group: "community" | "markets";
}

/** The environment slice this module needs. Typed so a test needs no `import.meta.env`. */
export interface SocialLinkEnv {
  readonly VITE_DEXSCREENER_TOILET_URL?: string;
}

/** Only absolute http(s) links reach the page; anything else is dropped. */
export function safeUrl(raw: string | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const COMMUNITY: ReadonlyArray<Omit<SocialLink, "group">> = [
  { id: "x", label: "X", href: X_URL, ariaLabel: "Meta Poo on X, @MetaPoo67 (opens in a new tab)" },
  {
    id: "telegram",
    label: "Telegram",
    href: TELEGRAM_URL,
    ariaLabel: "Meta Poo on Telegram, @metapoo67 (opens in a new tab)",
  },
  {
    id: "github",
    label: "GitHub",
    href: GITHUB_URL,
    ariaLabel: "Meta Poo source code on GitHub (opens in a new tab)",
  },
];

/**
 * The links to show for this build.
 *
 * TOILET's chart entry exists only when a pair URL is configured, because no
 * TOILET pool is indexed today: `token-pairs` returns `[]` and RHEA DCL has no
 * pool for it at any fee. Rendering a search page in its place would look like a
 * market that does not exist.
 */
export function socialLinks(env: SocialLinkEnv = {}): SocialLink[] {
  const links: SocialLink[] = COMMUNITY.map((link) => ({ ...link, group: "community" }));

  links.push({
    id: "mpoo-chart",
    label: "$mPOO chart",
    href: MPOO_CHART_URL,
    ariaLabel: "mPOO chart on Dexscreener (opens in a new tab)",
    group: "markets",
  });

  const toilet = safeUrl(env.VITE_DEXSCREENER_TOILET_URL);
  if (toilet !== null) {
    links.push({
      id: "toilet-chart",
      label: "$TOILET chart",
      href: toilet,
      ariaLabel: "TOILET chart on Dexscreener (opens in a new tab)",
      group: "markets",
    });
  }

  return links;
}
