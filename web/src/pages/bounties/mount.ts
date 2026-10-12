import { mountBrowse } from "./browse";
import { mountCreate } from "./create";
import { mountDetail } from "./detail";
import { createDemoBanner } from "./demo-banner";
import { parseBountyPath } from "./route";
import type { BountyPageServices, DisposeFn } from "./types";
import "./styles.css";

/**
 * Mount the Art Bounties page that matches the current path.
 * F wires this from the app shell: `mount(root, services)` → `dispose()`.
 */
export function mount(
  root: HTMLElement,
  services: BountyPageServices = {},
): DisposeFn {
  const pathname =
    services.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "/bounties");
  const route = parseBountyPath(pathname);

  if (route.name === "list") {
    return mountBrowse(root, services);
  }
  if (route.name === "create") {
    return mountCreate(root, services);
  }
  if (route.name === "detail") {
    return mountDetail(root, route.id, services);
  }

  const shell = document.createElement("section");
  shell.className = "mpoo-bounties";
  shell.append(createDemoBanner());
  const box = document.createElement("div");
  box.className = "mpoo-bounties__state mpoo-bounties__state--error";
  box.innerHTML = `<h1 tabindex="-1">Unknown bounty route</h1><p>No Art Bounties page matches this path.</p>`;
  shell.append(box);
  root.replaceChildren(shell);
  box.querySelector("h1")?.focus();
  return () => {
    root.replaceChildren();
  };
}

export { mountBrowse, mountCreate, mountDetail };
