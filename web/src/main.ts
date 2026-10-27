// Must be first: installs browser globals (Buffer/global/process) that the
// NEAR client libraries need before any of them is evaluated.
import "./polyfills";
import "./style.css";
import "./wall-design.css";
import { createAppServices } from "./app/services";
import { createRouter } from "./app/router";
import { mountShell } from "./app/shell";
import { registerDefaultPages } from "./pages/register-default-pages";

/**
 * App entry: shell + History API router + shared wallet/operations services.
 * Wall gameplay lives in mountWall(root, services) → dispose().
 */

registerDefaultPages();

const host = document.querySelector<HTMLElement>("#app");
if (!host) {
  throw new Error("The page is missing required element #app.");
}

const services = createAppServices();
const shell = mountShell(host, services);
const router = createRouter({
  outlet: shell.outlet,
  services,
  onRouteChange: (route) => {
    shell.setActiveNav(route);
  },
});

router.start();

// Expose a stable hook for Worker G (and tests) without editing wallet wiring.
export {
  registerPageMount,
  getPageMount,
  type PageMount,
  type PageId,
  type PageContext,
  type PageDispose,
} from "./app/page-registry";
export type { AppServices } from "./app/services";
export { createAppServices } from "./app/services";
export { createRouter } from "./app/router";
export { matchRoute, buildHref } from "./app/routes";
export { mountWall, mountWallPage } from "./pages/wall/mount-wall";
