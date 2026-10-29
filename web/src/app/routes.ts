/**
 * Path → page id matching for History API routing.
 *
 * Query params (board, x, y, zoom) are parsed
 * as strings; callers clamp/validate before trusting coordinates.
 */

import type { PageId } from "./page-registry";

export interface RouteQuery {
  board?: string;
  x?: string;
  y?: string;
  zoom?: string;
  [key: string]: string | undefined;
}

export interface ParsedRoute {
  path: string;
  pageId: PageId;
  /** Captured path params. No current route has any. */
  params: Record<string, string>;
  query: RouteQuery;
}

const KNOWN_QUERY_KEYS = [
  "board",
  "x",
  "y",
  "zoom",
] as const;

/**
 * Normalize a pathname: strip trailing slash (except root), ensure leading /.
 */
export function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }
  const withSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

export function parseQuery(search: string): RouteQuery {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const query: RouteQuery = {};
  for (const key of KNOWN_QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== "") {
      query[key] = value;
    }
  }
  // Preserve other keys for forward-compat without treating them as trusted prices.
  for (const [key, value] of params.entries()) {
    if (!(key in query) && value !== "") {
      query[key] = value;
    }
  }
  return query;
}

/**
 * Match a browser location to a page id + params.
 */
export function matchRoute(pathname: string, search = ""): ParsedRoute {
  const path = normalizePath(pathname);
  const query = parseQuery(search);

  if (path === "/") {
    return { path, pageId: "home", params: {}, query };
  }
  if (path === "/wall") {
    return { path, pageId: "wall", params: {}, query };
  }
  return { path, pageId: "not-found", params: {}, query };
}

/** Build an in-app href (path + optional query). */
export function buildHref(
  path: string,
  query?: Record<string, string | undefined | null>,
): string {
  const normalized = normalizePath(path);
  if (!query) {
    return normalized;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `${normalized}?${qs}` : normalized;
}
