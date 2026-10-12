/** Persistent Wave 0 rehearsal label — required on every bounty screen. */
export const DEMO_DATA_LABEL = "Demo data — no funds or NFTs";

export function createDemoBanner(): HTMLElement {
  const banner = document.createElement("p");
  banner.className = "mpoo-bounties__demo";
  banner.setAttribute("role", "status");
  banner.textContent = DEMO_DATA_LABEL;
  return banner;
}
