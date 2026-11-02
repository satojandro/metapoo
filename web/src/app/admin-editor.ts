/**
 * ADM-2: the inline editor for one setting. Preview first, then confirm in the owner
 * wallet. Nothing is signed from here; `onConfirm` hands the draft to the page.
 */
import { decimals, display, editUnit, isAccountField, plainAmount } from "./admin-format";
import { decimalUnits, discountedMpooPrice, units, type ChainValue } from "./admin-settings";
import type { Draft } from "./admin-submit";

export interface EditorHandlers {
  busy: () => boolean;
  /** Validate the draft; throw with a reason to refuse it. */
  validate: (d: Draft) => void;
  onConfirm: (d: Draft) => void;
  onCancel: () => void;
  /** NEAR price per credit in yocto, for the mPOO holder-price helper. */
  nearPrice: () => ChainValue | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function button(text: string, cls: string, run: () => void, busy: boolean): HTMLButtonElement {
  const b = el("button", text, cls);
  b.type = "button";
  b.disabled = busy;
  b.addEventListener("click", run);
  return b;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function effect(d: Draft): string {
  if (d.field === "set_paused") return d.value ? "Painting and buying stop; reading the wall and revenue splits continue." : "Painting and buying resume.";
  if (/^repaint_.*_credits$/.test(d.field)) return "Counts as a NEAR price change and restarts its 24 h wait.";
  if (d.field === "set_staking_contract") return "This can be set only once, ever.";
  return d.item.rule;
}

/** Render the editor for `d` into `host`. Returns a focus hook for the first field. */
export function renderEditor(host: HTMLElement, d: Draft, h: EditorHandlers): () => void {
  host.replaceChildren();
  const busy = h.busy();
  const form = el("section", "", "admin-editor");
  form.setAttribute("aria-label", `Edit ${d.item.name}`);
  const heading = el("h3", `Edit ${d.item.name}`);
  const isBool = typeof d.original === "boolean";
  const label = el("label", `New value${isBool ? "" : ` (${editUnit(d.field)})`}`);
  const input = isBool ? document.createElement("select") : document.createElement("input");
  input.id = "admin-new-value";
  label.htmlFor = input.id;
  if (input instanceof HTMLSelectElement) {
    for (const [v, text] of [["true", "On"], ["false", "Off"]]) { const option = el("option", text); option.value = v; input.append(option); }
    input.value = String(d.value);
  } else {
    input.type = "text";
    input.autocomplete = "off";
    const places = decimals(d.field);
    input.value = places === null || d.value === null ? String(d.value ?? "") : plainAmount(d.value, places);
    if (!isAccountField(d.field)) input.inputMode = "decimal";
  }
  input.disabled = busy;
  const feedback = el("p", "", "admin-feedback");
  feedback.setAttribute("role", "status");
  const preview = el("p", "", "admin-preview");
  preview.dataset.admin = "preview";
  const confirm = button("Confirm in owner wallet", "mp-btn mp-btn-primary", () => h.onConfirm(d), busy);
  confirm.dataset.adminAction = "confirm";
  confirm.hidden = true;

  const readInput = (): ChainValue => {
    if (input instanceof HTMLSelectElement) return input.value === "true";
    const raw = input.value.trim();
    if (isAccountField(d.field)) return raw;
    const places = decimals(d.field);
    return (places === null ? units(raw) : decimalUnits(raw, places)).toString();
  };
  const reset = (): void => { confirm.hidden = true; preview.textContent = ""; };
  const previewButton = button("Preview change", "mp-btn", () => {
    try {
      d.value = readInput();
      h.validate(d);
      preview.textContent = `${d.item.name}: ${display(d.field, d.original)} → ${display(d.field, d.value)}. ${effect(d)} Your wallet attaches 1 yoctoNEAR; network gas also applies.`;
      feedback.textContent = "";
      confirm.hidden = false;
    } catch (error) { feedback.textContent = message(error); reset(); }
  }, busy);
  previewButton.dataset.adminAction = "preview";
  input.addEventListener("input", reset);
  input.addEventListener("change", reset);

  form.append(heading, label, input, el("p", d.item.rule, "admin-muted"));
  if (d.field === "set_mpoo_price") {
    const helperLabel = el("label", "7-day average pool rate (mPOO per 1 NEAR)");
    const helper = el("input");
    helper.id = "admin-pool-average";
    helper.type = "text";
    helper.inputMode = "decimal";
    helperLabel.htmlFor = helper.id;
    const use = button("Calculate the 20% holder price", "mp-btn", () => {
      try {
        const near = h.nearPrice();
        if (typeof near !== "string") throw new Error("NEAR price unavailable");
        input.value = plainAmount(discountedMpooPrice(helper.value.trim(), near), 18);
        input.dispatchEvent(new Event("input"));
        feedback.textContent = "Calculated from the average you entered. Preview before signing.";
      } catch (error) { feedback.textContent = message(error); }
    }, busy);
    form.append(helperLabel, helper, use);
  }
  const actions = el("div", "", "admin-editor-actions");
  actions.append(previewButton, confirm, button("Cancel", "mp-btn", h.onCancel, busy));
  form.append(feedback, preview, actions);
  host.append(form);
  return () => input.focus();
}
