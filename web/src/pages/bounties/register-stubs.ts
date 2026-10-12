/**
 * Register real Art Bounty page mounts with F's page-mount registry.
 *
 * Keeps the historical `registerBountyPageStubs` export name so
 * `register-default-pages.ts` (owned by F) does not need edits.
 * Later registrations override earlier ones.
 */

import {
  registerPageMount,
  type PageContext,
  type PageDispose,
  type PageMount,
} from "../../app/page-registry";
import { mountBrowse } from "./browse";
import { mountCreate } from "./create";
import { mountDetail } from "./detail";
import type { BountyPageServices } from "./types";

function searchFromRoute(ctx: PageContext): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(ctx.route.query)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** Bridge F's PageContext into the self-contained bounty services shape. */
export function bountyServicesFromPageContext(
  ctx: PageContext,
): BountyPageServices {
  return {
    pathname: ctx.route.path,
    search: searchFromRoute(ctx),
    navigate: (path) => {
      ctx.navigate(path);
    },
  };
}

export const mountBountiesListPage: PageMount = (root, ctx): PageDispose =>
  mountBrowse(root, bountyServicesFromPageContext(ctx));

export const mountBountyCreatePage: PageMount = (root, ctx): PageDispose =>
  mountCreate(root, bountyServicesFromPageContext(ctx));

export const mountBountyDetailPage: PageMount = (root, ctx): PageDispose => {
  const id = ctx.route.params.id ?? "";
  return mountDetail(root, id, bountyServicesFromPageContext(ctx));
};

/** Called from F's `registerDefaultPages()` — registers fixture-backed bounty UI. */
export function registerBountyPageStubs(): void {
  registerPageMount("bounties", mountBountiesListPage);
  registerPageMount("bounties/new", mountBountyCreatePage);
  registerPageMount("bounties/:id", mountBountyDetailPage);
}

/** Explicit re-register helper if F loads stubs first and G mounts later. */
export function registerBountyPagesWithShell(): void {
  registerBountyPageStubs();
}
