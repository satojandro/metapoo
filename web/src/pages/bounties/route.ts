import type { BountyStatus } from "./types";

export type BountyRoute =
  | { name: "list" }
  | { name: "create" }
  | { name: "detail"; id: string }
  | { name: "unknown" };

/** Decimal ids plus fixture error keys (`lag`, `down`); reject path junk. */
const BOUNTY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Parse History API pathnames for Art Bounty pages.
 * Unknown paths under `/bounties` are reported so the shell can show not-found.
 */
export function parseBountyPath(pathname: string): BountyRoute {
  const normalized = normalizePath(pathname);
  if (normalized === "/bounties") {
    return { name: "list" };
  }
  if (normalized === "/bounties/new") {
    return { name: "create" };
  }
  const detail = /^\/bounties\/([^/]+)$/.exec(normalized);
  if (detail) {
    const id = decodeURIComponent(detail[1] ?? "");
    if (!BOUNTY_ID_PATTERN.test(id) || id === "new") {
      return { name: "unknown" };
    }
    return { name: "detail", id };
  }
  return { name: "unknown" };
}

export function normalizePath(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  const trimmed = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed || "/";
}

export function parseStatusFilter(raw: string | null): BountyStatus | "ALL" {
  if (!raw) {
    return "ALL";
  }
  const upper = raw.trim().toUpperCase();
  const allowed: BountyStatus[] = [
    "DRAFT",
    "ACTIVE",
    "REVIEW",
    "AWARDED",
    "EXPIRED",
    "CANCELLED",
  ];
  if (allowed.includes(upper as BountyStatus)) {
    return upper as BountyStatus;
  }
  return "ALL";
}

export function parseListSearch(search: string): {
  fundedOnly: boolean;
  status: BountyStatus | "ALL";
  query: string;
} {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const fundedParam = params.get("funded");
  // Browse defaults to funded opportunities; `funded=0` shows drafts too.
  const fundedOnly = fundedParam !== "0" && fundedParam !== "false";
  return {
    fundedOnly,
    status: parseStatusFilter(params.get("status")),
    query: (params.get("q") ?? "").trim(),
  };
}

/** True when the pathname is owned by the bounty page package. */
export function isBountyPath(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  return normalized === "/bounties" || normalized.startsWith("/bounties/");
}
