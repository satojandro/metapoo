import { createDemoBanner } from "./demo-banner";
import { escapeHtml } from "./escape";
import { formatAmountString, formatNearCost } from "./format";
import type { BountyPageServices, DisposeFn } from "./types";
import "./styles.css";

type CreateStep = "terms" | "funding_review";

interface DraftTerms {
  title: string;
  briefText: string;
  boardId: string;
  x: string;
  y: string;
  width: string;
  height: string;
  awardAmount: string;
  fundByLocal: string;
  submitByLocal: string;
  reviewByLocal: string;
  /** Fixture-only: whether the local draft is marked ready to fund. */
  readyToFund: boolean;
}

const NEAR_STORAGE = "0.05";
const NEAR_GAS = "0.01";

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

/**
 * Mount `/bounties/new` — terms → funding review.
 * Fixture-backed only: no wallet transfer is sent from this page.
 */
export function mountCreate(
  root: HTMLElement,
  services: BountyPageServices = {},
): DisposeFn {
  const navigate = services.navigate ?? defaultNavigate;
  let step: CreateStep = "terms";
  let draft: DraftTerms = {
    title: "",
    briefText: "",
    boardId: "board-main",
    x: "40",
    y: "20",
    width: "24",
    height: "24",
    awardAmount: "1000000000000000000000000",
    fundByLocal: "",
    submitByLocal: "",
    reviewByLocal: "",
    readyToFund: false,
  };

  const shell = document.createElement("section");
  shell.className = "mpoo-bounties";
  shell.setAttribute("aria-labelledby", "mpoo-bounty-create-heading");

  const render = (): void => {
    shell.replaceChildren();
    shell.append(createDemoBanner());

    const header = document.createElement("header");
    header.className = "mpoo-bounties__header";
    header.innerHTML = `
      <h1 id="mpoo-bounty-create-heading" tabindex="-1">Create Art Bounty</h1>
      <p class="mpoo-bounties__lede">
        Set immutable terms, then review funding. NEAR storage and gas are separate
        from the MPOO award. This demo never moves funds or NFTs.
      </p>
    `;
    shell.append(header);

    const steps = document.createElement("ol");
    steps.className = "mpoo-bounties__steps";
    steps.innerHTML = `
      <li ${step === "terms" ? 'aria-current="step"' : ""}>1. Terms</li>
      <li ${step === "funding_review" ? 'aria-current="step"' : ""}>2. Funding review</li>
    `;
    shell.append(steps);

    if (step === "terms") {
      shell.append(renderTermsForm());
    } else {
      shell.append(renderFundingReview());
    }

    header.querySelector("h1")?.focus();
  };

  const renderTermsForm = (): HTMLElement => {
    const form = document.createElement("form");
    form.className = "mpoo-bounties__form";
    form.innerHTML = `
      <div class="mpoo-bounties__field">
        <label for="bq-title">Title</label>
        <input id="bq-title" name="title" required maxlength="80" />
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-brief">Artist brief (plain text only)</label>
        <textarea id="bq-brief" name="brief" required maxlength="2000"></textarea>
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-board">Board id</label>
        <input id="bq-board" name="boardId" required />
      </div>
      <div class="mpoo-bounties__toolbar">
        <div class="mpoo-bounties__field">
          <label for="bq-x">Crop x</label>
          <input id="bq-x" name="x" inputmode="numeric" required />
        </div>
        <div class="mpoo-bounties__field">
          <label for="bq-y">Crop y</label>
          <input id="bq-y" name="y" inputmode="numeric" required />
        </div>
        <div class="mpoo-bounties__field">
          <label for="bq-w">Width</label>
          <input id="bq-w" name="width" inputmode="numeric" required />
        </div>
        <div class="mpoo-bounties__field">
          <label for="bq-h">Height</label>
          <input id="bq-h" name="height" inputmode="numeric" required />
        </div>
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-award">MPOO award amount (decimal string, smallest units)</label>
        <input id="bq-award" name="awardAmount" required pattern="\\d+" />
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-fund-by">Fund-by deadline (local datetime)</label>
        <input id="bq-fund-by" name="fundBy" type="datetime-local" required />
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-submit-by">Submission deadline (local datetime)</label>
        <input id="bq-submit-by" name="submitBy" type="datetime-local" required />
      </div>
      <div class="mpoo-bounties__field">
        <label for="bq-review-by">Review deadline (local datetime)</label>
        <input id="bq-review-by" name="reviewBy" type="datetime-local" required />
      </div>
      <p class="mpoo-bounties__lede">
        Approver is the connected sponsor account (fixed in v1). Token is MPOO (test).
        Subjective acceptance is the named approver’s decision — painting does not guarantee payment.
      </p>
      <div class="mpoo-bounties__actions">
        <button type="button" class="mpoo-bounties__btn mpoo-bounties__btn--ghost" data-action="back">Cancel</button>
        <button type="submit" class="mpoo-bounties__btn" data-action="save-draft">Save unfunded draft</button>
        <button type="submit" class="mpoo-bounties__btn mpoo-bounties__btn--secondary" data-action="ready">Continue to funding review</button>
      </div>
    `;

    const fill = (id: string, value: string): void => {
      const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
      if (el) {
        el.value = value;
      }
    };
    fill("bq-title", draft.title);
    fill("bq-brief", draft.briefText);
    fill("bq-board", draft.boardId);
    fill("bq-x", draft.x);
    fill("bq-y", draft.y);
    fill("bq-w", draft.width);
    fill("bq-h", draft.height);
    fill("bq-award", draft.awardAmount);
    fill("bq-fund-by", draft.fundByLocal);
    fill("bq-submit-by", draft.submitByLocal);
    fill("bq-review-by", draft.reviewByLocal);

    const readDraft = (): DraftTerms => ({
      title: (form.querySelector("#bq-title") as HTMLInputElement).value.trim(),
      briefText: (form.querySelector("#bq-brief") as HTMLTextAreaElement).value,
      boardId: (form.querySelector("#bq-board") as HTMLInputElement).value.trim(),
      x: (form.querySelector("#bq-x") as HTMLInputElement).value.trim(),
      y: (form.querySelector("#bq-y") as HTMLInputElement).value.trim(),
      width: (form.querySelector("#bq-w") as HTMLInputElement).value.trim(),
      height: (form.querySelector("#bq-h") as HTMLInputElement).value.trim(),
      awardAmount: (form.querySelector("#bq-award") as HTMLInputElement).value.trim(),
      fundByLocal: (form.querySelector("#bq-fund-by") as HTMLInputElement).value,
      submitByLocal: (form.querySelector("#bq-submit-by") as HTMLInputElement).value,
      reviewByLocal: (form.querySelector("#bq-review-by") as HTMLInputElement).value,
      readyToFund: false,
    });

    form
      .querySelector("[data-action=back]")
      ?.addEventListener("click", () => navigate("/bounties"));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = (event as SubmitEvent).submitter as HTMLElement | null;
      const action = submitter?.getAttribute("data-action") ?? "ready";
      draft = readDraft();
      if (!/^\d+$/.test(draft.awardAmount)) {
        window.alert("Award amount must be a decimal digit string.");
        return;
      }
      draft.readyToFund = action === "ready";
      step = "funding_review";
      render();
    });

    return form;
  };

  const renderFundingReview = (): HTMLElement => {
    const panel = document.createElement("div");
    const fundingLabel = draft.readyToFund
      ? "Ready to fund (fixture review only)"
      : "Unfunded draft";
    const fundingClass = draft.readyToFund ? "funded" : "draft";

    panel.innerHTML = `
      <p>
        <span class="mpoo-bounties__badge mpoo-bounties__badge--${fundingClass}">${escapeHtml(
          fundingLabel,
        )}</span>
        <span class="mpoo-bounties__badge mpoo-bounties__badge--status">DRAFT</span>
      </p>
      <dl class="mpoo-bounties__dl">
        <dt>Title</dt><dd></dd>
        <dt>Brief</dt><dd class="mpoo-bounties__brief"></dd>
        <dt>Approver</dt><dd>Connected sponsor (you) — fixed in v1</dd>
        <dt>Board / crop</dt><dd></dd>
        <dt>Fund by</dt><dd></dd>
        <dt>Submit by</dt><dd></dd>
        <dt>Review by</dt><dd></dd>
      </dl>
      <div class="mpoo-bounties__costs">
        <div class="mpoo-bounties__cost-row mpoo-bounties__cost-row--award">
          <span>MPOO award (escrow liability)</span>
          <span></span>
        </div>
        <div class="mpoo-bounties__cost-row">
          <span>${escapeHtml(formatNearCost(NEAR_STORAGE, "storage"))}</span>
          <span>Prepaid separately — not part of the award</span>
        </div>
        <div class="mpoo-bounties__cost-row">
          <span>${escapeHtml(formatNearCost(NEAR_GAS, "gas"))}</span>
          <span>Network fee — not part of the award</span>
        </div>
      </div>
      <div class="mpoo-bounties__callout">
        <p><strong>Escrow is not confirmed</strong> until a successful funding readback.
        Saving a draft or reviewing terms never labels this bounty Funded.</p>
        <p>On expiry without an award, only the sponsor receives the refund entitlement.
        Painting the region does not create a payout claim.</p>
      </div>
      <div class="mpoo-bounties__actions">
        <button type="button" class="mpoo-bounties__btn mpoo-bounties__btn--ghost" data-action="edit">Edit terms</button>
        <button type="button" class="mpoo-bounties__btn mpoo-bounties__btn--secondary" data-action="list">Back to bounties</button>
        <button type="button" class="mpoo-bounties__btn" data-action="fund" ${
          draft.readyToFund ? "" : "disabled"
        }>Sign funding (demo disabled)</button>
      </div>
    `;

    const dds = panel.querySelectorAll("dd");
    dds[0]!.textContent = draft.title;
    dds[1]!.textContent = draft.briefText;
    dds[3]!.textContent = `${draft.boardId} · (${draft.x}, ${draft.y}) · ${draft.width}×${draft.height}`;
    dds[4]!.textContent = `${draft.fundByLocal || "—"} (local)`;
    dds[5]!.textContent = `${draft.submitByLocal || "—"} (local)`;
    dds[6]!.textContent = `${draft.reviewByLocal || "—"} (local)`;

    const awardSpan = panel.querySelector<HTMLElement>(
      ".mpoo-bounties__cost-row--award span:last-child",
    );
    if (awardSpan) {
      awardSpan.textContent = formatAmountString(
        draft.awardAmount,
        "MPOO (test)",
      );
    }

    panel
      .querySelector("[data-action=edit]")
      ?.addEventListener("click", () => {
        step = "terms";
        render();
      });
    panel
      .querySelector("[data-action=list]")
      ?.addEventListener("click", () => navigate("/bounties"));
    panel
      .querySelector("[data-action=fund]")
      ?.addEventListener("click", () => {
        window.alert(
          "Demo data — no funds or NFTs. Wallet funding is owned by the shell integrator and is not sent from this fixture page.",
        );
      });

    return panel;
  };

  root.replaceChildren(shell);
  render();

  return () => {
    root.replaceChildren();
  };
}
