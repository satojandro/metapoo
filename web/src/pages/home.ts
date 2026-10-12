/**
 * Stall entrance / overview. Links to focused /wall — not a second board.
 */

import type { PageDispose, PageMount } from "../app/page-registry";
import { isContractConfigured } from "../contract";
import { CONTRACT_ID, PAGE_NETWORK } from "../config";

export const mountHome: PageMount = (root): PageDispose => {
  const section = document.createElement("section");
  section.className = "page-home";
  section.setAttribute("aria-label", "Stall entrance");

  const heading = document.createElement("h2");
  heading.dataset.routeHeading = "true";
  heading.textContent = "Stall entrance";

  const lede = document.createElement("p");
  lede.className = "lede";
  lede.textContent = isContractConfigured()
    ? `Step into the stall to open the live communal wall (${CONTRACT_ID} on ${PAGE_NETWORK}). Painting happens on the wall page — this entrance is overview only.`
    : "Step into the stall to open the communal wall. No contract id is configured yet, so the wall stays on a labelled local mock until VITE_CONTRACT_ID is set.";

  const scene = document.createElement("div");
  scene.className = "home-stall-teaser";
  scene.setAttribute("aria-hidden", "true");
  scene.innerHTML = `
    <div class="home-stall-frame">
      <p class="home-stall-label">shared pixel wall</p>
    </div>
  `;

  const cta = document.createElement("p");
  cta.className = "home-cta";
  const wallLink = document.createElement("a");
  wallLink.href = "/wall";
  wallLink.className = "action place home-open-wall";
  wallLink.textContent = "Open wall";
  cta.append(wallLink);

  const secondary = document.createElement("p");
  secondary.className = "help";
  secondary.innerHTML = ""; // textContent only below
  const bountyLink = document.createElement("a");
  bountyLink.href = "/bounties";
  bountyLink.textContent = "Art Bounties";
  const historyLink = document.createElement("a");
  historyLink.href = "/history";
  historyLink.textContent = "History";
  secondary.append(
    document.createTextNode("Also: "),
    bountyLink,
    document.createTextNode(" · "),
    historyLink,
    document.createTextNode(" · (fixture pages until those modules ship)"),
  );

  section.append(heading, lede, scene, cta, secondary);
  root.append(section);

  return () => {
    root.replaceChildren();
  };
};
