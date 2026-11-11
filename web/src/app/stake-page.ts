/**
 * /stake — stake TOILET, collect mPOO. The live front end for contracts/toilet-staking.
 *
 * Layout follows the Toilet Staking mock (stake/unstake tabs, tax preview, money stats,
 * your position). Rules come from the staking contract's own `get_config`, never from
 * constants here, and every figure names where it was read. A failed read is unknown,
 * never zero. Nothing on this page states or implies a promised return.
 */

import { explorerUrl } from "@shared/board-rules.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import { connectWallet } from "../shared/connect-wallet";
import { shortAccount } from "../shared/short-account";
import { isUserRejection, parseTxOutcome } from "../tx-outcome";
import { signAndSendClaimRewards, signAndSendStake, signAndSendUnstake } from "../wallet";
import type { PageContext, PageDispose } from "./page-registry";
import { accountExplorerUrl, createRpcView, formatAmount, MPOO_DECIMALS, MPOO_SPLIT, NEAR_DECIMALS } from "./revenue-panel";
import {
  claimRewardsState,
  CLAIM_REWARDS_GAS,
  exitTax,
  explainFailure,
  fmtToken,
  hasEvent,
  lockState,
  loadStaking,
  parseAmount,
  sharePpm,
  shareText,
  STAKE_GAS,
  stakeRefused,
  STORAGE_GAS,
  todaysCut,
  unitsToInput,
  unlockState,
  UNSTAKE_GAS,
  type ActionInput,
  type StakingSnapshot,
} from "./staking";
import "./stake-page.css";

export interface StakePageDeps {
  load: (account: string | null) => Promise<StakingSnapshot>;
  stake: typeof signAndSendStake;
  unstake: typeof signAndSendUnstake;
  claim: typeof signAndSendClaimRewards;
  network: string;
  board: string;
  configured: boolean;
  pollMs: number;
}

function defaultDeps(): StakePageDeps {
  const view = createRpcView(RPC_URL);
  return {
    load: (account) => loadStaking(view, CONTRACT_ID, account),
    stake: signAndSendStake,
    unstake: signAndSendUnstake,
    claim: signAndSendClaimRewards,
    network: PAGE_NETWORK,
    board: CONTRACT_ID,
    configured: !!CONTRACT_ID,
    pollMs: 30_000,
  };
}

const TEMPLATE = `
<article class="stk" aria-labelledby="stk-title">
  <header class="stk-head">
    <p class="mp-eyebrow">TOILET staking</p>
    <h2 id="stk-title" data-route-heading="true">Stake TOILET. Get paid in mPOO.</h2>
    <p class="stk-lede">${MPOO_SPLIT.stakers}% of every mPOO the wall earns goes to the stakers’ pool. The pool pays out a share of itself every day, split by how much TOILET each staker has staked. Paint tiles to earn TOILET, stake it here, claim mPOO whenever you like.</p>
    <p class="stk-source" data-s="source" role="status"></p>
  </header>

  <div class="stk-notice" data-s="notice" hidden></div>

  <div class="stk-live" data-s="live" hidden>
    <dl class="stk-stats" aria-label="The staking pool">
      <div data-c="stake"><dt>TOILET staked</dt><dd data-s="totalStaked">…</dd><small>by everyone</small></div>
      <div data-c="tag"><dt>mPOO in the pool</dt><dd data-s="pool">…</dd><small data-s="dripNote">…</small></div>
      <div data-c="near"><dt>Today’s payout, at most</dt><dd data-s="today">…</dd><small>mPOO, split across all stakers</small></div>
      <div><dt>mPOO paid to stakers</dt><dd data-s="released">…</dd><small>all time, as of the last payout on chain</small></div>
      <div data-c="burn"><dt>TOILET burned by unstaking</dt><dd data-s="burned">…</dd><small data-s="taxNote">…</small></div>
      <div><dt>mPOO on its way</dt><dd data-s="reserve">…</dd><small>held on the board, joins the pool at the next split</small></div>
      <div data-c="stake"><dt>Your share</dt><dd data-s="share">…</dd><small data-s="shareNote">of all staked TOILET</small></div>
      <div data-c="tag"><dt>Your cut of today’s payout</dt><dd data-s="cut">…</dd><small>at today’s pool; it moves as the pool and stakes change</small></div>
    </dl>

    <div class="stk-grid">
      <section class="mp-card stk-panel" aria-labelledby="stk-pos-h">
        <h3 id="stk-pos-h">Your position</h3>
        <dl class="stk-rows">
          <div><dt>TOILET in your wallet</dt><dd data-s="wallet">…</dd></div>
          <div><dt>Staked</dt><dd data-s="staked" class="stk-good">…</dd></div>
          <div><dt>mPOO ready to claim</dt><dd data-s="pending" class="stk-tag">…</dd></div>
        </dl>
        <!-- Signed out there is exactly one way forward in this card (C2): one real
             Connect control, instead of "Connect a wallet" written into five values. -->
        <button type="button" class="mp-btn" data-act="connect" hidden>Connect wallet</button>
        <button type="button" class="mp-btn mp-btn-primary" data-act="claim">Claim mPOO</button>
        <p class="stk-hint" data-s="claimHint"></p>
        <p class="stk-result" data-s="claimResult" role="status"></p>
        <p class="stk-fine">Claiming doesn’t touch your staked TOILET, and your mPOO is never taxed. <a href="/toilet">Earn more TOILET from your tiles →</a></p>
      </section>

      <section class="mp-card stk-panel" aria-label="Stake or unstake">
        <div class="stk-tabs" role="tablist" aria-label="Stake or unstake">
          <button type="button" role="tab" id="stk-t-lock" aria-selected="true" aria-controls="stk-p-lock">Stake</button>
          <button type="button" role="tab" id="stk-t-unlock" aria-selected="false" aria-controls="stk-p-unlock" tabindex="-1">Unstake</button>
        </div>

        <div id="stk-p-lock" role="tabpanel" aria-labelledby="stk-t-lock" class="stk-pane">
          <div class="stk-field">
            <label for="stk-lock-amt">Amount to stake</label>
            <div class="stk-input"><input id="stk-lock-amt" inputmode="decimal" autocomplete="off" placeholder="0"><span>TOILET</span><button type="button" data-max="lock">MAX</button></div>
          </div>
          <dl class="stk-rows stk-preview" aria-live="polite">
            <div><dt>Staked after this</dt><dd data-s="lockAfter">—</dd></div>
            <div><dt>Your share after this</dt><dd data-s="lockShare" class="stk-good">—</dd></div>
            <div><dt>Your cut of today’s payout after</dt><dd data-s="lockCut" class="stk-tag">—</dd></div>
          </dl>
          <p class="stk-fine" data-s="registerNote" hidden></p>
          <button type="button" class="mp-btn mp-btn-primary" data-act="lock">Stake TOILET</button>
          <p class="stk-hint" data-s="lockHint"></p>
          <p class="stk-result" data-s="lockResult" role="status"></p>
        </div>

        <div id="stk-p-unlock" role="tabpanel" aria-labelledby="stk-t-unlock" class="stk-pane" hidden>
          <div class="stk-field">
            <label for="stk-unlock-amt">Amount to unstake</label>
            <div class="stk-input"><input id="stk-unlock-amt" inputmode="decimal" autocomplete="off" placeholder="0"><span>TOILET</span><button type="button" data-max="unlock">MAX</button></div>
          </div>
          <div class="stk-bar" aria-hidden="true"><i data-s="barKeep"></i><i data-s="barBurn"></i></div>
          <div class="stk-legend"><span data-c="stake">back to you</span><span data-c="burn">burned forever</span></div>
          <dl class="stk-rows stk-preview" aria-live="polite">
            <div><dt>You get back</dt><dd data-s="unlockNet" class="stk-good">—</dd></div>
            <div><dt>Paperhand tax, burned</dt><dd data-s="unlockTax" class="stk-burn">—</dd></div>
            <div><dt>Your mPOO</dt><dd>stays claimable</dd></div>
          </dl>
          <div class="stk-tax">
            <b>Paper hands pay: <span data-s="taxPct">10%</span> of the TOILET you unstake is burned.</b>
            <ul>
              <li>Every time, on the amount you take out only. TOILET you leave staked isn’t touched.</li>
              <li>It’s burned: sent to an address with no key. Nobody receives it, the team included.</li>
              <li>Your mPOO is never taxed.</li>
            </ul>
          </div>
          <button type="button" class="mp-btn stk-danger" data-act="unlock">Unstake TOILET</button>
          <p class="stk-hint" data-s="unlockHint"></p>
          <p class="stk-result" data-s="unlockResult" role="status"></p>
        </div>
      </section>
    </div>

    <section class="stk-sec" aria-labelledby="stk-how-h">
      <h3 id="stk-how-h">How the money gets here</h3>
      <ol class="stk-flow">
        <li><b>Painters buy credits</b> in NEAR or mPOO. The NEAR is swapped for mPOO.</li>
        <li><b>Each split</b> sends ${MPOO_SPLIT.stakers}% of the mPOO to the stakers’ pool, burns ${MPOO_SPLIT.burn}% and pays ${MPOO_SPLIT.team}% to the team.</li>
        <li><span><b>The pool pays out <span data-s="dripPct">10%</span> of itself a day, a little every moment</b>, split by staked TOILET.</span></li>
        <li><b>You claim</b> your mPOO whenever you like.</li>
      </ol>
      <p class="stk-fine">The daily payout smooths what arrives; it doesn’t grow it. A busy week fills the pool, and the pool spreads it over the following days. <a href="/money">See every split on Where the money goes →</a></p>
    </section>

    <section class="stk-sec" aria-labelledby="stk-trust-h">
      <h3 id="stk-trust-h">Nobody can change these rules</h3>
      <p class="stk-fine">The staking contract has no owner, no admin and no upgrade. The payout rate and the tax are fixed in its code. A bug can’t be patched; it would take a new contract.</p>
      <ul class="stk-accounts" data-s="accounts"></ul>
    </section>

    <p class="stk-fine">Payouts depend on what the wall earns and can be zero. TOILET and mPOO can lose value. Nothing here is a promised return.</p>
  </div>
</article>`;

export function mountStakePage(root: HTMLElement, ctx: PageContext, overrides: Partial<StakePageDeps> = {}): PageDispose {
  const deps = { ...defaultDeps(), ...overrides };
  const { services } = ctx;
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".stk")!;
  const $ = (key: string) => page.querySelector<HTMLElement>(`[data-s="${key}"]`)!;
  const btn = (act: string) => page.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
  const connectBtn = btn("connect");
  const lockInput = page.querySelector<HTMLInputElement>("#stk-lock-amt")!;
  const unlockInput = page.querySelector<HTMLInputElement>("#stk-unlock-amt")!;
  const cleanups: Array<() => void> = [];
  const listen = (el: EventTarget, type: string, fn: EventListener) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  let snap: StakingSnapshot | null = null;
  let failed = false;
  let updatedAt: number | null = null;
  const busy = { lock: false, unlock: false, claim: false };
  /** Signed out: that action's button is a Connect control (UI review C1). */
  const connectable = { lock: false, unlock: false, claim: false };
  let generation = 0;
  let disposed = false;

  const live = () => (snap?.kind === "live" ? snap : null);
  const tok = (units: bigint, unit: string, maxFraction = 4) => `${fmtToken(units, maxFraction)} ${unit}`;
  const near = (yocto: bigint) => `${formatAmount(yocto, NEAR_DECIMALS, { maxFraction: 5 })} NEAR`;

  function actionInput(): ActionInput {
    const s = services.wallet.getSession();
    return { accountId: s.accountId, walletNetwork: s.networkId, pageNetwork: deps.network, busy: false, live: !!live() };
  }

  function renderSource(): void {
    const el = $("source");
    // Short ids keep the line inside a phone; the full ones stay on hover.
    if (!deps.configured) { el.textContent = "This page isn’t connected to a board."; el.title = ""; return; }
    const l = live();
    if (!l && !failed && !snap) {
      el.textContent = `Reading ${shortAccount(deps.board)} on ${deps.network}…`;
      el.title = deps.board;
      return;
    }
    const when = updatedAt === null ? "" : ` · updated ${new Date(updatedAt).toLocaleTimeString()}`;
    el.textContent = l
      ? `Read live from ${shortAccount(l.staking)} and ${shortAccount(l.config.board)} on ${deps.network}${when}.`
      : `Read from ${shortAccount(deps.board)} on ${deps.network}${when}.`;
    el.title = l ? `${l.staking} and ${l.config.board}` : deps.board;
  }

  function renderNotice(): void {
    const notice = $("notice");
    notice.replaceChildren();
    notice.hidden = true;
    delete notice.dataset.tone;
    const say = (title: string, body: string, tone: string, retry = false) => {
      const h = document.createElement("h3");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = body;
      notice.append(h, p);
      if (retry) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mp-btn";
        b.textContent = "Try again";
        b.addEventListener("click", () => void refresh());
        notice.append(b);
      }
      notice.dataset.tone = tone;
      notice.hidden = false;
    };
    if (!deps.configured) say("Not connected", "This preview isn’t connected to a board, so there’s nothing to stake.", "info");
    else if (failed && !snap) say("Couldn’t read the staking pool", "These numbers are unknown, not zero.", "bad", true);
    else if (snap?.kind === "not-set") say("Staking opens soon", "This board hasn’t been pointed at a staking contract yet. The stakers’ share waits on the board until it is, and nobody can spend it, the owner included.", "info");
    else if (snap?.kind === "not-live") say("Staking opens soon", `The board sends the stakers’ share to ${snap.staking}, but there’s no staking contract running there yet.`, "info");
    else if (failed) say("The last refresh failed", "Showing the previous reading.", "bad");
    $("live").hidden = !live();
  }

  function renderStats(): void {
    const l = live();
    if (!l) return;
    const { pool, config } = l;
    $("totalStaked").textContent = tok(pool.totalStaked, "", 2).trim();
    $("pool").textContent = tok(pool.pool, "", 2).trim();
    $("dripNote").textContent = `pays out ${config.dripBps / 100}% of itself a day`;
    $("today").textContent = fmtToken((pool.pool * BigInt(config.dripBps)) / 10_000n, 2);
    $("released").textContent = fmtToken(pool.releasedTotal, 2);
    $("burned").textContent = fmtToken(pool.burnedTotal, 2);
    $("taxNote").textContent = `${config.exitTaxBps / 100}% of every unstake`;
    $("reserve").textContent = l.boardReserve === null ? "Unavailable" : formatAmount(l.boardReserve, MPOO_DECIMALS, { maxFraction: 2 });
    $("taxPct").textContent = `${config.exitTaxBps / 100}%`;
    $("dripPct").textContent = `${config.dripBps / 100}%`;
    const a = l.account;
    const signedIn = !!services.wallet.getSession().accountId;
    if (a) {
      const ppm = sharePpm(a.staked, pool.totalStaked);
      $("share").textContent = shareText(ppm);
      $("shareNote").textContent = `${fmtToken(a.staked, 2)} of ${fmtToken(pool.totalStaked, 2)} staked`;
      $("cut").textContent = `≈ ${fmtToken(todaysCut(pool.pool, config.dripBps, a.staked, pool.totalStaked), 4)}`;
    } else {
      // C2: signed out is an unknown value, not a sentence in a value slot.
      const text = !signedIn ? "—" : l.accountFailed ? "Unavailable" : "…";
      $("share").textContent = text;
      $("cut").textContent = text;
    }
  }

  function renderPosition(): void {
    const l = live();
    if (!l) return;
    const a = l.account;
    const session = services.wallet.getSession();
    connectBtn.hidden = !!session.accountId;
    btn("claim").hidden = !session.accountId;
    for (const key of ["wallet", "staked", "pending"]) {
      if (!session.accountId) $(key).textContent = "—";
      else if (session.networkId !== deps.network) $(key).textContent = `Switch to ${deps.network}`;
      else if (!a) $(key).textContent = l.accountFailed ? "Unavailable" : "…";
    }
    if (a && session.accountId && session.networkId === deps.network) {
      $("wallet").textContent = tok(a.wallet, "TOILET");
      $("staked").textContent = tok(a.staked, "TOILET");
      $("pending").textContent = tok(a.pendingRewards, "mPOO", 6);
    }
    const claim = claimRewardsState({ ...actionInput(), busy: busy.claim, account: a });
    btn("claim").disabled = !claim.enabled;
    btn("claim").textContent = claim.label;
    connectable.claim = claim.connect === true;
    $("claimHint").textContent = a && !a.mpooRegistered && a.mpooStorageMin !== null && a.pendingRewards > 0n
      ? `${claim.hint} It costs ${near(a.mpooStorageMin)}, once.`
      : claim.hint;
  }

  function renderLock(): void {
    const l = live();
    const a = l?.account ?? null;
    const amount = parseAmount(lockInput.value);
    const state = lockState({ ...actionInput(), busy: busy.lock, amount, account: a, storageMin: l?.config.storageMin ?? 0n });
    btn("lock").disabled = !state.enabled;
    btn("lock").textContent = state.label;
    connectable.lock = state.connect === true;
    $("lockHint").textContent = state.hint;
    const note = $("registerNote");
    note.hidden = !(l && a && !a.registered);
    if (l && a && !a.registered) note.textContent = `Your first stake also pays ${near(l.config.storageMin)} to register you with the staking contract, once. It comes back if you ever close your staking account.`;
    if (!l || !a || amount === null) {
      for (const k of ["lockAfter", "lockShare", "lockCut"]) $(k).textContent = "—";
      return;
    }
    const after = a.staked + amount;
    const total = l.pool.totalStaked + amount;
    $("lockAfter").textContent = tok(after, "TOILET");
    $("lockShare").textContent = shareText(sharePpm(after, total));
    $("lockCut").textContent = `≈ ${tok(todaysCut(l.pool.pool, l.config.dripBps, after, total), "mPOO")}`;
  }

  function renderUnlock(): void {
    const l = live();
    const a = l?.account ?? null;
    const amount = parseAmount(unlockInput.value);
    const rate = l?.config.exitTaxBps ?? 1_000;
    const state = unlockState({ ...actionInput(), busy: busy.unlock, amount, account: a, exitTaxBps: rate });
    btn("unlock").disabled = !state.enabled;
    btn("unlock").textContent = state.label;
    connectable.unlock = state.connect === true;
    $("unlockHint").textContent = state.hint;
    const keep = 100 - rate / 100;
    $("barKeep").style.width = `${keep}%`;
    $("barBurn").style.width = `${100 - keep}%`;
    if (amount === null) {
      $("unlockNet").textContent = "—";
      $("unlockTax").textContent = "—";
      return;
    }
    const { tax, net } = exitTax(amount, rate);
    $("unlockNet").textContent = tok(net, "TOILET");
    $("unlockTax").textContent = tok(tax, "TOILET");
  }

  function renderAccounts(): void {
    const l = live();
    const list = $("accounts");
    if (!l) { list.replaceChildren(); return; }
    const session = services.wallet.getSession();
    const rows: Array<[string, string, string]> = [
      ["Staking contract", l.staking, "Holds staked TOILET and the stakers’ mPOO."],
      ["TOILET token", l.config.toilet, "What you lock."],
      ["mPOO token", l.config.mpoo, "What you’re paid in."],
    ];
    list.replaceChildren(...rows.map(([role, id, note]) => {
      const li = document.createElement("li");
      const r = document.createElement("span");
      r.className = "stk-acc-role";
      r.textContent = role;
      const href = accountExplorerUrl(deps.network, id);
      const v = document.createElement(href ? "a" : "span");
      v.className = "stk-acc-id";
      v.textContent = href ? `${id} ↗` : id;
      if (v instanceof HTMLAnchorElement && href) { v.href = href; v.target = "_blank"; v.rel = "noopener noreferrer"; }
      const n = document.createElement("span");
      n.className = "stk-acc-note";
      n.textContent = note;
      li.append(r, v, n);
      return li;
    }));
    const mine = session.accountId ? accountExplorerUrl(deps.network, session.accountId) : null;
    if (mine) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = mine;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Your locks, unlocks and claims on NearBlocks ↗";
      li.append(a);
      list.append(li);
    }
  }

  function render(): void {
    renderSource();
    renderNotice();
    renderStats();
    renderPosition();
    renderLock();
    renderUnlock();
    renderAccounts();
  }

  async function refresh(): Promise<void> {
    if (!deps.configured || disposed) { render(); return; }
    const current = ++generation;
    const session = services.wallet.getSession();
    const account = session.networkId === deps.network ? session.accountId : null;
    try {
      const next = await deps.load(account);
      if (disposed || current !== generation) return;
      snap = next;
      failed = false;
      updatedAt = Date.now();
    } catch {
      if (disposed || current !== generation) return;
      failed = true;
    }
    render();
  }

  function report(key: string, outcomeRaw: unknown, ok: string, special: Array<[boolean, string]>): void {
    const outcome = parseTxOutcome(outcomeRaw);
    const el = $(key);
    let message: string;
    const hit = special.find(([cond]) => cond);
    if (outcome.status === "success" && hit) message = hit[1];
    else if (outcome.status === "success") message = ok;
    else if (outcome.status === "failed") message = explainFailure(outcome.failureMessage) ?? `The contract refused: ${outcome.failureMessage ?? "unknown reason"}.`;
    else message = "Submitted. Check the transaction before trying again.";
    el.textContent = message;
    const link = explorerUrl(deps.network as Parameters<typeof explorerUrl>[0], outcome.transactionHash);
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = " View transaction ↗";
      el.append(a);
    }
  }

  async function run(kind: "lock" | "unlock" | "claim", key: string, send: () => Promise<void>): Promise<void> {
    if (connectable[kind]) {
      connectWallet(() => void services.wallet.connect());
      return;
    }
    if (btn(kind).disabled || busy[kind]) return;
    busy[kind] = true;
    $(key).replaceChildren();
    render();
    try {
      await send();
    } catch (error) {
      $(key).textContent = isUserRejection(error)
        ? "Cancelled. Nothing was sent."
        : "The wallet couldn’t send it. If a first step went through, it shows below once the page refreshes.";
    } finally {
      busy[kind] = false;
      if (!disposed) await refresh();
    }
  }

  const onLock = () => void run("lock", "lockResult", async () => {
    const l = live()!, a = l.account!, amount = parseAmount(lockInput.value)!;
    const raw = await deps.stake({
      toilet: l.config.toilet, staking: l.staking, amount: amount.toString(),
      registerDeposit: a.registered ? null : l.config.storageMin.toString(), storageGas: STORAGE_GAS, gas: STAKE_GAS,
    });
    report("lockResult", raw, `Staked ${tok(amount, "TOILET")}. Your share of each payout starts now.`, [
      [stakeRefused(raw), "The staking contract refused the lock and sent your TOILET back. Nothing was lost."],
    ]);
    lockInput.value = "";
  });
  const onUnlock = () => void run("unlock", "unlockResult", async () => {
    const l = live()!, amount = parseAmount(unlockInput.value)!;
    const { tax, net } = exitTax(amount, l.config.exitTaxBps);
    const raw = await deps.unstake({ staking: l.staking, amount: amount.toString(), gas: UNSTAKE_GAS });
    report("unlockResult", raw, `Unstaked. ${tok(net, "TOILET")} is back in your wallet and ${tok(tax, "TOILET")} was burned.`, [
      [hasEvent(raw, ["unstake_failed"]), "The transfer back failed, so your stake was restored in full. Nothing was burned."],
    ]);
    unlockInput.value = "";
  });
  const onClaim = () => void run("claim", "claimResult", async () => {
    const l = live()!, a = l.account!;
    const raw = await deps.claim({
      staking: l.staking, mpoo: l.config.mpoo,
      mpooRegisterDeposit: a.mpooRegistered ? null : (a.mpooStorageMin ?? 0n).toString(),
      storageGas: STORAGE_GAS, gas: CLAIM_REWARDS_GAS,
    });
    report("claimResult", raw, "Claimed. The mPOO is in your wallet.", [
      [hasEvent(raw, ["claim_failed"]), "The mPOO token refused the payout, so your rewards were put back. Nothing is lost; try again."],
    ]);
  });

  listen(connectBtn, "click", () => connectWallet(() => void services.wallet.connect()));
  listen(btn("lock"), "click", onLock);
  listen(btn("unlock"), "click", onUnlock);
  listen(btn("claim"), "click", onClaim);
  listen(lockInput, "input", renderLock);
  listen(unlockInput, "input", renderUnlock);
  for (const max of page.querySelectorAll<HTMLButtonElement>("[data-max]")) {
    listen(max, "click", () => {
      const a = live()?.account;
      if (!a) return;
      if (max.dataset.max === "lock") { lockInput.value = unitsToInput(a.wallet); renderLock(); }
      else { unlockInput.value = unitsToInput(a.staked); renderUnlock(); }
    });
  }

  // Tabs, with arrow-key movement between them.
  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      page.querySelector<HTMLElement>(`#${t.getAttribute("aria-controls")}`)!.hidden = !on;
    }
  };
  for (const t of tabs) {
    listen(t, "click", () => select(t));
    listen(t, "keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key !== "ArrowLeft" && key !== "ArrowRight") return;
      const next = tabs[(tabs.indexOf(t) + 1) % tabs.length];
      select(next);
      next.focus();
    });
  }

  const unsubscribe = services.wallet.subscribe(() => { render(); void refresh(); });
  const onFocus = () => { if (document.visibilityState !== "hidden") void refresh(); };
  const poll = window.setInterval(onFocus, deps.pollMs);
  listen(window, "focus", onFocus);

  render();
  void refresh();

  return () => {
    disposed = true;
    generation++;
    window.clearInterval(poll);
    cleanups.forEach((fn) => fn());
    unsubscribe();
    root.replaceChildren();
  };
}
