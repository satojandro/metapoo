/**
 * /admin — the private owner console (ADM-2).
 *
 * Visitors see one short paragraph and a link to /how-it-works; they never see
 * settings or edit controls, and no board reads run until a wallet is connected.
 * The board's owner, connected on the page network, sees: a status strip, what
 * needs attention, a compact settings table with inline edit, and recent changes.
 *
 * Every change re-reads the owner and the record it changes before signing
 * (admin-submit.ts). The one exception is "Pause now": an RPC outage must never
 * block the emergency stop, so it checks only the connected wallet and network.
 */
import { explorerUrl } from "@shared/board-rules.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import { signAndSendAdminChange } from "../wallet";
import { isUserRejection, parseTxOutcome } from "../tx-outcome";
import type { PageContext, PageDispose } from "./page-registry";
import type { AdminSetting } from "./admin-catalog";
import { renderEditor } from "./admin-editor";
import { fieldOf, isEditable, valueFor } from "./admin-format";
import { loadAdminHistory, type AdminHistoryEntry } from "./admin-history";
import { createAccountBalanceReader, createAdminView, loadAdmin, type AdminSnapshot } from "./admin-settings";
import { attentionItems, statusItems } from "./admin-status";
import { PAUSE_NOW, prepareChange, validateDraft, type Change, type Draft } from "./admin-submit";
import { renderSettings, updatePill } from "./admin-table";
import type { View } from "./revenue-panel";
import "./admin-page.css";

export interface AdminPageDeps {
  load: () => Promise<AdminSnapshot>;
  view: View;
  sign: typeof signAndSendAdminChange;
  history: () => Promise<AdminHistoryEntry[]>;
  /** NEAR balance of an account, in yocto. */
  balance: (account: string) => Promise<bigint>;
  now: () => number;
  network: string;
  board: string;
  configured: boolean;
  pollMs: number;
}

function defaults(): AdminPageDeps {
  const view = createAdminView(RPC_URL);
  return {
    view,
    load: () => loadAdmin(view, CONTRACT_ID, import.meta.env.VITE_BOARD_OWNER?.trim()),
    sign: signAndSendAdminChange,
    history: () => loadAdminHistory(PAGE_NETWORK, CONTRACT_ID),
    balance: createAccountBalanceReader(RPC_URL),
    now: Date.now,
    network: PAGE_NETWORK,
    board: CONTRACT_ID,
    configured: !!CONTRACT_ID,
    pollMs: 60_000,
  };
}

const TEMPLATE = `<article class="admin" aria-labelledby="admin-title">
  <header class="admin-head">
    <div class="admin-head-text">
      <p class="mp-eyebrow" data-admin="eyebrow">Board settings</p>
      <h2 id="admin-title" data-route-heading="true" data-admin="title">This page is for the board's owner.</h2>
      <p class="admin-source" data-admin="source" role="status"></p>
    </div>
    <div class="admin-head-actions" data-admin="actions" hidden>
      <button type="button" class="mp-btn admin-pause" data-admin-action="pause">Pause painting &amp; buying now</button>
      <button type="button" class="mp-btn" data-admin-action="refresh">Refresh</button>
    </div>
  </header>
  <section class="admin-visitor" data-admin="visitor">
    <p>The rules every painter plays by, and what the owner can and can't change, are on
      <a href="/how-it-works">How it works</a>.</p>
  </section>
  <div class="admin-console" data-admin="console" hidden>
    <p class="admin-result" data-admin="result" role="status"></p>
    <ul class="admin-status" data-admin="status" aria-label="Board status"></ul>
    <section class="admin-attention" aria-labelledby="admin-attention-title">
      <h3 id="admin-attention-title">Needs attention</h3>
      <ul data-admin="attention"></ul>
    </section>
    <div data-admin="editor"></div>
    <div class="admin-settings" data-admin="groups"></div>
    <section class="admin-history" aria-labelledby="admin-history-title">
      <h3 id="admin-history-title">Recent owner changes</h3>
      <p class="admin-muted" data-admin="history-note" role="status"></p>
      <ol data-admin="history"></ol>
    </section>
  </div>
</article>`;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function mountAdminPage(root: HTMLElement, ctx: PageContext, overrides: Partial<AdminPageDeps> = {}): PageDispose {
  const deps = { ...defaults(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".admin")!;
  const $ = (key: string): HTMLElement => page.querySelector<HTMLElement>(`[data-admin="${key}"]`)!;
  const pauseButton = page.querySelector<HTMLButtonElement>('[data-admin-action="pause"]')!;
  /** The editor lives in a row under the setting being edited; its home is above the table. */
  const editorHost = $("editor");
  const editorHome = editorHost.parentElement!;
  const groupsHost = $("groups");
  const refreshButton = page.querySelector<HTMLButtonElement>('[data-admin-action="refresh"]')!;

  // Not for search engines: the console is reachable by direct link only.
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  robots.dataset.admin = "noindex";
  document.head.append(robots);

  let snapshot: AdminSnapshot | null = null;
  /** The last owner the board reported. Kept through a failed refresh so Pause still works. */
  let knownOwner: string | null = null;
  let buyback: bigint | null | undefined = undefined;
  let draft: Draft | null = null;
  let disposed = false, busy = false, refreshing = false, generation = 0;
  let historyRequested = false;

  const session = () => ctx.services.wallet.getSession();
  const isOwner = (): boolean => deps.configured && !!knownOwner
    && session().accountId === knownOwner && session().networkId === deps.network;
  const tunables = () => snapshot?.records.get_tunables;

  function canEdit(field: string): boolean {
    if (!isOwner() || !snapshot || !tunables() || !isEditable(field)) return false;
    const value = valueFor(snapshot, field);
    if (value === undefined) return false;
    return !(field === "set_staking_contract" && value);
  }

  function placeEditor(): void {
    page.querySelectorAll(".admin-edit-row").forEach(row => { if (!row.contains(editorHost) || !draft) row.remove(); });
    const row = draft ? page.querySelector<HTMLTableRowElement>(`tr[data-field="${draft.field}"]`) : null;
    if (!row) { if (editorHost.parentElement !== editorHome) editorHome.insertBefore(editorHost, groupsHost); return; }
    let slot = row.nextElementSibling;
    if (!slot?.classList.contains("admin-edit-row")) {
      slot = document.createElement("tr");
      slot.className = "admin-edit-row";
      const cell = document.createElement("td");
      cell.colSpan = 4;
      slot.append(cell);
      row.after(slot);
    }
    slot.firstElementChild!.append(editorHost);
  }

  function clearEditor(): void { draft = null; editorHost.replaceChildren(); placeEditor(); }

  function renderStatus(): void {
    const status = $("status");
    status.replaceChildren();
    if (!snapshot) return;
    for (const item of statusItems({ snapshot, nowMs: deps.now(), buybackYocto: buyback })) {
      const li = document.createElement("li");
      li.className = "admin-stat";
      li.dataset.tone = item.tone;
      li.dataset.status = item.id;
      const label = document.createElement("span"); label.textContent = item.label;
      const value = document.createElement("strong"); value.textContent = item.value;
      li.append(label, value);
      status.append(li);
    }
  }

  function renderAttention(): void {
    const list = $("attention");
    list.replaceChildren();
    const items = snapshot ? attentionItems({ snapshot, nowMs: deps.now(), buybackYocto: buyback }) : [];
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "admin-attention-none";
      li.textContent = snapshot ? "Nothing needs you right now." : "Live settings unavailable, so nothing can be checked.";
      list.append(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      li.dataset.tone = item.tone;
      li.dataset.attention = item.id;
      li.textContent = item.text;
      list.append(li);
    }
  }

  function renderTable(): void {
    if (!snapshot) { groupsHost.replaceChildren(); return; }
    // Keep the editor (and what's typed in it) out of the table while it's rebuilt.
    if (editorHost.parentElement !== editorHome) editorHome.insertBefore(editorHost, groupsHost);
    renderSettings(groupsHost, snapshot, { nowMs: deps.now, canEdit, busy: () => busy, onEdit: openEditor });
  }

  function render(): void {
    const owner = isOwner();
    $("visitor").hidden = owner;
    $("console").hidden = !owner;
    $("actions").hidden = !owner;
    $("eyebrow").textContent = owner ? "Owner console" : "Board settings";
    $("title").textContent = owner ? "Board settings" : "This page is for the board's owner.";
    if (!owner) {
      clearEditor();
      $("source").textContent = "";
      return;
    }
    pauseButton.hidden = tunables()?.paused === true;
    pauseButton.disabled = busy;
    refreshButton.disabled = busy;
    renderStatus();
    renderAttention();
    renderTable();
    placeEditor();
  }

  /** Redraw the open editor after `busy` changes, keeping the draft. */
  function redrawEditor(): void { if (draft && isOwner()) openEditor(draft.item, draft); }

  function openEditor(item: AdminSetting, existing?: Draft): void {
    const field = fieldOf(item);
    if (!canEdit(field)) return;
    const value = valueFor(snapshot, field) ?? "";
    draft = existing ?? { item, field, baseline: { ...tunables()! }, value, original: value };
    const focus = renderEditor(editorHost, draft, {
      busy: () => busy,
      validate: d => validateDraft(d, d.baseline, snapshot!, deps.now(), deps.board),
      onConfirm: d => void submit(d),
      onCancel: clearEditor,
      nearPrice: () => snapshot?.records.get_payment_config?.near_per_credit,
    });
    placeEditor();
    if (!existing) { editorHost.scrollIntoView?.({ block: "nearest" }); focus(); }
  }

  async function refresh(force = false): Promise<void> {
    if ((refreshing && !force) || disposed || !deps.configured) return;
    // Visitors trigger no reads: nothing loads until a wallet is connected.
    if (!session().accountId) { render(); return; }
    refreshing = true;
    const current = ++generation;
    try {
      const next = await deps.load();
      if (disposed || current !== generation) return;
      snapshot = next;
      if (next.owner) knownOwner = next.owner;
      $("source").textContent = `Live from ${deps.board} · ${deps.network} · read ${new Date(deps.now()).toLocaleTimeString()}`;
      const buybackAccount = next.records.get_revenue_state?.buyback_account;
      if (typeof buybackAccount === "string") {
        try { buyback = await deps.balance(buybackAccount); } catch { buyback = null; }
        if (disposed || current !== generation) return;
      } else buyback = null;
    } catch (error) {
      if (disposed || current !== generation) return;
      snapshot = null;
      clearEditor();
      $("source").textContent = `Live settings unavailable for ${deps.board} on ${deps.network}: ${message(error)}. Refresh to try again.`;
    } finally {
      if (current === generation) refreshing = false;
      if (!disposed && current === generation) {
        render();
        if (isOwner() && !historyRequested) void refreshHistory();
      }
    }
  }

  async function refreshHistory(): Promise<void> {
    historyRequested = true;
    try {
      const entries = await deps.history();
      if (disposed) return;
      $("history-note").textContent = entries.length ? "Owner transactions on this board, newest first." : "No recent owner changes.";
      $("history").replaceChildren();
      for (const entry of entries) {
        const when = new Date(Number(entry.timestampNs / 1_000_000n)).toLocaleString();
        const outcome = entry.succeeded === true ? "confirmed" : entry.succeeded === false ? "failed" : "outcome unknown";
        const li = document.createElement("li");
        li.textContent = `${entry.method.replaceAll("_", " ")} · ${when} · ${outcome} `;
        const href = explorerUrl(deps.network as Parameters<typeof explorerUrl>[0], entry.hash);
        if (href) {
          const a = document.createElement("a");
          a.textContent = "View ↗"; a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
          li.append(a);
        }
        $("history").append(li);
      }
    } catch {
      if (disposed) return;
      $("history").replaceChildren();
      $("history-note").textContent = "Change history unavailable from the indexer. The live settings above are unaffected.";
    }
  }

  async function signChange(change: Change, owner: string): Promise<void> {
    $("result").textContent = "Confirm or cancel the change in your wallet.";
    const outcome = parseTxOutcome(await deps.sign({ contractId: deps.board, owner, methodName: change.methodName, args: change.args }));
    if (disposed) return;
    $("result").textContent = outcome.status === "success" ? "Confirmed. Reading the board again…"
      : outcome.status === "failed" ? `The board refused: ${outcome.failureMessage ?? "unknown reason"}`
      : "Submitted; confirmation is unknown. Check the transaction before making another change.";
    const link = explorerUrl(deps.network as Parameters<typeof explorerUrl>[0], outcome.transactionHash);
    if (link) {
      const a = document.createElement("a");
      a.textContent = " View transaction ↗"; a.href = link; a.target = "_blank"; a.rel = "noopener noreferrer";
      $("result").append(a);
    }
    clearEditor();
    await refresh(true);
    if (!disposed && outcome.status === "success" && $("result").firstChild) {
      $("result").firstChild!.textContent = snapshot ? "Confirmed. Settings refreshed from the board. " : "Confirmed. The latest settings couldn't be read; use Refresh. ";
    }
    // History is fetched on load and once after each confirmed change, never on a timer.
    if (!disposed && outcome.status !== "failed") await refreshHistory();
  }

  async function submit(d: Draft): Promise<void> {
    if (!isOwner() || busy || !snapshot) return;
    const owner = knownOwner!;
    busy = true; render(); redrawEditor();
    $("result").textContent = "Checking the latest board settings…";
    try {
      const change = await prepareChange(deps.view, deps.board, d, snapshot, deps.now());
      // Re-check identity after the reads: the wallet may have disconnected mid-flight.
      if (disposed || !isOwner() || session().accountId !== owner || draft !== d) throw new Error("OwnerWalletRequired");
      await signChange(change, owner);
    } catch (error) {
      if (!disposed) $("result").textContent = isUserRejection(error) ? "Cancelled in wallet." : message(error);
    } finally {
      busy = false;
      if (!disposed) { render(); redrawEditor(); }
    }
  }

  async function pauseNow(): Promise<void> {
    if (!isOwner() || busy) return;
    const owner = knownOwner!;
    busy = true; render();
    try {
      await signChange(PAUSE_NOW, owner);
    } catch (error) {
      if (!disposed) $("result").textContent = isUserRejection(error) ? "Cancelled in wallet." : message(error);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  pauseButton.addEventListener("click", () => void pauseNow());
  const onRefresh = () => void refresh();
  refreshButton.addEventListener("click", onRefresh);
  const unsubscribe = ctx.services.wallet.subscribe(() => {
    if (!isOwner()) clearEditor();
    if (session().accountId && !snapshot && !refreshing) void refresh();
    else render();
  });
  const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
  const poll = window.setInterval(onVisible, deps.pollMs);
  const tick = window.setInterval(() => {
    if (document.visibilityState === "hidden" || disposed || !isOwner() || !snapshot) return;
    renderStatus();
    for (const pill of page.querySelectorAll<HTMLElement>("[data-clock]")) updatePill(pill, snapshot, pill.dataset.clock!, deps.now());
  }, 1000);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);

  if (!deps.configured) $("source").textContent = "No board configured.";
  render();
  void refresh();

  return () => {
    disposed = true; generation++; draft = null; snapshot = null;
    unsubscribe();
    window.clearInterval(poll); window.clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    robots.remove();
    page.remove();
  };
}
