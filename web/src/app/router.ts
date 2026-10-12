/**
 * History API router with lifecycle-safe page mounts.
 * Navigating away always calls the previous page's dispose().
 */

import {
  getPageMount,
  type PageContext,
  type PageDispose,
  type PageId,
} from "./page-registry";
import { matchRoute, normalizePath, type ParsedRoute } from "./routes";
import type { AppServices } from "./services";

export interface Router {
  start(): void;
  stop(): void;
  navigate(path: string, options?: { replace?: boolean }): void;
  getRoute(): ParsedRoute;
}

export interface CreateRouterOptions {
  outlet: HTMLElement;
  services: AppServices;
  /** Called after each successful mount (e.g. update nav active state). */
  onRouteChange?: (route: ParsedRoute) => void;
  /** Fallback when a page id has no registered mount. */
  fallbackMount?: (root: HTMLElement, ctx: PageContext) => PageDispose;
}

export function createRouter(options: CreateRouterOptions): Router {
  const { outlet, services, onRouteChange, fallbackMount } = options;
  let currentDispose: PageDispose | null = null;
  let currentRoute: ParsedRoute = matchRoute("/", "");
  let started = false;

  const navigate = (path: string, navOptions?: { replace?: boolean }): void => {
    const url = new URL(path, window.location.origin);
    const nextPath = normalizePath(url.pathname) + url.search;
    if (navOptions?.replace) {
      window.history.replaceState(null, "", nextPath);
    } else {
      window.history.pushState(null, "", nextPath);
    }
    renderFromLocation();
  };

  function renderFromLocation(): void {
    const route = matchRoute(window.location.pathname, window.location.search);
    currentRoute = route;

    if (currentDispose) {
      try {
        currentDispose();
      } catch (error) {
        console.error("Page dispose failed", error);
      }
      currentDispose = null;
    }

    outlet.replaceChildren();
    const ctx: PageContext = {
      services,
      route,
      navigate,
    };

    const mount =
      getPageMount(route.pageId) ??
      fallbackMount ??
      ((root, pageCtx) => mountMissing(root, pageCtx.route.pageId));

    currentDispose = mount(outlet, ctx);
    onRouteChange?.(route);

    // Move focus to the first route heading for a11y (frontend-journeys §8).
    const heading = outlet.querySelector<HTMLElement>("h1, h2, [data-route-heading]");
    if (heading) {
      if (!heading.hasAttribute("tabindex")) {
        heading.setAttribute("tabindex", "-1");
      }
      heading.focus({ preventScroll: true });
    }
  }

  function onPopState(): void {
    renderFromLocation();
  }

  function onDocumentClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = (event.target as Element | null)?.closest("a[href]");
    if (!(target instanceof HTMLAnchorElement)) {
      return;
    }
    if (target.target && target.target !== "_self") {
      return;
    }
    if (target.origin !== window.location.origin) {
      return;
    }
    const path = target.pathname + target.search + target.hash;
    // Only intercept app routes (not external downloads etc.).
    event.preventDefault();
    navigate(path);
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      window.addEventListener("popstate", onPopState);
      document.addEventListener("click", onDocumentClick);
      // Normalize the initial URL without adding a history entry.
      const initial = normalizePath(window.location.pathname) + window.location.search;
      window.history.replaceState(null, "", initial || "/");
      renderFromLocation();
    },
    stop() {
      if (!started) {
        return;
      }
      started = false;
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick);
      if (currentDispose) {
        try {
          currentDispose();
        } catch (error) {
          console.error("Page dispose failed", error);
        }
        currentDispose = null;
      }
      outlet.replaceChildren();
    },
    navigate,
    getRoute() {
      return currentRoute;
    },
  };
}

function mountMissing(root: HTMLElement, pageId: PageId): PageDispose {
  const section = document.createElement("section");
  section.className = "page-stub";
  const heading = document.createElement("h2");
  heading.dataset.routeHeading = "true";
  heading.textContent = "Page not registered";
  const p = document.createElement("p");
  p.textContent = `No mount is registered for “${pageId}”.`;
  section.append(heading, p);
  root.append(section);
  return () => {
    root.replaceChildren();
  };
}
