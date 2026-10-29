/**
 * Stable page-mount registry.
 *
 * A new page registers here without touching wallet wiring:
 *
 *   registerPageMount("wall", mountWallPage);
 *
 * Later registrations override earlier ones.
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
 * Logical page ids. Route matching maps URLs onto these ids.
 */
export type PageId =
  | "home"
  | "wall"
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
