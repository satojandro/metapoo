/**
 * App shell: brand, top nav, global wallet chrome, page outlet.
 */

import { createBetaBanner } from "./beta-banner";
import { mountPaintWalletPanel } from "./paint-wallet-panel";
import type { PageId } from "./page-registry";
import { BETA_GUIDE_URL } from "../config";
import { createSiteFooter } from "./site-footer";
import { mountToiletClaim, toiletConfigured } from "./toilet-claim";
import { hallInMenu } from "./hall";
import type { ParsedRoute } from "./routes";
import { mountWalletChrome, type WalletChromeDispose } from "./wallet-chrome";
import { wireWalletDetailsClose } from "./wallet-details-close";
import type { AppServices } from "./services";

export interface ShellHandles {
  outlet: HTMLElement;
  setActiveNav: (route: ParsedRoute) => void;
  /**
   * Re-append the site footer after the router has replaced the outlet's
   * children. Call once per route change, after `setActiveNav`.
   */
  placeFooter: (route: ParsedRoute) => void;
  dispose: () => void;
}

export interface NavItem { href: string; label: string; match: PageId; short?: string }

/** The Hall of Fame's nav entry. Its label is the page name whether or not it is in the nav. */
const HALL_NAV: NavItem = { href: "/hall", label: "Hall of Fame", match: "hall", short: "Hall" };

/**
 * Primary nav routes. The labels are also the page names used in the tab title.
 * The Hall of Fame joins only once it has three entries (owner, 11 Nov: one real
 * menu item, no SOON placeholders).
 */
export function navItems(withHall: boolean): ReadonlyArray<NavItem> {
  return [
    { href: "/wall", label: "Wall", match: "wall" },
    { href: "/how-it-works", label: "How it works", match: "how" },
    { href: "/agents", label: "Agents", match: "agents" },
    ...(withHall ? [HALL_NAV] : []),
    { href: "/toilet", label: "TOILET", match: "toilet" },
    { href: "/stake", label: "Stake", match: "stake" },
    // Items have to fit one phone row (UI review C10). The short label is the
    // visible one below 600px; the full label stays the page name and the tab title.
    { href: "/money", label: "Where the money goes", match: "money", short: "Money" },
  ];
}

export const NAV_ITEMS: ReadonlyArray<NavItem> = navItems(hallInMenu());

const NAV_LABELS = new Map<PageId, string>(NAV_ITEMS.map((item) => [item.match, item.label]));

/**
 * The name a route's tab shows, keyed by page id. Nav routes take it from
 * NAV_ITEMS so renaming the nav renames the tab; /admin and the not-found page
 * are not in the nav, so they are named here. Home and the wall are the same page.
 */
export const PAGE_NAMES: Readonly<Record<PageId, string>> = {
  home: NAV_LABELS.get("wall")!,
  wall: NAV_LABELS.get("wall")!,
  how: NAV_LABELS.get("how")!,
  agents: NAV_LABELS.get("agents")!,
  hall: HALL_NAV.label,
  toilet: NAV_LABELS.get("toilet")!,
  stake: NAV_LABELS.get("stake")!,
  money: NAV_LABELS.get("money")!,
  admin: "Board settings",
  "not-found": "Nothing painted here",
};

/** Browser-tab title for a route: `<Page> · Meta Poo`. */
export function pageTitle(pageId: PageId): string {
  return `${PAGE_NAMES[pageId]} · Meta Poo`;
}

/**
 * Build shell DOM into `host` and mount persistent wallet chrome.
 */
export function mountShell(host: HTMLElement, services: AppServices): ShellHandles {
  host.replaceChildren();
  host.classList.add("app-shell");

  const header = document.createElement("header");
  header.className = "top app-shell-top";

  const brand = document.createElement("div");
  brand.className = "brand";
  const homeLink = document.createElement("a");
  homeLink.href = "/wall";
  homeLink.className = "brand-link";
  const title = document.createElement("h1");
  title.textContent = "meta poo.";
  homeLink.append(title);
  const lede = document.createElement("p");
  lede.id = "shell-lede";
  lede.className = "lede";
  lede.textContent =
    "THE ONLY PUBLIC STALL ON THE INTERNET";
  brand.append(homeLink, lede);

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  nav.setAttribute("aria-label", "Primary");
  const navList = document.createElement("ul");
  navList.className = "app-nav-list";
  for (const item of NAV_ITEMS) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = item.href;
    a.dataset.navMatch = item.match;
    const long = document.createElement("span");
    long.className = "app-nav-long";
    long.textContent = item.label;
    a.append(long);
    if (item.short) {
      const short = document.createElement("span");
      short.className = "app-nav-short";
      short.textContent = item.short;
      a.append(short);
      a.classList.add("has-short");
      // The two spans are one link; name it with the full label so a screen reader
      // never hears the abbreviation the phone layout needed.
      a.setAttribute("aria-label", item.label);
    }
    li.append(a);
    navList.append(li);
  }
  nav.append(navList);
  nav.classList.toggle("is-crowded", NAV_ITEMS.length > 6);

  const statusStrip = document.createElement("div");
  // The dock shows the same status next to Place paint. Keep this copy for
  // screen readers and other routes, but don't show it twice on screen.
  statusStrip.className = "status-strip shell-status visually-hidden";
  statusStrip.setAttribute("aria-live", "polite");
  const flowState = document.createElement("p");
  flowState.id = "flow-state";
  flowState.className = "flow-state";
  const compactStatus = document.createElement("p");
  compactStatus.id = "compact-status";
  compactStatus.className = "compact-status";
  statusStrip.append(flowState, compactStatus);

  header.append(brand, nav, statusStrip);

  const chromeRow = document.createElement("div");
  chromeRow.className = "shell-chrome";

  const walletPanel = document.createElement("section");
  walletPanel.className = "wallet-chrome";
  walletPanel.setAttribute("aria-label", "Wallet");
  // One header row: short address, copy, Close. The full 64-character id is only ever a
  // title (hover) and the clipboard payload, never a second box on screen.
  walletPanel.innerHTML = `
    <button id="connect-button" class="mp-btn mp-btn-primary shell-connect" type="button">Connect wallet</button>
    <details class="wallet-details"><summary>Wallet</summary>
    <div class="wallet-account-head">
      <span id="wallet-account" class="wallet-account" hidden>
        <code class="wallet-account-id" data-account-id></code>
        <button type="button" class="wallet-account-copy" aria-label="Copy address" title="Copy address"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor"/></svg></button>
      </span>
    </div>
    <p class="wallet-account-note" role="status"></p>
    <section id="paint-wallet-panel" aria-label="Paint and wallet balances"></section>
    <section id="toilet-wallet-panel" aria-label="Your TOILET" hidden></section>
    <section id="wallet-move-funds" aria-label="Move funds out"></section>
    <nav class="wallet-links" aria-label="More about the board">
      <a href="/money">Where the money goes →</a>
      <a href="/toilet">What TOILET is for →</a>
      <a href="/stake">Stake TOILET →</a>${hallInMenu() ? `
      <a href="/hall">Hall of Fame →</a>` : ""}
    </nav>
    <!-- Two lines: what it does, then what it costs and what it cannot do. The old
         label named the mechanism ("allow painting without a popup") without saying
         what was being granted (UI review B3). Both lines sit inside the label, so
         the checkbox's accessible name carries them. -->
    <label class="drawing-session-opt-in" for="authorize-drawing-session">
      <input id="authorize-drawing-session" type="checkbox" disabled />
      <span class="drawing-session-opt-in-body">
        <span class="drawing-session-opt-in-title">Paint without approving every stroke</span>
        <span class="drawing-session-opt-in-note">Adds a painting key that can only paint here. It can’t move your funds. Turn it off any time.</span>
      </span>
    </label>
    <section id="ops-recovery" class="ops-recovery" aria-label="Operation recovery" hidden></section>
    <details class="wallet-technical"><summary>Technical details</summary>
      <p id="wallet-summary"></p>
      <p id="network-summary"></p>
    </details>
    </details>
    <p id="wallet-error" class="result" role="status"></p>
  `;

  const opsPanel = walletPanel.querySelector<HTMLElement>("#ops-recovery")!;
  walletPanel.querySelector("details")?.append(compactStatus);
  chromeRow.append(walletPanel);

  const outlet = document.createElement("div");
  outlet.id = "page-outlet";
  outlet.className = "page-outlet";

  header.append(chromeRow);
  const betaBanner = createBetaBanner();
  host.classList.toggle("has-beta-banner", betaBanner !== null);
  if (betaBanner) host.append(betaBanner);
  host.append(header, outlet);

  const walletDispose: WalletChromeDispose = mountWalletChrome(
    chromeRow,
    services,
  );

  const walletDetails = walletPanel.querySelector<HTMLDetailsElement>("details.wallet-details")!;
  const detailsClose = wireWalletDetailsClose(walletDetails);
  // The primary nav is hidden on phones; these links are the phone routes to each page.
  for (const link of walletPanel.querySelectorAll<HTMLAnchorElement>(".wallet-links a")) {
    link.addEventListener("click", () => {
      walletDetails.open = false;
    });
  }

  const paintWalletDispose = mountPaintWalletPanel(
    walletPanel.querySelector<HTMLElement>("#paint-wallet-panel")!, services,
  );

  const toiletHost = walletPanel.querySelector<HTMLElement>("#toilet-wallet-panel")!;
  const toiletDispose = toiletConfigured() ? mountToiletClaim(toiletHost, services) : () => {};
  toiletHost.hidden = !toiletConfigured();

  function setActiveNav(route: ParsedRoute): void {
    const matchKey = route.pageId === "home" ? "" : route.pageId;
    for (const link of nav.querySelectorAll<HTMLAnchorElement>("a[data-nav-match]")) {
      const active = matchKey !== "" && link.dataset.navMatch === matchKey;
      link.classList.toggle("is-active", active);
      if (active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }

  // The footer sits *inside* the scrolling outlet, after the page content, so it
  // cannot take height from the wall. The router clears the outlet on every
  // navigation, so this re-appends the same element rather than rebuilding it.
  const siteFooter = createSiteFooter({ guideUrl: BETA_GUIDE_URL });

  function placeFooter(route: ParsedRoute): void {
    if (route.pageId === "admin") {
      // The owner console is an operator surface: no shopfront chrome on it.
      siteFooter.remove();
      return;
    }
    if (outlet.lastElementChild !== siteFooter) {
      outlet.append(siteFooter);
    }
  }

  return {
    outlet,
    setActiveNav,
    placeFooter,
    dispose() {
      paintWalletDispose();
      toiletDispose();
      detailsClose.dispose();
      walletDispose();
      host.classList.remove("has-beta-banner");
      host.replaceChildren();
    },
  };
}
