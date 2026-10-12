/**
 * Art Bounties page package (Worker G / T0.G).
 *
 * F integration (preferred — already called from register-default-pages):
 *   import { registerBountyPageStubs } from "./pages/bounties/register-stubs";
 *   registerBountyPageStubs(); // registerPageMount("bounties" | "bounties/new" | "bounties/:id")
 *
 * Standalone mount API:
 *   import { mount } from "./pages/bounties";
 *   const dispose = mount(root, { pathname, navigate, search });
 */

export { mount, mountBrowse, mountCreate, mountDetail } from "./mount";
export {
  BOUNTY_ROUTE_TABLE,
  matchBountyRoute,
  registerBountyPages,
  registerBountyPageStubs,
  registerBountyPagesWithShell,
  mountBountiesListPage,
  mountBountyCreatePage,
  mountBountyDetailPage,
  type BountyRouteDescriptor,
} from "./register";
export {
  parseBountyPath,
  parseListSearch,
  parseStatusFilter,
  isBountyPath,
  normalizePath,
} from "./route";
export {
  buildHelpPaintDeepLink,
  deepLinkForBountyCrop,
  parseHelpPaintSearch,
  clampBoardCoord,
  clampZoom,
} from "./deep-link";
export { fundingDisplay, isFundedOpportunity, isOpenForPainting } from "./funded";
export { createFixtureBountyAdapter } from "./fixture-adapter";
export { DEMO_DATA_LABEL } from "./demo-banner";
export { escapeHtml, escapeAndClamp, isSafeHttpUrl } from "./escape";
export type {
  BountyAdapter,
  BountyDetail,
  BountyListFilters,
  BountyPageServices,
  BountyStatus,
  BountySummary,
  DisposeFn,
} from "./types";
