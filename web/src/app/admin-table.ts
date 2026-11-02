/**
 * ADM-2: the compact settings table. One row per setting: name, live value, when it
 * can next change, and Edit. Fixed rules and TOILET settings sit in a collapsed,
 * read-only section.
 */
import { ADMIN_GROUPS, type AdminSetting } from "./admin-catalog";
import { display, fieldOf, timing, valueFor } from "./admin-format";
import type { AdminSnapshot } from "./admin-settings";
import { formatExact, NEAR_DECIMALS } from "./revenue-panel";

export interface TableHandlers {
  nowMs: () => number;
  canEdit: (field: string) => boolean;
  busy: () => boolean;
  onEdit: (item: AdminSetting) => void;
}

const READ_ONLY_GROUPS = new Set(["fixed", "toilet"]);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/** Live value for rows that aren't a single field. */
function liveValue(snapshot: AdminSnapshot, item: AdminSetting, groupId: string): string {
  const field = fieldOf(item);
  const r = snapshot.records;
  const t = r.get_tunables;
  if (field === "get_mpoo_sales_today()") return r.get_mpoo_sales_today ? `${r.get_mpoo_sales_today.sold_today} sold today` : "Unavailable";
  if (field === "get_revenue_state()") {
    const rev = r.get_revenue_state;
    return rev ? `${display("set_near_price", rev.withdrawable_near)} · ${display("set_mpoo_price", rev.mpoo_undistributed)} waiting` : "Unavailable";
  }
  if (field === "quota_base · quota_per_cell · quota_max") return t ? `${t.quota_base} + ${t.quota_per_cell} per tile, max ${t.quota_max}` : "Unavailable";
  if (groupId === "fixed") {
    if (field === "REGISTRATION") return display("registration_fee", r.get_payment_config?.registration_fee);
    if (field === "WIDTH · HEIGHT · MAX_DRAW_BATCH") return r.get_board ? `${r.get_board.width} × ${r.get_board.height} tiles · 64 per stroke` : "Unavailable";
    if (field === "BURN_ACCOUNT") return String(r.get_revenue_state?.burn_account ?? "Unavailable");
    return item.launch;
  }
  return display(field, valueFor(snapshot, field));
}

function row(snapshot: AdminSnapshot, item: AdminSetting, groupId: string, h: TableHandlers, readOnly: boolean): HTMLTableRowElement {
  const field = fieldOf(item);
  // The TOILET pause is a board passthrough the console doesn't sign (TOILET round).
  readOnly ||= field === "set_toilet_paused";
  const tr = el("tr");
  tr.dataset.field = field;
  const name = el("th");
  name.scope = "row";
  name.append(el("span", item.name, "admin-name"), el("span", item.what, "admin-what"));
  const value = el("td", liveValue(snapshot, item, groupId), "admin-value");
  const raw = valueFor(snapshot, field);
  if (raw !== undefined && raw !== null && typeof raw !== "boolean") value.title = field === "reserve_floor" ? `${formatExact(BigInt(String(raw)), NEAR_DECIMALS)} NEAR` : String(raw);
  const when = el("td", "", "admin-when");
  if (readOnly || item.how === "read") when.append(el("span", readOnly ? "Read only" : "View", "admin-pill admin-pill-quiet"));
  else {
    const pill = el("span", "", "admin-pill");
    pill.dataset.clock = field;
    updatePill(pill, snapshot, field, h.nowMs());
    when.append(pill);
  }
  const action = el("td", "", "admin-action");
  if (!readOnly && h.canEdit(field)) {
    const edit = el("button", "Edit", "mp-btn admin-edit");
    edit.type = "button";
    edit.dataset.edit = field;
    edit.disabled = h.busy();
    edit.setAttribute("aria-label", `Edit ${item.name}`);
    edit.addEventListener("click", () => h.onEdit(item));
    action.append(edit);
  }
  tr.append(name, value, when, action);
  return tr;
}

export function updatePill(pill: HTMLElement, snapshot: AdminSnapshot, field: string, nowMs: number): void {
  const t = timing(snapshot.records.get_tunables, field, nowMs, valueFor(snapshot, "set_staking_contract"));
  pill.textContent = t.label;
  pill.dataset.ready = t.ready === null ? "unknown" : String(t.ready);
}

function table(caption: string, blurb: string, rows: HTMLTableRowElement[]): HTMLElement {
  const section = el("section", "", "admin-group");
  const title = el("h3", caption, "admin-group-title");
  title.id = `admin-group-${caption.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  section.setAttribute("aria-labelledby", title.id);
  const tbl = el("table", "", "admin-table");
  tbl.setAttribute("aria-labelledby", title.id);
  const head = el("thead");
  const hr = el("tr");
  for (const label of ["Setting", "Live value", "When", ""]) { const th = el("th", label); th.scope = "col"; hr.append(th); }
  head.append(hr);
  const body = el("tbody");
  body.append(...rows);
  tbl.append(head, body);
  section.append(title, el("p", blurb, "admin-muted"), tbl);
  return section;
}

export function renderSettings(host: HTMLElement, snapshot: AdminSnapshot, h: TableHandlers): void {
  host.replaceChildren();
  for (const group of ADMIN_GROUPS.filter(g => !READ_ONLY_GROUPS.has(g.id))) {
    host.append(table(group.title, group.blurb, group.items.map(item => row(snapshot, item, group.id, h, false))));
  }
  const details = el("details", "", "admin-readonly");
  details.append(el("summary", "Fixed rules and TOILET settings (read only)"));
  for (const group of ADMIN_GROUPS.filter(g => READ_ONLY_GROUPS.has(g.id))) {
    details.append(table(group.title, group.blurb, group.items.map(item => row(snapshot, item, group.id, h, true))));
  }
  host.append(details);
}
