/** Public /admin page. Reads have no wallet dependency; every edit uses the owner wallet. */
import { explorerUrl } from "@shared/board-rules.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import { signAndSendAdminChange } from "../wallet";
import { isUserRejection, parseTxOutcome } from "../tx-outcome";
import type { PageContext, PageDispose } from "./page-registry";
import { ADMIN_GROUPS, type AdminSetting } from "./admin-catalog";
import { loadAdminHistory, type AdminHistoryEntry } from "./admin-history";
import { ACCOUNT_ID, DAY_NS, EDITABLE_TUNABLES, changedFields, cooldownUntil, createAdminView, decimalUnits,
  discountedMpooPrice, loadAdmin, prepareTunableChange, priceChange, record, stringifyChainJson, units, validateTunables,
  type AdminSnapshot, type ChainRecord, type ChainValue } from "./admin-settings";
import { countdown, formatExact, isMethodNotFound, type View } from "./revenue-panel";
import "./admin-page.css";

export interface AdminPageDeps {
  load: () => Promise<AdminSnapshot>;
  view: View;
  sign: typeof signAndSendAdminChange;
  history: () => Promise<AdminHistoryEntry[]>;
  now: () => number;
  network: string;
  board: string;
  configured: boolean;
  pollMs: number;
}
function defaults(): AdminPageDeps {
  const view = createAdminView(RPC_URL);
  return { view, load: () => loadAdmin(view, CONTRACT_ID, import.meta.env.VITE_BOARD_OWNER?.trim()),
    sign: signAndSendAdminChange, history: () => loadAdminHistory(PAGE_NETWORK, CONTRACT_ID), now: Date.now,
    network: PAGE_NETWORK, board: CONTRACT_ID, configured: !!CONTRACT_ID, pollMs: 60_000 };
}
const template = `<article class="admin" aria-labelledby="admin-title">
  <header class="admin-head"><p class="admin-eyebrow">Meta Poo · board settings</p>
    <h2 id="admin-title" data-route-heading="true">Every knob on the board.</h2>
    <p>See the rules behind the wall. Anyone can look; only the board’s owner can change a setting.</p>
    <p data-admin="source" class="admin-source" role="status"></p>
    <button class="action secondary" type="button" data-admin-action="refresh">Refresh live settings</button>
  </header>
  <p class="admin-notice" data-admin="notice" role="status"></p>
  <div class="admin-status" data-admin="status" aria-label="Board status"></div>
  <nav class="admin-filters" aria-label="Filter board settings" data-admin="filters"></nav>
  <div data-admin="editor"></div>
  <p class="admin-result" data-admin="result" role="status"></p>
  <div class="admin-groups" data-admin="groups"></div>
  <section class="admin-history"><h3>Recent changes</h3><p>Recent owner transactions, including tunables changes. Open a transaction to inspect its events and outcome.</p>
    <p data-admin="history-note" role="status"></p><ol data-admin="history"></ol>
  </section>
</article>`;

const fieldOf = (item: AdminSetting): string => item.field.startsWith("set_") ? item.field.split("(")[0] : item.field;
const decimals = (field: string): number | null => field === "reserve_floor" || field === "set_near_price" ? 24 : field === "set_mpoo_price" ? 18 : field.endsWith("_ns") ? 9 : null;
const editUnit = (field: string): string => decimals(field) === 24 ? "NEAR" : decimals(field) === 18 ? "mPOO" : decimals(field) === 9 ? "seconds" : field === "happy_hour_start_s" ? "seconds after midnight UTC" : field === "happy_hour_weekday" ? "Monday 0 – Sunday 6" : "whole number";
function plainAmount(value: ChainValue, places: number): string { return formatExact(units(value), places).replaceAll(",", ""); }
function duration(value: ChainValue): string {
  const seconds = units(value) / 1_000_000_000n;
  const h = seconds / 3600n, m = seconds % 3600n / 60n, s = seconds % 60n;
  return [h ? `${h} h` : "", m ? `${m} min` : "", s || (!h && !m) ? `${s} s` : ""].filter(Boolean).join(" ");
}
function display(field: string, value: ChainValue | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value === null) return "Not set";
  if (field === "first_fill_complete") return value ? "Full · free first paints ended" : "Still filling";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field === "reserve_floor" || field === "set_near_price" || field === "registration_fee") return `${plainAmount(value,24)} NEAR`;
  if (field === "set_mpoo_price") return `${plainAmount(value,18)} mPOO`;
  if (field === "toilet_per_cell_second") return `${plainAmount(value,18)} TOILET / cell / second`;
  if (field === "happy_hour_length_s") return duration(units(value) * 1_000_000_000n);
  if (field.endsWith("_ns")) return duration(value);
  if (field === "happy_hour_weekday") return ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][Number(value)] ?? "Unavailable";
  if (field === "happy_hour_start_s") {
    const n = Number(value);
    const utc = `${String(Math.floor(n/3600)).padStart(2,"0")}:${String(Math.floor(n%3600/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")} UTC`;
    const date = new Date(); date.setUTCHours(Math.floor(n/3600),Math.floor(n%3600/60),n%60,0);
    return `${utc} · ${date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",timeZoneName:"short"})} today locally`;
  }
  if (field === "max_outstanding_credits" && units(value) === 0n) return "No limit";
  return String(value);
}

export function mountAdminPage(root: HTMLElement, ctx: PageContext, overrides: Partial<AdminPageDeps> = {}): PageDispose {
  const deps = { ...defaults(), ...overrides };
  root.insertAdjacentHTML("beforeend", template);
  const page = root.querySelector<HTMLElement>(".admin")!;
  const $ = (key: string) => page.querySelector<HTMLElement>(`[data-admin="${key}"]`)!;
  let snapshot: AdminSnapshot | null = null;
  let disposed = false, busy = false, refreshing = false, generation = 0;
  let filter = "all";
  let history: AdminHistoryEntry[] | null = null;
  let draft: { item: AdminSetting; field: string; baseline: ChainRecord; value: ChainValue; original: ChainValue; confirmed: boolean } | null = null;
  const t = () => snapshot?.records.get_tunables;
  const session = () => ctx.services.wallet.getSession();
  const owner = () => !!snapshot?.owner && session().accountId === snapshot.owner && session().networkId === deps.network && deps.configured;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el;
  }
  function button(text: string, run: () => void): HTMLButtonElement {
    const b=element("button",text,"action secondary"); b.type="button"; b.disabled=busy; b.addEventListener("click",run); return b;
  }
  function valueFor(field: string): ChainValue | undefined {
    const r = snapshot?.records;
    if (!r) return undefined;
    if (field === "set_paused") return t()?.paused;
    if (field === "set_toilet_paused") return undefined;
    if (field === "set_near_price") return r.get_payment_config?.near_per_credit;
    if (field === "set_mpoo_price") return r.get_payment_config?.mpoo_per_credit;
    if (field === "set_team_account") return r.get_revenue_state?.team_account;
    if (field === "set_buyback_account") return r.get_revenue_state?.buyback_account;
    if (field === "set_staking_contract") return r.get_revenue_state?.staking_contract;
    if (field === "first_fill_complete") return r.get_happy_hour?.first_fill_complete;
    return t()?.[field];
  }
  function timing(field: string): { label: string; until?: bigint } {
    const tun=t();
    if (!tun) return { label: "Unavailable" };
    let until=0n;
    if (field === "set_near_price" || /^repaint_.*_credits$/.test(field)) until=cooldownUntil(tun.last_near_price_change_ns,tun.near_price_cooldown_ns);
    else if (field === "set_mpoo_price") until=cooldownUntil(tun.last_mpoo_price_change_ns,tun.mpoo_price_cooldown_ns);
    else if (field.startsWith("happy_hour_") && field !== "happy_hour_requires_purchase") until=cooldownUntil(tun.last_happy_hour_change_ns,DAY_NS);
    else if (field === "set_team_account" || field === "set_buyback_account") return { label: "7-day cooldown · verified by contract" };
    else if (field === "set_staking_contract") return { label: valueFor(field) ? "Already set · fixed" : "Once only" };
    const clock=countdown(until,deps.now());
    return { label: clock.due ? "Ready now" : `Ready in ${clock.label}`, until };
  }
  function canEdit(field: string): boolean {
    return owner() && !!t() && valueFor(field) !== undefined && (EDITABLE_TUNABLES.has(field)
      || ["set_paused","set_near_price","set_mpoo_price","set_team_account","set_buyback_account","set_staking_contract"].includes(field))
      && !(field === "set_staking_contract" && valueFor(field));
  }
  function renderStatus(): void {
    $("status").replaceChildren();
    if (!snapshot) return;
    const r=snapshot.records;
    const h=r.get_happy_hour, sales=r.get_mpoo_sales_today, rev=r.get_revenue_state;
    const next = rev?.next_near_distribution_ns;
    const statuses: Array<[string,string]> = [
      ["Painting & buying", t()?.paused === true ? "Paused" : t()?.paused === false ? "Live" : "Unavailable"],
      ["First board", h?.first_fill_complete === true ? "Full" : h?.first_fill_complete === false ? "Still filling" : "Unavailable"],
      ["Happy hour", h ? h.open ? "Open" : h.enabled ? `Next ${new Date(Number(units(h.window_start_ns)/1000000n)).toLocaleString()}` : "Off" : "Unavailable"],
      ["mPOO sales", sales ? units(sales.cap) === 0n ? "Closed" : `${sales.remaining} credits left today` : "Unavailable"],
      ["Next NEAR split", next === undefined ? "Unavailable" : countdown(units(next),deps.now()).due ? "Ready now" : countdown(units(next),deps.now()).label],
    ];
    for (const [label,value] of statuses) {
      const card=element("div","","admin-stat"); card.dataset.tone=value === "Paused" ? "paused" : value === "Live" || value === "Open" || value === "Ready now" ? "active" : "quiet";
      card.append(element("span",label),element("strong",value)); $("status").append(card);
    }
  }
  function renderGroups(): void {
    $("groups").replaceChildren();
    if (!snapshot) return;
    for (const group of ADMIN_GROUPS) {
      const items=group.items.filter(item => filter === "all" || item.how === filter);
      if (!items.length) continue;
      const section=element("section","","admin-group"); section.id=`admin-${group.id}`;
      section.append(element("h3",group.title),element("p",group.blurb,"admin-muted"));
      for (const item of items) {
        const field=fieldOf(item), value=valueFor(field);
        const row=element("article","","admin-row"); row.dataset.field=field;
        const name=element("div","","admin-name"); name.append(element("h4",item.name),element("p",item.what));
        const values=element("div","","admin-values");
        values.append(element("span",group.id === "fixed" ? "Rule in this revision" : "Live value","admin-label"));
        let current=display(field,value);
        if (field === "get_mpoo_sales_today()") current=snapshot.records.get_mpoo_sales_today ? `${snapshot.records.get_mpoo_sales_today.sold_today} sold today` : "Unavailable";
        if (field === "get_revenue_state()") {
          const rev=snapshot.records.get_revenue_state;
          current=rev ? `${plainAmount(rev.withdrawable_near,24)} NEAR · ${plainAmount(rev.mpoo_undistributed,18)} mPOO waiting · ${plainAmount(rev.mpoo_staker_reserve,18)} mPOO locked for stakers` : "Unavailable";
        }
        if (field === "quota_base · quota_per_cell · quota_max") current=t() ? `${t()!.quota_base} + ${t()!.quota_per_cell} per cell, capped at ${t()!.quota_max}` : "Unavailable";
        if (group.id === "fixed") {
          current=item.launch;
          if (field === "REGISTRATION") current=display("registration_fee",snapshot.records.get_payment_config?.registration_fee);
          if (field === "STORAGE_PER_PIXEL") current="0.000664 NEAR · estimate; rehearsal still pending";
          if (field === "WIDTH · HEIGHT · MAX_DRAW_BATCH") current=snapshot.records.get_board ? `${snapshot.records.get_board.width} × ${snapshot.records.get_board.height} cells · 64 per stroke` : "Unavailable";
          if (field === "BURN_ACCOUNT") current=String(snapshot.records.get_revenue_state?.burn_account ?? "Unavailable");
        }
        const val=element("strong",current,"admin-value"); if(value !== undefined) val.title=String(value); values.append(val);
        let range=item.range;
        if (field === "set_near_price" || field === "set_mpoo_price") {
          if(value !== undefined) range=`${display(field,((units(value)+1n)/2n).toString())} – ${display(field,(units(value)*2n).toString())}`;
        }
        values.append(element("span",`Limits: ${range}`,"admin-muted"));
        const controls=element("div","","admin-controls");
        const status=group.id === "fixed" ? "Fixed · upgrade only" : group.id === "toilet" || field === "set_toilet_paused" ? "TOILET · read only" : item.how === "read" ? "Read only" : timing(field).label;
        const pill=element("span",status,"admin-pill"); pill.dataset.clock=field; controls.append(pill,element("p",item.rule,"admin-muted"));
        if(field === "set_paused") controls.append(element("p","Pausing stops painting and buying. Reading and revenue distributions continue.","admin-muted"));
        if (field === "set_team_account" || field === "set_buyback_account") controls.append(element("p","This view does not expose the last account change. The contract checks the seven-day wait when you submit.","admin-muted"));
        if (canEdit(field)) {
          const edit=button("Edit",()=>openEditor(item)); edit.dataset.edit=field; controls.append(edit);
          if (field === "set_paused" && value === false) controls.append(button("Pause painting & buying now",()=>void immediate(item,true)));
          if (field === "happy_hour_enabled" && value === true) controls.append(button("Turn happy hour off now",()=>void immediate(item,false)));
        }
        row.append(name,values,controls); section.append(row);
      }
      $("groups").append(section);
    }
  }
  function clearEditor(): void { draft=null; $("editor").replaceChildren(); }
  function openEditor(item: AdminSetting): void {
    if (!canEdit(fieldOf(item))) return;
    const field=fieldOf(item), value=valueFor(field) ?? "";
    draft={ item,field,baseline:{...t()!},value,original:value,confirmed:false };
    renderEditor();
    $("editor").scrollIntoView?.({block:"nearest"});
    $("editor").querySelector<HTMLElement>("input,select")?.focus();
  }
  function renderEditor(): void {
    const host=$("editor"); host.replaceChildren();
    if(!draft) return;
    const d=draft;
    const form=element("section","","admin-editor"); form.setAttribute("aria-label",`Edit ${d.item.name}`);
    const heading=element("h3",`Edit ${d.item.name}`);
    const label=element("label",`New value${typeof d.value === "boolean" ? "" : ` (${editUnit(d.field)})`}`);
    const input=typeof d.value === "boolean" ? document.createElement("select") : document.createElement("input");
    input.id="admin-new-value"; label.htmlFor=input.id;
    if(input instanceof HTMLSelectElement) {
      for(const [v,text] of [["true","On"],["false","Off"]]) { const option=element("option",text); option.value=v; input.append(option); }
      input.value=String(d.value);
    } else {
      input.type="text"; input.autocomplete="off";
      const places=decimals(d.field);
      input.value=places === null ? String(d.value) : plainAmount(d.value,places);
      if (!d.field.includes("account") && d.field !== "set_staking_contract") input.inputMode="decimal";
    }
    input.disabled=busy;
    const feedback=element("p","","admin-feedback"); feedback.setAttribute("role","status");
    const preview=element("p","","admin-preview"); preview.dataset.admin="preview";
    const confirm=button("Confirm in owner wallet",()=>void submit()); confirm.dataset.adminAction="confirm"; confirm.hidden=true;
    const readInput=(): ChainValue => {
      if(input instanceof HTMLSelectElement) return input.value === "true";
      const raw=input.value.trim();
      if(d.field.includes("account") || d.field === "set_staking_contract") return raw;
      const places=decimals(d.field);
      return (places === null ? units(raw) : decimalUnits(raw,places)).toString();
    };
    const previewButton=button("Preview change",()=>{
      try {
        d.value=readInput(); validateDraft(d,d.baseline,snapshot!);
        d.confirmed=true;
        preview.textContent=`${d.item.name}: ${display(d.field,d.original)} → ${display(d.field,d.value)}. ${effect(d.field,d.value)} Your wallet attaches 1 yoctoNEAR; network gas also applies.`;
        feedback.textContent=""; confirm.hidden=false;
      } catch(error) { feedback.textContent=message(error); confirm.hidden=true; d.confirmed=false; }
    }); previewButton.dataset.adminAction="preview";
    input.addEventListener("input",()=>{ d.confirmed=false; confirm.hidden=true; preview.textContent=""; });
    input.addEventListener("change",()=>{ d.confirmed=false; confirm.hidden=true; preview.textContent=""; });
    form.append(heading,label,input,element("p",d.item.rule,"admin-muted"));
    if(d.field === "set_mpoo_price") {
      const helperLabel=element("label","7-day average pool rate (mPOO per 1 NEAR)");
      const helper=element("input",""); helper.id="admin-pool-average"; helper.type="text"; helper.inputMode="decimal"; helperLabel.htmlFor=helper.id;
      const use=button("Calculate 20% holder discount",()=>{
        try {
          const near=snapshot?.records.get_payment_config?.near_per_credit;
          if(typeof near !== "string") throw new Error("NEAR price unavailable");
          const atomic=discountedMpooPrice(helper.value.trim(),near);
          input.value=plainAmount(atomic,18); input.dispatchEvent(new Event("input"));
          feedback.textContent="Calculated from the average you entered. Preview before signing.";
        } catch(error) { feedback.textContent=message(error); }
      }); form.append(helperLabel,helper,use);
    }
    form.append(feedback,previewButton,preview,confirm,button("Cancel",clearEditor)); host.append(form);
  }
  function effect(field: string, value: ChainValue): string {
    if(field === "set_paused") return value ? "Painting and buying stop; reading and distributions continue." : "Painting and buying resume.";
    if(/^repaint_.*_credits$/.test(field)) return "Counts as a NEAR price change and restarts its cooldown.";
    if(field === "set_staking_contract") return "This account can be set only once. It cannot be changed later.";
    return draft?.item.rule ?? "Takes effect when confirmed on chain.";
  }
  function validateDraft(d: NonNullable<typeof draft>, tun: ChainRecord, snap: AdminSnapshot): void {
    if(EDITABLE_TUNABLES.has(d.field)) {
      const value=typeof tun[d.field] === "boolean" ? d.value : typeof tun[d.field] === "string" ? String(d.value) : units(d.value);
      validateTunables({...tun,[d.field]:value},tun,units(snap.records.get_outstanding_credits?.value),deps.now());
    } else if(d.field === "set_near_price" || d.field === "set_mpoo_price") {
      const asset=d.field === "set_near_price" ? "near" : "mpoo";
      priceChange(asset,String(snap.records.get_payment_config?.[`${asset}_per_credit`]),String(d.value),tun,deps.now());
    } else if(d.field !== "set_paused") {
      if(typeof d.value !== "string" || !ACCOUNT_ID.test(d.value) || d.value === deps.board) throw new Error("InvalidRevenueAccount");
      if(d.field === "set_staking_contract" && snap.records.get_revenue_state?.staking_contract) throw new Error("StakingContractAlreadySet");
    }
  }
  function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  async function immediate(item: AdminSetting,value: boolean): Promise<void> {
    if(!canEdit(fieldOf(item))) return;
    draft={item,field:fieldOf(item),baseline:{...t()!},value,original:valueFor(fieldOf(item)) ?? false,confirmed:true};
    await submit();
  }
  async function submit(): Promise<void> {
    if(!draft?.confirmed || !owner() || busy) return;
    const d=draft, expectedOwner=snapshot!.owner!;
    busy=true; renderGroups(); renderEditor(); $("result").textContent="Checking the latest board settings…";
    try {
      let currentOwner: unknown;
      try { currentOwner=await deps.view(deps.board,"get_owner"); }
      catch(error) { if(!isMethodNotFound(error) || !snapshot?.ownerFromConfig) throw error; currentOwner=expectedOwner; }
      if(currentOwner !== expectedOwner) throw new Error("OwnerChanged: reload the board settings");
      let args: Record<string,unknown>;
      if(EDITABLE_TUNABLES.has(d.field)) {
        const outstanding=units(await deps.view(deps.board,"get_outstanding_credits"));
        args=await prepareTunableChange(deps.view,deps.board,d.baseline,d.field,
          typeof d.value === "boolean" ? d.value : String(d.value),outstanding,deps.now());
      } else {
        const fresh=record(await deps.view(deps.board,"get_tunables"));
        if(changedFields(d.baseline,fresh).length) throw new Error("SettingsChanged: reload and review your edit");
        if(d.field === "set_paused") args={paused:d.value};
        else if(d.field === "set_near_price" || d.field === "set_mpoo_price") {
          const config=record(await deps.view(deps.board,"get_payment_config"));
          const asset=d.field === "set_near_price" ? "near" : "mpoo";
          if(stringifyChainJson(config[`${asset}_per_credit`]) !== stringifyChainJson(d.original)) throw new Error("PriceChanged: reload and review your edit");
          args=priceChange(asset,String(config[`${asset}_per_credit`]),String(d.value),fresh,deps.now());
        } else {
          const revenue=record(await deps.view(deps.board,"get_revenue_state"));
          const key=d.field.replace("set_", "");
          if(stringifyChainJson(revenue[key] ?? null) !== stringifyChainJson(d.original)) throw new Error("RevenueAccountChanged: reload and review your edit");
          validateDraft(d,fresh,{...snapshot!,records:{...snapshot!.records,get_revenue_state:revenue}});
          args={account_id:d.value};
        }
      }
      // Re-check identity after asynchronous reads, including a disconnect mid-flight.
      if(disposed || !owner() || session().accountId !== expectedOwner || draft !== d) throw new Error("OwnerWalletRequired");
      $("result").textContent="Confirm or cancel the change in your wallet.";
      const outcome=parseTxOutcome(await deps.sign({contractId:deps.board,owner:expectedOwner,
        methodName:(EDITABLE_TUNABLES.has(d.field) ? "set_tunables" : d.field) as Parameters<typeof signAndSendAdminChange>[0]["methodName"],args}));
      if(disposed) return;
      $("result").textContent=outcome.status === "success" ? "Confirmed. Reading the board again…" : outcome.status === "failed"
        ? `The board refused: ${outcome.failureMessage ?? "unknown reason"}` : "Submitted; confirmation is unknown. Check the transaction before making another change.";
      const link=explorerUrl(deps.network as Parameters<typeof explorerUrl>[0],outcome.transactionHash);
      if(link) { const a=element("a"," View transaction ↗"); a.href=link; a.target="_blank"; a.rel="noopener noreferrer"; $("result").append(a); }
      clearEditor();
      await refresh(true);
      if(!disposed && outcome.status === "success" && $("result").firstChild) {
        $("result").firstChild!.textContent=snapshot?.records.get_tunables
          ? "Confirmed. Settings refreshed from the board. " : "Confirmed. The latest settings could not be read; use Refresh to try again. ";
      }
      await refreshHistory();
    } catch(error) {
      if(!disposed) $("result").textContent=isUserRejection(error) ? "Cancelled in wallet." : message(error);
    } finally { busy=false; if(!disposed) { renderGroups(); renderEditor(); } }
  }
  async function refresh(force = false): Promise<void> {
    if((refreshing && !force) || disposed || !deps.configured) return;
    refreshing=true; const current=++generation;
    try {
      const next=await deps.load();
      if(disposed || current !== generation) return;
      snapshot=next;
      $("source").textContent=`Live from ${deps.board} · ${deps.network} · read ${new Date(deps.now()).toLocaleTimeString()}`;
      $("notice").textContent=next.ownerFromConfig ? `Owner: ${next.owner} (configured account; contract owner view not available).` : next.owner ? `Owner: ${next.owner}. Connect that wallet on ${deps.network} to edit.` : "Owner could not be verified. Settings are read-only.";
      const failures=Object.keys(next.errors).filter(key=>key !== "get_owner");
      if(failures.length) $("notice").textContent+=` ${failures.length} board reads unavailable; those values are not shown as zero.`;
    } catch(error) {
      if(disposed || current !== generation) return;
      snapshot=null; clearEditor();
      $("source").textContent=`Live settings unavailable for ${deps.board} on ${deps.network}.`;
      $("notice").textContent=`Could not read the board: ${message(error)}. Refresh to try again.`;
    } finally { if(current === generation) refreshing=false; if(!disposed && current === generation) { if(!owner()) clearEditor(); renderStatus(); renderGroups(); } }
  }
  async function refreshHistory(): Promise<void> {
    if(!deps.configured) return;
    try {
      const entries=await deps.history(); if(disposed) return;
      history=entries; $("history-note").textContent=entries.length ? "Indexed transactions; tunables entries are listed by method, whether or not a settings event exists." : "No recent owner changes returned by the indexer.";
      $("history").replaceChildren();
      for(const entry of entries) {
        const li=element("li",`${entry.method.replaceAll("_"," ")} · ${new Date(Number(entry.timestampNs/1000000n)).toLocaleString()} · ${entry.succeeded === true ? "confirmed" : entry.succeeded === false ? "failed" : "outcome unknown"} `);
        const href=explorerUrl(deps.network as Parameters<typeof explorerUrl>[0],entry.hash);
        if(href) { const a=element("a","View transaction ↗"); a.href=href; a.target="_blank"; a.rel="noopener noreferrer"; li.append(a); }
        $("history").append(li);
      }
    } catch { if(!disposed) { history=null; $("history").replaceChildren(); $("history-note").textContent="Change history unavailable from the indexer. This does not change the live settings above."; } }
  }
  const filters: Array<[string,string]>=[["all","All settings"],["now","Any time"],["wait","Cooldown"],["read","Read only"],["later","TOILET"],["fixed","Fixed rules"]];
  for(const [id,label] of filters) {
    const b=button(label,()=>{filter=id; for(const child of $("filters").querySelectorAll("button")) child.setAttribute("aria-pressed",String(child === b)); renderGroups();});
    b.setAttribute("aria-pressed",String(id === filter)); $("filters").append(b);
  }
  const onRefresh=()=>void refresh(); page.querySelector('[data-admin-action="refresh"]')!.addEventListener("click",onRefresh);
  const unsub=ctx.services.wallet.subscribe(()=>{ if(!owner()) clearEditor(); renderGroups(); });
  const onVisible=()=>{ if(document.visibilityState !== "hidden") { void refresh(); void refreshHistory(); } };
  const poll=window.setInterval(onVisible,deps.pollMs);
  const tick=window.setInterval(()=>{
    if(document.visibilityState === "hidden" || disposed) return;
    for(const pill of page.querySelectorAll<HTMLElement>("[data-clock]")) {
      const field=pill.dataset.clock!;
      if(EDITABLE_TUNABLES.has(field) || ["set_near_price","set_mpoo_price","set_team_account","set_buyback_account","set_staking_contract","set_paused"].includes(field)) pill.textContent=timing(field).label;
    }
    renderStatus();
  },1000);
  document.addEventListener("visibilitychange",onVisible); window.addEventListener("focus",onVisible);
  $("source").textContent=deps.configured ? `Reading ${deps.board} on ${deps.network}…` : "No board configured. Live settings are unavailable.";
  $("notice").textContent=deps.configured ? "" : "Connect this app to a board to read its settings. No example values are displayed here.";
  void refresh(); void refreshHistory();
  return ()=>{ disposed=true; generation++; draft=null; snapshot=null; history=null; unsub();
    window.clearInterval(poll); window.clearInterval(tick); document.removeEventListener("visibilitychange",onVisible); window.removeEventListener("focus",onVisible); page.remove(); };
}
