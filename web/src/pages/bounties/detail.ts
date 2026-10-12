import { createDemoBanner } from "./demo-banner";
import { deepLinkForBountyCrop } from "./deep-link";
import { escapeHtml } from "./escape";
import { createFixtureBountyAdapter } from "./fixture-adapter";
import {
  formatAmountString,
  formatCrop,
  formatNearCost,
  formatTimestampNs,
} from "./format";
import { fundingDisplay, isOpenForPainting } from "./funded";
import type {
  BountyAdapter,
  BountyDetail,
  BountyPageServices,
  DisposeFn,
} from "./types";
import "./styles.css";

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

/**
 * Mount `/bounties/:id` detail page.
 * Help paint deep-links to `/wall` with board/x/y/zoom/bounty/template params.
 */
export function mountDetail(
  root: HTMLElement,
  bountyId: string,
  services: BountyPageServices = {},
): DisposeFn {
  const adapter: BountyAdapter =
    services.bounties ?? createFixtureBountyAdapter();
  const navigate = services.navigate ?? defaultNavigate;
  let cancelled = false;

  const shell = document.createElement("section");
  shell.className = "mpoo-bounties";
  shell.setAttribute("aria-labelledby", "mpoo-bounty-detail-heading");
  root.replaceChildren(shell);

  const renderLoading = (): void => {
    shell.replaceChildren();
    shell.append(createDemoBanner());
    const p = document.createElement("p");
    p.className = "mpoo-bounties__state";
    p.textContent = "Loading bounty…";
    shell.append(p);
  };

  const renderError = (message: string): void => {
    shell.replaceChildren();
    shell.append(createDemoBanner());
    const box = document.createElement("div");
    box.className = "mpoo-bounties__state mpoo-bounties__state--error";
    box.innerHTML = `<h1 id="mpoo-bounty-detail-heading" tabindex="-1">Bounty unavailable</h1><p></p>`;
    box.querySelector("p")!.textContent = message;
    const actions = document.createElement("div");
    actions.className = "mpoo-bounties__actions";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "mpoo-bounties__btn mpoo-bounties__btn--secondary";
    back.textContent = "Back to bounties";
    back.addEventListener("click", () => navigate("/bounties"));
    actions.append(back);
    box.append(actions);
    shell.append(box);
    box.querySelector("h1")?.focus();
  };

  const renderDetail = (bounty: BountyDetail): void => {
    shell.replaceChildren();
    shell.append(createDemoBanner());

    const funding = fundingDisplay(bounty);
    const header = document.createElement("header");
    header.className = "mpoo-bounties__header";
    const h1 = document.createElement("h1");
    h1.id = "mpoo-bounty-detail-heading";
    h1.tabIndex = -1;
    h1.textContent = bounty.title;
    header.append(h1);

    const badges = document.createElement("p");
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
      <span>id ${escapeHtml(bounty.id)}</span>
    `;
    header.append(badges);
    shell.append(header);

    const brief = document.createElement("p");
    brief.className = "mpoo-bounties__brief";
    // Untrusted brief: textContent only — no executable media.
    brief.textContent = bounty.briefText;
    shell.append(brief);

    const dl = document.createElement("dl");
    dl.className = "mpoo-bounties__dl";
    const rows: Array<[string, string]> = [
      ["Escrow amount", formatAmountString(bounty.awardAmount, bounty.tokenSymbol)],
      ["Named approver", bounty.approverAccountId],
      ["Sponsor", bounty.sponsorAccountId],
      ["Board / region", `${bounty.boardId} · ${formatCrop(bounty.crop)}`],
      ["Terms version", bounty.termsVersion],
      ["Brief hash", bounty.briefHash],
      ["Created", formatTimestampNs(bounty.createdAtNs)],
      ["Fund by", formatTimestampNs(bounty.fundByNs)],
      ["Submit by", formatTimestampNs(bounty.submitByNs)],
      ["Review by", formatTimestampNs(bounty.reviewByNs)],
      [
        "Funded at",
        bounty.fundedAtNs
          ? formatTimestampNs(bounty.fundedAtNs)
          : "Not funded (no confirmed escrow)",
      ],
      [
        "Winning submission",
        bounty.winningSubmissionId ?? "None",
      ],
    ];
    for (const [dt, dd] of rows) {
      const dtEl = document.createElement("dt");
      dtEl.textContent = dt;
      const ddEl = document.createElement("dd");
      ddEl.textContent = dd;
      dl.append(dtEl, ddEl);
    }
    shell.append(dl);

    const costs = document.createElement("div");
    costs.className = "mpoo-bounties__costs";
    costs.innerHTML = `
      <div class="mpoo-bounties__cost-row mpoo-bounties__cost-row--award">
        <span>MPOO award (escrow liability)</span>
        <span>${escapeHtml(
          formatAmountString(bounty.awardAmount, bounty.tokenSymbol),
        )}</span>
      </div>
      <div class="mpoo-bounties__cost-row">
        <span>${escapeHtml(
          formatNearCost(bounty.nearStorageDeposit, "storage"),
        )}</span>
        <span>Separate from award</span>
      </div>
      <div class="mpoo-bounties__cost-row">
        <span>${escapeHtml(formatNearCost(bounty.nearGasBudget, "gas"))}</span>
        <span>Separate from award</span>
      </div>
    `;
    shell.append(costs);

    const callout = document.createElement("div");
    callout.className = "mpoo-bounties__callout";
    callout.innerHTML = `
      <p><strong>Voluntary painters vs payout recipients.</strong>
      Anyone may help paint this region. Matching a template is coordination only —
      it is not automatic acceptance and does not create a payout claim.</p>
      <p>Only accounts named on a consented submission split can receive the MPOO award
      after the named approver accepts. Recipients must approve the exact split themselves.</p>
    `;
    shell.append(callout);

    const actions = document.createElement("div");
    actions.className = "mpoo-bounties__actions";

    const back = document.createElement("button");
    back.type = "button";
    back.className = "mpoo-bounties__btn mpoo-bounties__btn--ghost";
    back.textContent = "Back to bounties";
    back.addEventListener("click", () => navigate("/bounties"));
    actions.append(back);

    if (funding.kind === "funded" && isOpenForPainting(bounty.status)) {
      const helpPaint = document.createElement("a");
      helpPaint.className = "mpoo-bounties__btn";
      helpPaint.href = deepLinkForBountyCrop(
        bounty.id,
        bounty.boardId,
        bounty.crop,
        bounty.templateId,
      );
      helpPaint.textContent = "Help paint";
      helpPaint.addEventListener("click", (event) => {
        event.preventDefault();
        navigate(helpPaint.getAttribute("href") ?? "/wall");
      });
      actions.append(helpPaint);
    } else if (funding.kind !== "funded") {
      const note = document.createElement("p");
      note.className = "mpoo-bounties__lede";
      note.textContent =
        "Help paint is available after confirmed escrow. This record is still an unfunded draft.";
      shell.append(note);
    }

    shell.append(actions);

    const subHeading = document.createElement("h2");
    subHeading.textContent = "Submissions";
    shell.append(subHeading);

    if (bounty.submissions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "mpoo-bounties__state";
      empty.textContent =
        "No submissions yet. Finalized snapshot proposals will appear here (stub).";
      shell.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "mpoo-bounties__submissions";
      for (const sub of bounty.submissions) {
        const li = document.createElement("li");
        li.textContent = `${sub.id} · ${sub.proposerAccountId} · ${sub.state} · recipients ${String(sub.recipientCount)}${
          sub.snapshotId ? ` · snapshot ${sub.snapshotId}` : ""
        }`;
        list.append(li);
      }
      shell.append(list);
    }

    h1.focus();
  };

  renderLoading();
  void adapter.getBounty(bountyId).then((result) => {
    if (cancelled) {
      return;
    }
    if (!result.ok) {
      if (result.error === "NOT_FOUND") {
        renderError(`Unknown bounty id “${bountyId}”.`);
      } else if (result.error === "INDEX_LAG") {
        renderError(
          "Index is catching up. Authoritative escrow state is not ready yet.",
        );
      } else {
        renderError(
          "Bounty service unavailable. No live escrow was queried from this demo page.",
        );
      }
      return;
    }
    renderDetail(result.bounty);
  });

  return () => {
    cancelled = true;
    root.replaceChildren();
  };
}
