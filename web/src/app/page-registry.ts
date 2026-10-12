/**
 * Stable page-mount registry.
 *
 * Worker G registers bounty pages here without touching wallet wiring:
 *
 *   import { registerPageMount } from "../../app/page-registry";
 *   registerPageMount("bounties", mountBountiesList);
 *   registerPageMount("bounties/new", mountBountyCreate);
 *   registerPageMount("bounties/:id", mountBountyDetail);
 *
 * Later registrations override earlier ones (defaults → Worker G).
 */

import type { AppServices } from "./services";
import type { ParsedRoute } from "./routes";

export type PageDispose = () => void;

export interface PageContext {
  services: AppServices;
  route: ParsedRoute;
  /** Navigate within the app (History API). */
  navigate: (path: string, options?: { replace?: boolean }) => void;
}

export type PageMount = (root: HTMLElement, ctx: PageContext) => PageDispose;

/**
 * Logical page ids. Route matching maps URLs onto these ids;
 * Worker G only needs the bounty* ids.
 */
export type PageId =
  | "home"
  | "wall"
  | "bounties"
  | "bounties/new"
  | "bounties/:id"
  | "history"
  | "prints/:id"
  | "account"
  | "not-found";

const mounts = new Map<PageId, PageMount>();

export function registerPageMount(id: PageId, mount: PageMount): void {
  mounts.set(id, mount);
}

export function getPageMount(id: PageId): PageMount | undefined {
  return mounts.get(id);
}

export function listRegisteredPageIds(): PageId[] {
  return [...mounts.keys()];
}

/** Test helper: clear all mounts. */
export function clearPageMounts(): void {
  mounts.clear();
}
