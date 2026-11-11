// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { mountNotFoundPage } from "./not-found-page";
import { getPageMount, type PageContext } from "./page-registry";
import { matchRoute } from "./routes";
import { registerDefaultPages } from "../pages/register-default-pages";

/** The not-found mount only reads the route it was given. */
const ctx = (path: string): PageContext => ({
  route: matchRoute(path),
  navigate: () => {},
  services: {} as PageContext["services"],
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});

function mount(path = "/nope") {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = mountNotFoundPage(root, ctx(path));
  cleanups.push(() => {
    dispose();
    root.remove();
  });
  return root;
}

it("renders the player-facing 404 on an unknown path", () => {
  expect(matchRoute("/nope").pageId).toBe("not-found");
  const root = mount("/nope");
  expect(root.textContent).toContain("Nothing painted here.");
  expect(root.textContent).toContain("That page isn't on the wall.");
  expect(root.textContent).not.toContain("not a known Meta Poo route");
});

it("offers one primary button back to the wall", () => {
  const root = mount();
  const button = root.querySelector<HTMLAnchorElement>("a.mp-btn-primary")!;
  expect(button.textContent).toBe("Go to the wall");
  expect(button.getAttribute("href")).toBe("/wall");
});

it("reuses the /admin signed-out hero classes instead of a second hero", () => {
  const root = mount();
  expect(root.querySelector("article.admin-head > .admin-head-text h2")).not.toBeNull();
  expect(root.querySelector(".admin-visitor")).not.toBeNull();
  expect(root.querySelector(".admin-head-actions a.mp-btn-primary")).not.toBeNull();
  // The `.admin` frame is left off on purpose: its `a` rule would recolour the
  // primary button. The hero classes carry the layout.
  expect(root.querySelector(".admin")).toBeNull();
  expect(root.querySelector(".page-stub")).toBeNull();
});

it("is the mount the router resolves for an unknown path", () => {
  registerDefaultPages();
  expect(getPageMount("not-found")).toBe(mountNotFoundPage);
});
