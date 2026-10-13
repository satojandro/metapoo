/**
 * Register default mounts for all routes.
 * Bounty stubs are replaceable by Worker G via registerPageMount.
 */

import { registerPageMount } from "../app/page-registry";
import { mountWallPage } from "./wall/mount-wall";
import { registerBountyPageStubs } from "./bounties/register-stubs";
import { createStubPage } from "./stub-page";

export function registerDefaultPages(): void {
  registerPageMount("home", mountWallPage);
  registerPageMount("wall", mountWallPage);

  // Keep integration pages available explicitly, but out of the core-wall release.
  if (import.meta.env.VITE_EXTRA_PAGES_ENABLED === "true") {
    registerBountyPageStubs();
  } else {
    const unavailable = createStubPage({
      title: "The wall comes first.",
      body: "Bounties are taking a little longer. For now, explore the communal wall.",
      note: "Bounties are not enabled in this preview.",
    });
    registerPageMount("bounties", unavailable);
    registerPageMount("bounties/new", unavailable);
    registerPageMount("bounties/:id", unavailable);
  }

  registerPageMount(
    "history",
    createStubPage({
      title: "History",
      body: "Finalized time navigation and wall replay will live here.",
      note: "Worker H owns history pages.",
    }),
  );
  registerPageMount(
    "prints/:id",
    createStubPage({
      title: "Print",
      body: "Canonical artwork, edition list, and verification will live here.",
      note: "Worker H owns print pages.",
    }),
  );
  registerPageMount(
    "account",
    createStubPage({
      title: "My activity",
      body: "Paint balance, pending operations, submissions, and collected prints will live here.",
      note: "Worker H owns the account page. Global wallet/ops chrome already survives navigation.",
    }),
  );
  registerPageMount(
    "not-found",
    createStubPage({
      title: "Not found",
      body: "That path is not a known Meta Poo route.",
    }),
  );
}
