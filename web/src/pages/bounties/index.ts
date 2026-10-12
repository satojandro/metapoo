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
export { createLiveBountyAdapter } from "./live-adapter";
export {
  createDefaultBountyAdapter,
  selectBountyAdapter,
} from "./adapter";
export {
  resolveFundingGate,
  isBountyFundingEnabledFlag,
  FUNDING_GATED_REASON,
  BOUNTY_NEAR_STORAGE_HINT,
} from "./funding-gate";
export {
  mapContractBountyToDetail,
  mapContractBountyToSummary,
  mapContractClaim,
  mapContractSubmission,
  mapBountyStatus,
  requireDecimalString,
} from "./view-map";
export { DEMO_DATA_LABEL } from "./demo-banner";
export { LIVE_VIEWS_LABEL, createModeBanner } from "./mode-banner";
export { escapeHtml, escapeAndClamp, isSafeHttpUrl } from "./escape";
export type {
  BountyAdapter,
  BountyAdapterMode,
  BountyClaimStub,
  BountyDetail,
  BountyFundingGate,
  BountyListFilters,
  BountyPageServices,
  BountyStatus,
  BountySummary,
  DisposeFn,
} from "./types";
