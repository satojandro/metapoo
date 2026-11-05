/**
 * /money — "Where the money goes". Public, read-mostly page over `get_revenue_state`.
 *
 * States: example (no board configured, labelled), loading, live, not-yet (an old board
 * without the revenue views — normal, not an error), and unavailable (a failed read is
 * never shown as zero).
 */

import { explorerUrl } from "@shared/board-rules.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import { isContractConfigured } from "../contract";
import { isUserRejection, parseTxOutcome } from "../tx-outcome";
import { signAndSendDistribution } from "../wallet";
import { createAccountBalanceReader } from "./admin-settings";
import {
  createBoardTotalsSource,
  createFastNearLedgerSource,
  createIndexedLedgerSource,
  createPreferredLedgerSource,
  exampleLedger,
  loadBuybackLedger,
  type LedgerSnapshot,
  type LedgerSource,
} from "./buyback-ledger";
import type { PageContext, PageDispose } from "./page-registry";
import { REVENUE_FLOW_SVG } from "./revenue-flow-svg";
import {
  accountExplorerUrl,
  countdown,
  createRpcView,
  distributeButtonState,
  DISTRIBUTE_MPOO_GAS,
  DISTRIBUTE_NEAR_GAS,
  exampleSnapshot,
  formatAmount,
  formatExact,
  isDistributionTooSoon,
  loadRevenue,
  maxGasCostYocto,
  MPOO_DECIMALS,
  NEAR_DECIMALS,
  splitMpoo,
  splitNear,
  type DistributionKind,
  type RevenueSnapshot,
} from "./revenue-panel";
import "./revenue-panel.css";

export interface RevenuePageDeps {
  load: () => Promise<RevenueSnapshot>;
  sign: typeof signAndSendDistribution;
  now: () => number;
  network: string;
  contractId: string;
  /** No board configured: show labelled example numbers and never sign. */
  example: boolean;
  /** How often live numbers are re-read. */
  pollMs: number;
  /** Buyback ledger for the board's current revenue state (events + NEAR waiting). */
  loadLedger: (snapshot: Extract<RevenueSnapshot, { kind: "live" }>) => Promise<LedgerSnapshot>;
  /**
   * How often the ledger is re-read while it comes from the public index (far less often
   * than `pollMs`). The board's own totals are re-read with every `pollMs` poll.
   */
  ledgerPollMs: number;
}

function defaultDeps(): RevenuePageDeps {
  const example = !isContractConfigured();
  return {
    load: example
      ? async () => exampleSnapshot(Date.now())
      : () => loadRevenue(createRpcView(RPC_URL), CONTRACT_ID),
    sign: signAndSendDistribution,
    now: () => Date.now(),
    network: PAGE_NETWORK,
    contractId: CONTRACT_ID,
    example,
    pollMs: 30_000,
    loadLedger: example
      ? async snapshot => exampleLedger(snapshot.state.buybackAccount)
      : defaultLedgerLoader(),
    ledgerPollMs: 300_000,
  };
}

/**
 * The board's `get_buyback_totals` first; the public index only for a board without it.
 * One source per mPOO token, so index transactions already read stay cached between polls.
 */
function defaultLedgerLoader(): RevenuePageDeps["loadLedger"] {
  const readBalance = createAccountBalanceReader(RPC_URL);
  const board = createBoardTotalsSource(createRpcView(RPC_URL), CONTRACT_ID);
  let source: LedgerSource | null = null;
  let sourceToken: string | null | undefined;
  return snapshot => {
    if (!source || sourceToken !== snapshot.mpooToken) {
      sourceToken = snapshot.mpooToken;
      source = createPreferredLedgerSource(
        board,
        // FastNEAR's index first: one paged listing plus 20-transaction log batches, no key
        // needed. NearBlocks stays as the fallback for a network FastNEAR does not index.
        createFastNearLedgerSource({ network: PAGE_NETWORK, board: CONTRACT_ID })
          ?? createIndexedLedgerSource({ network: PAGE_NETWORK, board: CONTRACT_ID, mpooToken: snapshot.mpooToken }),
      );
    }
    return loadBuybackLedger(source, readBalance, snapshot.state.buybackAccount);
  };
}

const nearCap = formatAmount(maxGasCostYocto(DISTRIBUTE_NEAR_GAS), NEAR_DECIMALS);
const mpooCap = formatAmount(maxGasCostYocto(DISTRIBUTE_MPOO_GAS), NEAR_DECIMALS);
const tgas = (gas: string): string => (BigInt(gas) / 1_000_000_000_000n).toString();

const TEMPLATE = `
<article class="rev" aria-labelledby="rev-title">
  <header class="rev-head">
    <p class="rev-eyebrow">Where the money goes</p>
    <h2 id="rev-title" data-route-heading="true">Every coin paid for paint leaves through a fixed split.</h2>
    <p class="rev-lede">Painting costs credits, and credits are bought with NEAR or mPOO. The board can’t keep that money or pay it to one person: it can only send it out along the lines below, and anyone can press send.</p>
    <p class="rev-source" data-rev="source" role="status"></p>
  </header>

  <div class="rev-notice" data-rev="notice" hidden></div>

  <figure class="rev-flow">
    ${REVENUE_FLOW_SVG}
    <figcaption><b>NEAR</b> splits 10% to the team and 90% to the buyback, which turns it into mPOO. <b>mPOO</b> — bought back or paid for credits directly — splits 10% team, 70% TOILET stakers, 20% burned.</figcaption>
  </figure>

  <div class="rev-live" data-rev="live">
    <div class="rev-flows">
      <section class="rev-card rev-card-near" aria-labelledby="rev-near-h">
        <h3 id="rev-near-h">NEAR from credit sales</h3>
        <p class="rev-figure"><span data-rev="near-waiting">…</span> <span class="rev-unit">NEAR</span></p>
        <p class="rev-explain">Waiting on the board since the last split. The NEAR the board keeps to pay for its own storage is not counted.</p>
        <dl class="rev-split">
          <div><dt><span class="rev-pct">10%</span> to the team</dt><dd data-rev="near-team">…</dd></div>
          <div><dt><span class="rev-pct">90%</span> to the buyback</dt><dd data-rev="near-buyback">…</dd></div>
        </dl>
        <p class="rev-explain rev-small">What the next split would send. The board splits in whole yocto; figures here are cut, never rounded up, at 6 decimals. The buyback account swaps its NEAR for mPOO on the market and sends the mPOO back here, where it joins the mPOO split.</p>
        <div class="rev-next"><span>Next split</span><strong data-rev="near-next">…</strong></div>
        <button type="button" class="action rev-send" data-distribute="near">Distribute now</button>
        <p class="rev-hint" data-rev="near-hint"></p>
        <p class="rev-result" data-rev="near-result" role="status"></p>
      </section>

      <section class="rev-card rev-card-mpoo" aria-labelledby="rev-mpoo-h">
        <h3 id="rev-mpoo-h">mPOO from credit sales and buybacks</h3>
        <p class="rev-figure"><span data-rev="mpoo-waiting">…</span> <span class="rev-unit">mPOO</span></p>
        <p class="rev-explain">Waiting on the board: mPOO paid for credits plus mPOO the buyback account sent back.</p>
        <dl class="rev-split">
          <div><dt><span class="rev-pct">10%</span> to the team</dt><dd data-rev="mpoo-team">…</dd></div>
          <div><dt><span class="rev-pct">70%</span> to TOILET stakers</dt><dd data-rev="mpoo-stakers">…</dd></div>
          <div><dt><span class="rev-pct">20%</span> burned</dt><dd data-rev="mpoo-burn">…</dd></div>
        </dl>
        <p class="rev-explain rev-small">Rounding dust stays with the stakers. Burned mPOO goes to an address nobody holds a key for, so it can never be spent.</p>
        <div class="rev-next"><span>Next split</span><strong data-rev="mpoo-next">…</strong></div>
        <button type="button" class="action rev-send" data-distribute="mpoo">Distribute now</button>
        <p class="rev-hint" data-rev="mpoo-hint"></p>
        <p class="rev-result" data-rev="mpoo-result" role="status"></p>
      </section>
    </div>

    <div class="rev-stats">
      <section class="rev-stat" aria-labelledby="rev-reserve-h">
        <h3 id="rev-reserve-h">Stakers’ reserve</h3>
        <p class="rev-figure"><span data-rev="reserve">…</span> <span class="rev-unit">mPOO</span></p>
        <p class="rev-explain" data-rev="reserve-explain"></p>
      </section>
      <section class="rev-stat" aria-labelledby="rev-burned-h">
        <h3 id="rev-burned-h">Burned so far</h3>
        <p class="rev-figure"><span data-rev="burned">…</span> <span class="rev-unit">mPOO</span></p>
        <p class="rev-explain">Everything the burn address holds. It has no key, so nothing sent there moves again. This counts burns from anyone, not only this board.</p>
      </section>
    </div>

    <section class="rev-ledger" aria-labelledby="rev-ledger-h">
      <div class="rev-ledger-head">
        <h3 id="rev-ledger-h">Buyback ledger</h3>
        <p class="rev-explain">The 90% of NEAR that goes to the buyback account is meant to come back as mPOO. Both sides are counted from the board’s own events, so if the buyback stops, the gap shows here.</p>
      </div>
      <div class="rev-ledger-grid">
        <div class="rev-ledger-cell">
          <p class="rev-ledger-label">NEAR sent to the buyback</p>
          <p class="rev-figure"><span data-rev="ledger-near">…</span> <span class="rev-unit">NEAR</span></p>
          <p class="rev-small" data-rev="ledger-near-note"></p>
        </div>
        <div class="rev-ledger-cell">
          <p class="rev-ledger-label">mPOO returned to the board</p>
          <p class="rev-figure"><span data-rev="ledger-mpoo">…</span> <span class="rev-unit">mPOO</span></p>
          <p class="rev-small" data-rev="ledger-mpoo-note"></p>
        </div>
        <div class="rev-ledger-cell">
          <p class="rev-ledger-label">NEAR waiting on the buyback account</p>
          <p class="rev-figure"><span data-rev="ledger-waiting">…</span> <span class="rev-unit">NEAR</span></p>
          <p class="rev-small">Its whole balance: NEAR not yet swapped, plus the little it keeps for gas and storage.</p>
        </div>
      </div>
      <p class="rev-small rev-ledger-account">Buyback account: <span data-rev="ledger-account">…</span></p>
      <p class="rev-small" data-rev="ledger-source"></p>
    </section>

    <section class="rev-accounts" aria-labelledby="rev-acc-h">
      <h3 id="rev-acc-h">The accounts</h3>
      <p class="rev-explain">Set on the board, readable by anyone. Changing the team or buyback account takes the owner a 7-day wait and leaves a public event; the staking contract can be set once.</p>
      <ul data-rev="accounts"></ul>
    </section>
  </div>

  <section class="rev-who" aria-labelledby="rev-who-h">
    <h3 id="rev-who-h">Who presses “Distribute now”?</h3>
    <p>A contract can’t wake itself up, so somebody has to send a transaction. A small keeper script does it every hour. If it stops, nothing is lost: the money waits on the board, and the next split sends all of it.</p>
    <p>Anyone can also send it, from this page or their own script, at most once per interval (one hour at launch). It earns you nothing; it just moves the money along. You attach no NEAR and pay only gas: the NEAR split reserves ${tgas(DISTRIBUTE_NEAR_GAS)} Tgas and the mPOO split ${tgas(DISTRIBUTE_MPOO_GAS)} Tgas (three transfers). At NEAR’s minimum gas price that is at most ${nearCap} and ${mpooCap} NEAR, and unused gas is refunded.</p>
  </section>
</article>`;

function shortAccount(account: string): string {
  return account.length > 32 ? `${account.slice(0, 8)}…${account.slice(-8)}` : account;
}

export function mountRevenuePage(
  root: HTMLElement,
  ctx: PageContext,
  overrides: Partial<RevenuePageDeps> = {},
): PageDispose {
  const deps = { ...defaultDeps(), ...overrides };
  const { services } = ctx;
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".rev")!;
  const $ = (key: string): HTMLElement => page.querySelector<HTMLElement>(`[data-rev="${key}"]`)!;
  const buttons = {
    near: page.querySelector<HTMLButtonElement>('[data-distribute="near"]')!,
    mpoo: page.querySelector<HTMLButtonElement>('[data-distribute="mpoo"]')!,
  };

  let snapshot: RevenueSnapshot | null = null;
  let ledger: LedgerSnapshot | null = null;
  let ledgerLoading = false;
  let ledgerStale = false;
  let ledgerReadAt = -Infinity;
  let failed = false;
  let updatedAt: number | null = null;
  const busy: Record<DistributionKind, boolean> = { near: false, mpoo: false };
  let generation = 0;
  let disposed = false;

  function setAmount(key: string, units: bigint, decimals: number, maxFraction = 4): void {
    const el = $(key);
    el.textContent = formatAmount(units, decimals, { maxFraction });
    el.title = `${formatExact(units, decimals)} exactly`;
  }

  function renderSource(): void {
    const source = $("source");
    if (deps.example) {
      source.textContent = "Example numbers. This preview isn’t connected to a board, so nothing here is real.";
      source.dataset.tone = "example";
      return;
    }
    delete source.dataset.tone;
    if (updatedAt === null && !failed) {
      source.textContent = `Reading ${deps.contractId} on ${deps.network}…`;
      return;
    }
    const when = updatedAt === null ? "" : ` · updated ${new Date(updatedAt).toLocaleTimeString()}`;
    source.textContent = `Read live from ${deps.contractId} on ${deps.network}${when}.`;
  }

  function renderNotice(): void {
    const notice = $("notice");
    const live = $("live");
    notice.replaceChildren();
    if (failed && !snapshot) {
      notice.hidden = false;
      notice.dataset.tone = "bad";
      const p = document.createElement("p");
      p.textContent = "Couldn’t read the board just now. These numbers are unknown, not zero.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "action secondary";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => void refresh());
      notice.append(p, retry);
      live.hidden = true;
      return;
    }
    if (snapshot?.kind === "not-yet") {
      notice.hidden = false;
      notice.dataset.tone = "info";
      const h = document.createElement("h3");
      h.textContent = "Revenue sharing starts with the next board version";
      const p = document.createElement("p");
      p.textContent = `This board (${deps.contractId}) was deployed before the split existed, so there are no live numbers to show yet. Once the board is upgraded, what’s waiting, the countdown and the send button appear here.`;
      notice.append(h, p);
      live.hidden = true;
      return;
    }
    notice.hidden = !failed;
    if (failed) {
      notice.dataset.tone = "bad";
      const p = document.createElement("p");
      p.textContent = "The last refresh failed. Showing the previous reading.";
      notice.append(p);
    }
    live.hidden = !snapshot;
  }

  function renderAccounts(state: Extract<RevenueSnapshot, { kind: "live" }>): void {
    const s = state.state;
    const rows: Array<[string, string | null, string]> = [
      ["Team", s.teamAccount, "Receives 10% of both splits."],
      ["Buyback", s.buybackAccount, "Receives 90% of the NEAR, swaps it for mPOO and sends it back."],
      ["TOILET staking", s.stakingContract, s.stakingContract
        ? "Receives the stakers’ 70% with every mPOO split."
        : "Not set yet. The stakers’ 70% waits in the reserve."],
      ["Burn address", s.burnAccount, "No key exists for it. Burned mPOO sits here forever."],
      ["Board", deps.contractId || null, "Holds payments until a split sends them on."],
      ["mPOO token", state.mpooToken, "Where the burned total is read."],
    ];
    const list = $("accounts");
    list.replaceChildren(
      ...rows.map(([role, account, note]) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "rev-acc-role";
        name.textContent = role;
        const value = document.createElement(account && accountExplorerUrl(deps.network, account) ? "a" : "span");
        value.className = "rev-acc-id";
        if (account) {
          value.textContent = shortAccount(account);
          value.title = account;
          const href = accountExplorerUrl(deps.network, account);
          if (value instanceof HTMLAnchorElement && href) {
            value.href = href;
            value.target = "_blank";
            value.rel = "noopener noreferrer";
            value.setAttribute("aria-label", `${account} on NearBlocks (opens in a new tab)`);
            value.textContent += " ↗";
          }
        } else {
          value.textContent = "not set";
        }
        const desc = document.createElement("span");
        desc.className = "rev-acc-note";
        desc.textContent = note;
        li.append(name, value, desc);
        return li;
      }),
    );
  }

  function renderClock(): void {
    if (snapshot?.kind !== "live") return;
    const s = snapshot.state;
    const session = services.wallet.getSession();
    const flows: Array<[DistributionKind, bigint, bigint]> = [
      ["near", s.nextNearDistributionNs, s.withdrawableNear],
      ["mpoo", s.nextMpooDistributionNs, s.mpooUndistributed],
    ];
    for (const [kind, next, waiting] of flows) {
      const c = countdown(next, deps.now());
      $(`${kind}-next`).textContent = c.due ? "Ready now" : `in ${c.label}`;
      $(`${kind}-next`).dataset.due = String(c.due);
      const state = distributeButtonState({
        due: c.due, waiting, accountId: session.accountId, walletNetwork: session.networkId,
        pageNetwork: deps.network, busy: busy[kind], example: deps.example,
      });
      buttons[kind].disabled = !state.enabled;
      buttons[kind].textContent = state.label;
      $(`${kind}-hint`).textContent = state.hint;
    }
  }

  function render(): void {
    renderSource();
    renderNotice();
    if (snapshot?.kind !== "live") return;
    const s = snapshot.state;
    setAmount("near-waiting", s.withdrawableNear, NEAR_DECIMALS);
    const n = splitNear(s.withdrawableNear);
    setAmount("near-team", n.team, NEAR_DECIMALS, 6);
    setAmount("near-buyback", n.buyback, NEAR_DECIMALS, 6);
    setAmount("mpoo-waiting", s.mpooUndistributed, MPOO_DECIMALS);
    const m = splitMpoo(s.mpooUndistributed);
    setAmount("mpoo-team", m.team, MPOO_DECIMALS, 6);
    setAmount("mpoo-stakers", m.stakers, MPOO_DECIMALS, 6);
    setAmount("mpoo-burn", m.burn, MPOO_DECIMALS, 6);
    setAmount("reserve", s.mpooStakerReserve, MPOO_DECIMALS);
    $("reserve-explain").textContent = s.stakingContract
      ? `The stakers’ 70%, forwarded to ${s.stakingContract} with each mPOO split.`
      : "The stakers’ 70% of every mPOO split, held on the board until the TOILET staking contract exists. Nobody can spend it, the owner included. When staking opens, it’s forwarded with the next split.";
    if (snapshot.burned === null) {
      $("burned").textContent = "Unavailable";
      $("burned").title = "The burn address balance could not be read. Retry later.";
    } else {
      setAmount("burned", snapshot.burned, MPOO_DECIMALS);
    }
    renderAccounts(snapshot);
    renderLedger(snapshot);
    renderClock();
  }

  function unavailable(key: string, why: string): void {
    const el = $(key);
    el.textContent = "Unavailable";
    el.title = why;
  }

  function renderLedger(live: Extract<RevenueSnapshot, { kind: "live" }>): void {
    const buyback = live.state.buybackAccount;
    const href = accountExplorerUrl(deps.network, buyback);
    const link = document.createElement(href ? "a" : "span");
    link.className = "rev-acc-id";
    link.textContent = shortAccount(buyback) + (href ? " ↗" : "");
    link.title = buyback;
    if (link instanceof HTMLAnchorElement && href) {
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${buyback} on NearBlocks (opens in a new tab)`);
    }
    $("ledger-account").replaceChildren(link);

    // A reading for a different buyback account says nothing about this one.
    const current = ledger?.buybackAccount === buyback ? ledger : null;
    if (!current) {
      for (const key of ["ledger-near", "ledger-mpoo", "ledger-waiting"]) $(key).textContent = "…";
      $("ledger-near-note").textContent = "";
      $("ledger-mpoo-note").textContent = "";
      $("ledger-source").textContent = ledgerLoading ? "Reading the buyback totals…" : "";
      return;
    }
    const history = current.history;
    if (history) {
      const prefix = history.complete ? "" : "at least ";
      setAmount("ledger-near", history.totals.nearToBuyback, NEAR_DECIMALS);
      setAmount("ledger-mpoo", history.totals.mpooReturned, MPOO_DECIMALS);
      if (!history.complete) {
        $("ledger-near").textContent = `≥ ${$("ledger-near").textContent}`;
        $("ledger-mpoo").textContent = `≥ ${$("ledger-mpoo").textContent}`;
      }
      const n = history.totals.nearDistributions;
      const m = history.totals.mpooReturns;
      $("ledger-near-note").textContent = n === null
        ? "All time. Only NEAR that reached the buyback account counts."
        : `${prefix}${n} NEAR split${n === 1 ? "" : "s"}, failed transfers taken out.`;
      $("ledger-mpoo-note").textContent = m === null
        ? "All time, as accepted by the board."
        : `${prefix}${m} return${m === 1 ? "" : "s"} accepted by the board.`;
    } else {
      const why = "The buyback totals could not be read. This total is unknown, not zero.";
      unavailable("ledger-near", why);
      unavailable("ledger-mpoo", why);
      $("ledger-near-note").textContent = "Couldn’t read the buyback totals.";
      $("ledger-mpoo-note").textContent = "Couldn’t read the buyback totals.";
    }
    if (current.waiting === null) unavailable("ledger-waiting", "The buyback account balance could not be read.");
    else setAmount("ledger-waiting", current.waiting, NEAR_DECIMALS);

    const parts: string[] = [];
    const source = $("ledger-source");
    if (deps.example) {
      parts.push("Example numbers.");
      delete source.dataset.origin;
    } else if (history?.origin === "board") {
      source.dataset.origin = "board";
      parts.push(`From the board: its ${history.label}, exact.`);
    } else if (history) {
      source.dataset.origin = "index";
      const t = history.transactions ?? 0;
      const through = history.indexedThroughMs === null ? "" : ` The index has reached ${new Date(history.indexedThroughMs).toLocaleString()}.`;
      parts.push(`From the public index, may be incomplete: this board has no running totals, so ${t} board transaction${t === 1 ? " was" : "s were"} found through the ${history.label}.${through}`);
      if (!history.complete) parts.push("Some history isn’t covered (older than the scan, or newer than the index), so these totals are lower bounds.");
    } else {
      delete source.dataset.origin;
      if (current.tried === "index") parts.push("This board keeps no running totals, so the public index was asked.");
      parts.push(current.historyError ?? "The buyback totals couldn’t be read.");
      parts.push("The totals are unknown, not zero.");
    }
    if (ledgerStale) parts.push("The last ledger refresh failed; showing the previous reading.");
    source.textContent = parts.join(" ");
  }

  /** The board's totals are a cheap view: every poll. The index is rate-limited: every `ledgerPollMs`. */
  function ledgerDue(live: Extract<RevenueSnapshot, { kind: "live" }>): boolean {
    if (ledger?.buybackAccount !== live.state.buybackAccount) return true;
    const pace = ledger.tried === "index" ? deps.ledgerPollMs : deps.pollMs;
    return deps.now() - ledgerReadAt >= pace;
  }

  async function refreshLedger(live: Extract<RevenueSnapshot, { kind: "live" }>): Promise<void> {
    if (ledgerLoading) return;
    ledgerLoading = true;
    ledgerReadAt = deps.now();
    if (snapshot?.kind === "live") renderLedger(snapshot);
    try {
      const next = await deps.loadLedger(live);
      if (disposed) return;
      // Keep a good earlier reading over a failed one for the same account.
      const prev = ledger?.buybackAccount === next.buybackAccount ? ledger : null;
      ledgerStale = !!prev && ((next.history === null && prev.history !== null) || (next.waiting === null && prev.waiting !== null));
      ledger = {
        buybackAccount: next.buybackAccount,
        history: next.history ?? prev?.history ?? null,
        historyError: (next.history ?? prev?.history) ? null : next.historyError,
        tried: next.tried,
        waiting: next.waiting ?? prev?.waiting ?? null,
      };
    } catch {
      if (disposed) return;
      ledgerStale = ledger?.buybackAccount === live.state.buybackAccount;
      if (!ledgerStale) ledger = { buybackAccount: live.state.buybackAccount, history: null, historyError: null, tried: null, waiting: null };
    } finally {
      ledgerLoading = false;
    }
    if (!disposed && snapshot?.kind === "live") renderLedger(snapshot);
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    try {
      const next = await deps.load();
      if (disposed || current !== generation) return;
      snapshot = next;
      failed = false;
      updatedAt = deps.now();
      if (next.kind === "live" && ledgerDue(next)) void refreshLedger(next);
    } catch {
      if (disposed || current !== generation) return;
      failed = true;
    }
    render();
  }

  async function distribute(kind: DistributionKind): Promise<void> {
    if (buttons[kind].disabled || deps.example) return;
    const result = $(`${kind}-result`);
    busy[kind] = true;
    result.replaceChildren();
    renderClock();
    try {
      const outcome = parseTxOutcome(await deps.sign({
        contractId: deps.contractId,
        methodName: kind === "near" ? "distribute_near" : "distribute_mpoo",
        gas: kind === "near" ? DISTRIBUTE_NEAR_GAS : DISTRIBUTE_MPOO_GAS,
      }));
      let message: string;
      if (outcome.status === "success") message = "Sent. The split is on chain.";
      else if (isDistributionTooSoon(outcome.failureMessage)) message = "Someone else sent it first. Nothing was taken from you but gas.";
      else if (outcome.status === "failed") message = `The board refused: ${outcome.failureMessage ?? "unknown reason"}.`;
      else message = "Submitted. Check the transaction before trying again.";
      result.textContent = message;
      const link = explorerUrl(deps.network as Parameters<typeof explorerUrl>[0], outcome.transactionHash);
      if (link) {
        const a = document.createElement("a");
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = " View transaction ↗";
        result.append(a);
      }
    } catch (error) {
      result.textContent = isUserRejection(error)
        ? "Cancelled. Nothing was sent."
        : isDistributionTooSoon(error instanceof Error ? error.message : String(error))
          ? "Someone else sent it first."
          : "The wallet couldn’t send it. Nothing changed; try again.";
    } finally {
      busy[kind] = false;
      if (!disposed) await refresh();
    }
  }

  const onNear = (): void => void distribute("near");
  const onMpoo = (): void => void distribute("mpoo");
  buttons.near.addEventListener("click", onNear);
  buttons.mpoo.addEventListener("click", onMpoo);
  const unsubscribe = services.wallet.subscribe(() => renderClock());
  const tick = window.setInterval(renderClock, 1_000);
  const onFocus = (): void => {
    if (document.visibilityState !== "hidden" && !deps.example) void refresh();
  };
  const poll = deps.example ? undefined : window.setInterval(onFocus, deps.pollMs);
  window.addEventListener("focus", onFocus);

  render();
  void refresh();

  return () => {
    disposed = true;
    generation++;
    window.clearInterval(tick);
    if (poll !== undefined) window.clearInterval(poll);
    window.removeEventListener("focus", onFocus);
    buttons.near.removeEventListener("click", onNear);
    buttons.mpoo.removeEventListener("click", onMpoo);
    unsubscribe();
    root.replaceChildren();
  };
}
