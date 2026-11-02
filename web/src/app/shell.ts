/**
 * App shell: brand, top nav, global wallet chrome, page outlet.
 */

import { mountPaintWalletPanel } from "./paint-wallet-panel";
import type { ParsedRoute } from "./routes";
import { mountWalletChrome, type WalletChromeDispose } from "./wallet-chrome";
import { wireWalletDetailsClose } from "./wallet-details-close";
import type { AppServices } from "./services";

export interface ShellHandles {
  outlet: HTMLElement;
  setActiveNav: (route: ParsedRoute) => void;
  dispose: () => void;
}

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; match: string }> = [
  { href: "/wall", label: "Wall", match: "wall" },
  { href: "/money", label: "Where the money goes", match: "money" },
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
    a.textContent = item.label;
    li.append(a);
    navList.append(li);
  }
  nav.append(navList);

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
  walletPanel.innerHTML = `
    <button id="connect-button" class="mp-btn mp-btn-primary shell-connect" type="button">Connect wallet</button>
    <details class="wallet-details"><summary>Wallet</summary>
    <section id="paint-wallet-panel" aria-label="Paint and wallet balances"></section>
    <h2>Connection details</h2>
    <p id="wallet-summary"></p>
    <p id="network-summary"></p>
    <p class="wallet-money-link"><a href="/money">Where the money goes →</a></p>
    <label class="drawing-session-opt-in" for="authorize-drawing-session">
      <input id="authorize-drawing-session" type="checkbox" disabled />
      Also allow painting without a popup each time
    </label>
    </details>
    <p id="wallet-error" class="result" role="status"></p>
  `;

  const opsPanel = document.createElement("section");
  opsPanel.id = "ops-recovery";
  opsPanel.className = "ops-recovery";
  opsPanel.setAttribute("aria-label", "Operation recovery");

  walletPanel.querySelector("details")?.append(opsPanel, compactStatus);
  chromeRow.append(walletPanel);

  const outlet = document.createElement("div");
  outlet.id = "page-outlet";
  outlet.className = "page-outlet";

  header.append(chromeRow);
  host.append(header, outlet);

  const walletDispose: WalletChromeDispose = mountWalletChrome(
    chromeRow,
    services,
  );

  const walletDetails = walletPanel.querySelector<HTMLDetailsElement>("details.wallet-details")!;
  const detailsClose = wireWalletDetailsClose(walletDetails);
  // The primary nav is hidden on phones; this link is the phone route to /money.
  walletPanel.querySelector(".wallet-money-link a")?.addEventListener("click", () => {
    walletDetails.open = false;
  });

  const paintWalletDispose = mountPaintWalletPanel(
    walletPanel.querySelector<HTMLElement>("#paint-wallet-panel")!, services,
  );

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

  return {
    outlet,
    setActiveNav,
    dispose() {
      paintWalletDispose();
      detailsClose.dispose();
      walletDispose();
      host.replaceChildren();
    },
  };
}
