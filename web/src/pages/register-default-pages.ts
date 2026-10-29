/**
 * Register default mounts for all routes.
 */

import { registerPageMount } from "../app/page-registry";
import { mountWallPage } from "./wall/mount-wall";
import { createStubPage } from "./stub-page";

export function registerDefaultPages(): void {
  registerPageMount("home", mountWallPage);
  registerPageMount("wall", mountWallPage);
  registerPageMount(
    "not-found",
    createStubPage({
      title: "Not found",
      body: "That path is not a known Meta Poo route.",
    }),
  );
}
