import { mount, mountBrowse, mountCreate, mountDetail } from "./mount";
import {
  mountBountiesListPage,
  mountBountyCreatePage,
  mountBountyDetailPage,
  registerBountyPageStubs,
  registerBountyPagesWithShell,
} from "./register-stubs";
import { isBountyPath, parseBountyPath } from "./route";
import type { BountyPageServices, DisposeFn } from "./types";

/**
 * Thin registration descriptors for Frontend integrator F.
 * Preferred path: `registerBountyPageStubs()` / `registerBountyPagesWithShell()`
 * which call `registerPageMount` in F's page registry.
 */
export interface BountyRouteDescriptor {
  /** Path pattern for docs / shell matching. */
  path: string;
  /** Human-readable page name. */
  name: string;
  /**
   * Mount this route into a root element.
   * Detail routes expect `services.pathname` (or `window.location`) to include the id.
   */
  mount: (root: HTMLElement, services?: BountyPageServices) => DisposeFn;
}

/** Static table F can iterate when building a custom page-mount registry. */
export const BOUNTY_ROUTE_TABLE: readonly BountyRouteDescriptor[] = [
  {
    path: "/bounties",
    name: "Art Bounties browse",
    mount: mountBrowse,
  },
  {
    path: "/bounties/new",
    name: "Create Art Bounty",
    mount: mountCreate,
  },
  {
    path: "/bounties/:id",
    name: "Art Bounty detail",
    mount: (root, services = {}) => {
      const pathname =
        services.pathname ??
        (typeof window !== "undefined" ? window.location.pathname : "");
      const route = parseBountyPath(pathname);
      if (route.name !== "detail") {
        return mount(root, { ...services, pathname });
      }
      return mountDetail(root, route.id, services);
    },
  },
] as const;

/**
 * Match helper for standalone wiring (tests / alternate shells).
 */
export function matchBountyRoute(
  pathname: string,
): BountyRouteDescriptor | null {
  if (!isBountyPath(pathname)) {
    return null;
  }
  const route = parseBountyPath(pathname);
  if (route.name === "list") {
    return BOUNTY_ROUTE_TABLE[0]!;
  }
  if (route.name === "create") {
    return BOUNTY_ROUTE_TABLE[1]!;
  }
  if (route.name === "detail") {
    return BOUNTY_ROUTE_TABLE[2]!;
  }
  return null;
}

/** Convenience: descriptors + shell registry helpers. */
export function registerBountyPages(): {
  routes: readonly BountyRouteDescriptor[];
  match: typeof matchBountyRoute;
  mount: typeof mount;
  isBountyPath: typeof isBountyPath;
  /** Registers mounts on F's `registerPageMount` registry. */
  registerWithShell: typeof registerBountyPagesWithShell;
  pageMounts: {
    list: typeof mountBountiesListPage;
    create: typeof mountBountyCreatePage;
    detail: typeof mountBountyDetailPage;
  };
} {
  return {
    routes: BOUNTY_ROUTE_TABLE,
    match: matchBountyRoute,
    mount,
    isBountyPath,
    registerWithShell: registerBountyPagesWithShell,
    pageMounts: {
      list: mountBountiesListPage,
      create: mountBountyCreatePage,
      detail: mountBountyDetailPage,
    },
  };
}

export {
  registerBountyPageStubs,
  registerBountyPagesWithShell,
  mountBountiesListPage,
  mountBountyCreatePage,
  mountBountyDetailPage,
};
