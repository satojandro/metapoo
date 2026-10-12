/**
 * App shell: brand, top nav, global wallet chrome, page outlet.
 */

import type { ParsedRoute } from "./routes";
import { mountWalletChrome, type WalletChromeDispose } from "./wallet-chrome";
import type { AppServices } from "./services";

export interface ShellHandles {
  outlet: HTMLElement;
  setActiveNav: (route: ParsedRoute) => void;
  dispose: () => void;
}

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; match: string }> = [
  { href: "/wall", label: "Wall", match: "wall" },
  { href: "/bounties", label: "Art Bounties", match: "bounties" },
  { href: "/history", label: "History", match: "history" },
  { href: "/account", label: "My activity", match: "account" },
];

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
  homeLink.href = "/";
  homeLink.className = "brand-link";
  const title = document.createElement("h1");
  title.textContent = "Meta Poo";
  homeLink.append(title);
  const lede = document.createElement("p");
  lede.id = "shell-lede";
  lede.className = "lede";
  lede.textContent =
    "A communal pixel wall inside a toilet stall. Open the wall to paint; browse bounties and history from the nav.";
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
    a.textContent = item.label;
    li.append(a);
    navList.append(li);
  }
  nav.append(navList);

  const statusStrip = document.createElement("div");
  statusStrip.className = "status-strip shell-status";
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
  walletPanel.innerHTML = `
    <h2>Wallet</h2>
    <p id="wallet-summary"></p>
    <p id="network-summary"></p>
    <label class="drawing-session-opt-in" for="authorize-drawing-session">
      <input id="authorize-drawing-session" type="checkbox" disabled />
      Authorize drawing session on connect
    </label>
    <button id="connect-button" class="action" type="button">Connect NEAR wallet</button>
    <p id="wallet-error" class="result" role="status"></p>
  `;

  const opsPanel = document.createElement("section");
  opsPanel.id = "ops-recovery";
  opsPanel.className = "ops-recovery";
  opsPanel.setAttribute("aria-label", "Operation recovery");

  chromeRow.append(walletPanel, opsPanel);

  const outlet = document.createElement("div");
  outlet.id = "page-outlet";
  outlet.className = "page-outlet";

  host.append(header, chromeRow, outlet);

  const walletDispose: WalletChromeDispose = mountWalletChrome(
    chromeRow,
    services,
  );

  function setActiveNav(route: ParsedRoute): void {
    const matchKey =
      route.pageId === "bounties/new" || route.pageId === "bounties/:id"
        ? "bounties"
        : route.pageId === "prints/:id"
          ? "history"
          : route.pageId === "home"
            ? ""
            : route.pageId;
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

  return {
    outlet,
    setActiveNav,
    dispose() {
      walletDispose();
      host.replaceChildren();
    },
  };
}
