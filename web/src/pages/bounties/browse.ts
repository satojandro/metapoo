import { createDefaultBountyAdapter } from "./adapter";
import { escapeAndClamp, escapeHtml } from "./escape";
import { formatAmountString, formatCrop, formatTimestampNs } from "./format";
import { fundingDisplay } from "./funded";
import { createModeBanner } from "./mode-banner";
import { parseListSearch } from "./route";
import type {
  BountyAdapter,
  BountyListFilters,
  BountyPageServices,
  BountySummary,
  DisposeFn,
} from "./types";
import "./styles.css";

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

/**
 * Mount the `/bounties` browse page into `root`.
 * Returns a dispose function that removes listeners and clears the root.
 */
export function mountBrowse(
  root: HTMLElement,
  services: BountyPageServices = {},
): DisposeFn {
  const adapter: BountyAdapter =
    services.bounties ?? createDefaultBountyAdapter();
  const navigate = services.navigate ?? defaultNavigate;
  const search =
    services.search ??
    (typeof window !== "undefined" ? window.location.search : "");
  const initial = parseListSearch(search);

  const shell = document.createElement("section");
  shell.className = "mpoo-bounties";
  shell.setAttribute("aria-labelledby", "mpoo-bounties-heading");

  shell.append(createModeBanner(adapter.mode));

  const header = document.createElement("header");
  header.className = "mpoo-bounties__header";
  header.innerHTML = `
    <h1 id="mpoo-bounties-heading" tabindex="-1">Art Bounties</h1>
    <p class="mpoo-bounties__lede">
      Browse funded commissions on the shared wall. Painting is open to everyone;
      payouts go only to consented submission recipients after the named approver accepts.
    </p>
  `;
  shell.append(header);

  const toolbar = document.createElement("form");
  toolbar.className = "mpoo-bounties__toolbar";
  toolbar.setAttribute("role", "search");
  toolbar.innerHTML = `
    <div class="mpoo-bounties__field">
      <label for="mpoo-bq-q">Search</label>
      <input id="mpoo-bq-q" name="q" type="search" autocomplete="off" />
    </div>
    <div class="mpoo-bounties__field">
      <label for="mpoo-bq-status">Lifecycle</label>
      <select id="mpoo-bq-status" name="status">
        <option value="ALL">All statuses</option>
        <option value="ACTIVE">ACTIVE</option>
        <option value="REVIEW">REVIEW</option>
        <option value="AWARDED">AWARDED</option>
        <option value="EXPIRED">EXPIRED</option>
        <option value="DRAFT">DRAFT</option>
        <option value="CANCELLED">CANCELLED</option>
      </select>
    </div>
    <div class="mpoo-bounties__field">
      <label for="mpoo-bq-funded">Funding filter</label>
      <select id="mpoo-bq-funded" name="funded">
        <option value="1">Funded only (confirmed escrow)</option>
        <option value="0">Include unfunded drafts</option>
      </select>
    </div>
    <div class="mpoo-bounties__actions">
      <button type="submit" class="mpoo-bounties__btn mpoo-bounties__btn--secondary">Apply filters</button>
      <button type="button" class="mpoo-bounties__btn" data-action="create">Create bounty</button>
    </div>
  `;
  shell.append(toolbar);

  const qInput = toolbar.querySelector<HTMLInputElement>("#mpoo-bq-q")!;
  const statusSelect =
    toolbar.querySelector<HTMLSelectElement>("#mpoo-bq-status")!;
  const fundedSelect =
    toolbar.querySelector<HTMLSelectElement>("#mpoo-bq-funded")!;
  qInput.value = initial.query;
  statusSelect.value = initial.status;
  fundedSelect.value = initial.fundedOnly ? "1" : "0";

  const results = document.createElement("div");
  results.className = "mpoo-bounties__results";
  results.setAttribute("aria-live", "polite");
  shell.append(results);

  root.replaceChildren(shell);
  header.querySelector("h1")?.focus();

  let cancelled = false;
  let accumulated: BountySummary[] = [];
  let nextFromIndex: number | null = null;
  let listTruncated = false;

  const renderResults = (): void => {
    results.replaceChildren();

    if (listTruncated) {
      results.append(
        renderPartialNotice(accumulated.length === 0, () => {
          void loadMore();
        }),
      );
    }

    if (accumulated.length === 0) {
      if (!listTruncated) {
        const box = document.createElement("div");
        box.className = "mpoo-bounties__state";
        box.textContent =
          "No bounties match these filters. Clear search or widen the lifecycle filter.";
        results.append(box);
      }
      return;
    }

    const list = document.createElement("ul");
    list.className = "mpoo-bounties__list";
    for (const bounty of accumulated) {
      list.append(renderCard(bounty, navigate));
    }
    results.append(list);
  };

  const currentFilters = (): BountyListFilters => ({
    query: qInput.value.trim(),
    status: statusSelect.value as BountyListFilters["status"],
    fundedOnly: fundedSelect.value !== "0",
  });

  const load = async (): Promise<void> => {
    accumulated = [];
    nextFromIndex = null;
    listTruncated = false;
    results.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "mpoo-bounties__state";
    loading.textContent = "Loading bounties…";
    results.append(loading);

    const result = await adapter.listBounties(currentFilters());
    if (cancelled) {
      return;
    }
    results.replaceChildren();

    if (!result.ok) {
      const box = document.createElement("div");
      box.className = "mpoo-bounties__state mpoo-bounties__state--error";
      if (result.error === "SERVICE_UNAVAILABLE") {
        box.textContent =
          result.message ??
          (adapter.mode === "live"
            ? "Bounty escrow views unavailable. Check VITE_BOUNTY_CONTRACT_ID and RPC."
            : "Bounty service unavailable. Demo fixtures could not be read. No live escrow was queried.");
      } else if (result.error === "EMPTY") {
        box.textContent =
          "No funded bounties yet. You can still browse disconnectedly and create a draft.";
      } else {
        box.textContent =
          "No bounties match these filters. Clear search or widen the lifecycle filter.";
      }
      results.append(box);
      return;
    }

    accumulated = result.items;
    listTruncated = Boolean(result.truncated);
    nextFromIndex =
      result.truncated && result.nextFromIndex != null
        ? result.nextFromIndex
        : null;
    renderResults();
  };

  const loadMore = async (): Promise<void> => {
    if (nextFromIndex == null) {
      return;
    }
    const fromIndex = nextFromIndex;
    const loading = document.createElement("p");
    loading.className = "mpoo-bounties__state";
    loading.textContent = "Loading more bounties…";
    results.append(loading);

    const result = await adapter.listBounties({
      ...currentFilters(),
      fromIndex,
    });
    if (cancelled) {
      return;
    }
    if (!result.ok) {
      // Exhausted final pages with no matches is normal completion, not a failure.
      if (result.error === "NO_MATCHES" || result.error === "EMPTY") {
        listTruncated = false;
        nextFromIndex = null;
        renderResults();
        return;
      }
      loading.className = "mpoo-bounties__state mpoo-bounties__state--error";
      loading.textContent =
        result.message ?? "Could not load more bounties from escrow.";
      return;
    }
    const seen = new Set(accumulated.map((b) => b.id));
    for (const item of result.items) {
      if (!seen.has(item.id)) {
        accumulated.push(item);
        seen.add(item.id);
      }
    }
    listTruncated = Boolean(result.truncated);
    nextFromIndex =
      result.truncated && result.nextFromIndex != null
        ? result.nextFromIndex
        : null;
    renderResults();
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    void load();
  };
  const onCreate = (): void => {
    navigate("/bounties/new");
  };

  toolbar.addEventListener("submit", onSubmit);
  toolbar
    .querySelector("[data-action=create]")
    ?.addEventListener("click", onCreate);

  void load();

  return () => {
    cancelled = true;
    toolbar.removeEventListener("submit", onSubmit);
    toolbar
      .querySelector("[data-action=create]")
      ?.removeEventListener("click", onCreate);
    root.replaceChildren();
  };
}

function renderPartialNotice(
  emptyMatches: boolean,
  onContinue: () => void,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "mpoo-bounties__callout mpoo-bounties__callout--partial";
  box.setAttribute("role", "status");
  const text = document.createElement("p");
  text.textContent = emptyMatches
    ? "No matches in the pages loaded so far. Results are partial — later bounties were not searched yet."
    : "Showing a partial list. More bounties exist beyond this page; filters only applied to loaded pages.";
  box.append(text);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mpoo-bounties__btn mpoo-bounties__btn--secondary";
  btn.textContent = "Load more";
  btn.addEventListener("click", onContinue);
  box.append(btn);
  return box;
}

function renderCard(
  bounty: BountySummary,
  navigate: (path: string) => void,
): HTMLLIElement {
  const funding = fundingDisplay(bounty);
  const li = document.createElement("li");
  li.className = "mpoo-bounties__card";

  const title = document.createElement("h2");
  title.textContent = bounty.title;

  const badges = document.createElement("div");
  badges.className = "mpoo-bounties__meta";
  badges.innerHTML = `
    <span class="mpoo-bounties__badge mpoo-bounties__badge--${
      funding.kind === "funded"
        ? "funded"
        : funding.kind === "cancelled"
          ? "cancelled"
          : "draft"
    }">${escapeHtml(funding.label)}</span>
    <span class="mpoo-bounties__badge mpoo-bounties__badge--status">${escapeHtml(
      bounty.status,
    )}</span>
  `;

  const brief = document.createElement("p");
  brief.className = "mpoo-bounties__brief";
  // Escape untrusted brief — never inject as HTML.
  brief.innerHTML = escapeAndClamp(bounty.briefText, 180);

  const meta = document.createElement("p");
  meta.className = "mpoo-bounties__meta";
  meta.textContent = [
    formatAmountString(bounty.awardAmount, bounty.tokenSymbol),
    `Approver ${bounty.approverAccountId}`,
    `Region ${formatCrop(bounty.crop)}`,
    `Submit by ${formatTimestampNs(bounty.submitByNs)}`,
  ].join(" · ");

  const actions = document.createElement("div");
  actions.className = "mpoo-bounties__actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mpoo-bounties__btn mpoo-bounties__btn--secondary";
  open.textContent = "Open bounty";
  open.addEventListener("click", () => navigate(`/bounties/${bounty.id}`));
  actions.append(open);

  li.append(title, badges, brief, meta, actions);
  return li;
}
