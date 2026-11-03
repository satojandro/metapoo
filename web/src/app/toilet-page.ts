/**
 * /toilet. Approved design: docs/visual-concepts/toilet-draft.html, without its review layer.
 *
 * Live numbers come from the board and the TOILET token. Until a read confirms one it
 * shows "…"; if the read fails, the number (or the sentence that needs it) is hidden,
 * never guessed. The hero wall and the three explorers are samples and say so.
 */

import { PALETTE } from "@shared/palette.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL, TOILET_ID } from "../config";
import type { PageContext, PageDispose } from "./page-registry";
import { createRpcView, formatAmount, MPOO_DECIMALS, MPOO_SPLIT } from "./revenue-panel";
import {
  DAILY_RELEASE,
  earnOutcome,
  EMPTY_PAGE,
  EXIT_TAX,
  loadToiletPage,
  perCellDay,
  stakeOutcome,
  TOILET_CAP,
  TOILET_DECIMALS,
  WALL_TILES,
  whaleOutcome,
  yearsAtRate,
  type ToiletPageSnapshot,
} from "./toilet";
import { mountToiletClaim, toiletConfigured, type ToiletClaimDeps } from "./toilet-claim";
import "./toilet.css";

export interface ToiletPageDeps {
  load: () => Promise<ToiletPageSnapshot>;
  configured: boolean;
  network: string;
  board: string;
  toilet: string;
  reducedMotion: boolean;
  pollMs: number;
  /** Passed through to the "Your TOILET" card. */
  claim: Partial<ToiletClaimDeps>;
}

function defaultDeps(): ToiletPageDeps {
  const view = createRpcView(RPC_URL);
  return {
    load: () => loadToiletPage(view, CONTRACT_ID, TOILET_ID),
    configured: !!CONTRACT_ID,
    network: PAGE_NETWORK,
    board: CONTRACT_ID,
    toilet: TOILET_ID,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    pollMs: 60_000,
    claim: {},
  };
}

/** Launch values, used by the explorers only until the board confirms its own. */
const LAUNCH = { nearPerCredit: 0.0025, wet: 4, dry: 1 };
const DEFAULT_YEARS = 4;

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const smart = (n: number) => (n >= 100 ? fmt(n) : n >= 10 ? fmt(n, 1) : fmt(n, 2));
const pct = (share: number) => `${Math.round(share * 100)}%`;

const TEMPLATE = `
<article class="tlt" aria-labelledby="tlt-title">
  <header class="tlt-hero">
    <div class="tlt-hero-copy">
      <p class="mp-eyebrow">TOILET</p>
      <h2 id="tlt-title" data-route-heading="true">Hold the wall. <em>Get paid in TOILET.</em></h2>
      <p class="tlt-lede">Every tile you paint with credits earns TOILET for as long as it survives. Paint over someone else’s tile and it starts earning for you instead. Stake your TOILET and you get ${MPOO_SPLIT.stakers}% of the mPOO the stall takes in.</p>
      <div class="tlt-facts">
        <span class="tlt-fact"><b>${fmt(TOILET_CAP)}</b> TOILET, ever</span>
        <span class="tlt-fact"><b>0</b> owner keys over the token</span>
        <span class="tlt-fact"><b>${MPOO_SPLIT.stakers}%</b> of mPOO to stakers</span>
        <span class="tlt-fact"><b>${pct(EXIT_TAX)}</b> burned when you unstake</span>
      </div>
    </div>
    <figure class="tlt-demo">
      <div class="tlt-demo-wall" data-tlt-wall aria-hidden="true"></div>
      <div class="tlt-meter">
        <span class="tlt-meter-label">Your TOILET · sample</span><span class="tlt-meter-tiles" data-tlt-tiles>12 tiles</span>
        <strong data-tlt-count>0.000</strong><span class="tlt-meter-tiles" data-tlt-pace></span>
      </div>
      <p class="tlt-demo-log" data-tlt-log aria-live="off">Your tiles are outlined. Each one drips TOILET while it’s on the wall.</p>
    </figure>
  </header>

  <section class="tlt-sec" aria-labelledby="tlt-live-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">On the board now</p>
      <h3 id="tlt-live-h" data-tlt-live-h>Earning is live. Staking opens next.</h3>
      <p data-tlt-live-p>Paint with credits and your tiles start earning straight away. Claim whenever you like: nothing is lost by waiting. Staking opens on this page once the staking contract is live.</p>
    </div>
    <div class="tlt-live">
      <section class="mp-card" data-tlt-claim aria-label="Your TOILET"></section>
      <dl class="tlt-stats">
        <div data-c="tag" data-needs="rate"><dt>Earning rate</dt><dd><span data-tl="rate">…</span></dd><span class="tlt-stat-note" data-tl="rateNote">TOILET per tile per day</span></div>
        <div data-needs="accrued"><dt>TOILET earned so far</dt><dd data-tl="accrued">…</dd><span class="tlt-stat-note" data-needs="remaining"><span data-tl="remaining">…</span> of the billion left</span></div>
        <div data-c="stake" data-needs="reserve"><dt>mPOO waiting for stakers</dt><dd data-tl="reserve">…</dd><span class="tlt-stat-note" data-tlt-reserve-note>Held on the board until staking opens. Nobody can spend it, the owner included.</span></div>
        <div data-c="burn" data-needs="burned"><dt>TOILET burned</dt><dd data-tl="burned">…</dd><span class="tlt-stat-note">Burns never reopen the cap.</span></div>
      </dl>
    </div>
  </section>

  <section class="tlt-sec" aria-labelledby="tlt-loop-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">The loop</p>
      <h3 id="tlt-loop-h">Painters pay. Holders earn. Stakers collect.</h3>
      <p>The more people fight over the wall, the more the stall earns, and the more there is for stakers. Being off the wall means watching other people earn.</p>
    </div>
    <div class="tlt-loop">
      <div class="tlt-step" data-c="near"><p class="tlt-k">1 · Paint</p><h4>Take tiles</h4><p>Buy credits and paint. Every credit sale is revenue for the stall.</p></div>
      <div class="tlt-step" data-c="tag"><p class="tlt-k">2 · Hold</p><h4>Earn TOILET</h4><p>Your painted tiles earn TOILET every second they survive. Claim it whenever you like.</p></div>
      <div class="tlt-step" data-c="stake"><p class="tlt-k">3 · Stake</p><h4>Collect mPOO</h4><p>Stake TOILET to take a share of ${MPOO_SPLIT.stakers}% of the stall’s mPOO.</p></div>
      <div class="tlt-step" data-c="burn"><p class="tlt-k">4 · Defend</p><h4>Keep your tiles</h4><p>Someone paints over you, you stop earning. Paint back. Wet paint costs them <span data-tl="wet">${LAUNCH.wet}</span> credits to cover.</p></div>
    </div>
    <p class="tlt-loop-back">↺ Fights over tiles are revenue. Revenue is staker income.</p>
  </section>

  <section class="tlt-sec" id="earn" aria-labelledby="tlt-earn-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">Earnings explorer</p>
      <h3 id="tlt-earn-h">What does a tile earn?</h3>
      <p>Every earning tile gets the same rate. Pick how fast the billion should run out, then see what your tiles make. Free tiles earn nothing until someone repaints them with credits.</p>
    </div>
    <div class="tlt-explorer">
      <div class="mp-card">
        <div class="tlt-ctrl">
          <span class="tlt-lbl" id="tlt-pace-l">Pace: years to mint the billion on a full wall</span>
          <div class="tlt-chips" role="group" aria-labelledby="tlt-pace-l">
            <button class="mp-chip" type="button" data-years="1" aria-pressed="false">1 year</button>
            <button class="mp-chip" type="button" data-years="2" aria-pressed="false">2 years</button>
            <button class="mp-chip" type="button" data-years="4" aria-pressed="true">4 years</button>
            <button class="mp-chip" type="button" data-years="10" aria-pressed="false">10 years</button>
            <button class="mp-chip" type="button" data-years-live aria-pressed="false" hidden>The board’s rate</button>
          </div>
        </div>
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-tiles">Tiles you hold</label><output data-o="tiles" for="tlt-tiles">24</output></div>
          <input id="tlt-tiles" type="range" min="1" max="1024" value="24">
        </div>
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-survive">Hours a day your tiles survive</label><output data-o="survive" for="tlt-survive">12 h</output></div>
          <input id="tlt-survive" type="range" min="1" max="24" value="12">
        </div>
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-painted">Tiles painted on the wall</label><output data-o="painted" for="tlt-painted">16,384</output></div>
          <input id="tlt-painted" type="range" min="1024" max="${WALL_TILES}" step="256" value="${WALL_TILES}">
        </div>
      </div>
      <div class="mp-card">
        <div class="tlt-big"><strong data-o="you" class="tlt-num">0</strong><span>TOILET a day for you</span></div>
        <dl class="tlt-rows">
          <div><dt>Per tile, per day</dt><dd data-o="perTile">0</dd></div>
          <div><dt>Whole wall, per day</dt><dd data-o="wallDay">0</dd></div>
          <div><dt>Supply minted per year</dt><dd data-o="minted">0%</dd></div>
          <div><dt>Billion runs out in</dt><dd data-o="runout">0</dd></div>
        </dl>
        <p class="tlt-verdict" data-o="verdict"></p>
      </div>
    </div>
  </section>

  <section class="tlt-sec" id="whale" aria-labelledby="tlt-whale-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">Whales welcome</p>
      <h3 id="tlt-whale-h">Buy the wall if you like. The internet will make you pay to keep it.</h3>
      <p>There’s no earning cap. Paint a thousand tiles and all of them earn. But every tile is up for grabs, and holding one means answering every poke while the poker’s paint is still wet. Every fight sells credits, and every credit sold feeds the stakers.</p>
    </div>
    <div class="mp-card">
      <div class="tlt-explorer">
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-whale">A whale paints this many tiles</label><output data-o="whale" for="tlt-whale">4,096 tiles</output></div>
          <input id="tlt-whale" type="range" min="128" max="${WALL_TILES}" step="128" value="4096">
        </div>
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-pokers">Players poking the whale, 32 tiles each a day</label><output data-o="pokers" for="tlt-pokers">100 players</output></div>
          <input id="tlt-pokers" type="range" min="0" max="500" step="10" value="100">
        </div>
      </div>
      <div class="tlt-share">
        <div class="tlt-share-top"><span>Whale’s share of TOILET minted</span><b data-o="share">25%</b></div>
        <div class="tlt-track"><i data-o="shareBar"></i></div>
      </div>
      <div class="tlt-outs">
        <div class="tlt-out" data-c="burn"><strong data-o="answer" class="tlt-num">0</strong><span>NEAR a day the whale spends answering, at <span data-tl="wet">${LAUNCH.wet}</span> credits a tile</span></div>
        <div class="tlt-out" data-c="near"><strong data-o="pokes" class="tlt-num">0</strong><span>NEAR a day the pokers spend, at <span data-tl="dry">${LAUNCH.dry}</span> credit a tile</span></div>
        <div class="tlt-out"><strong data-o="fight" class="tlt-num">0</strong><span>NEAR a day of that fight that reaches stakers as mPOO</span></div>
      </div>
      <p class="tlt-small">Poking a dry whale tile costs <span data-tl="dry">${LAUNCH.dry}</span> credit. Taking it back while the paint is wet costs the whale <span data-tl="wet">${LAUNCH.wet}</span>. Assumes the whale answers every poke while it’s wet. <span data-tl="priceNote"></span></p>
    </div>
  </section>

  <section class="tlt-sec" id="stake" aria-labelledby="tlt-stake-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">Staking</p>
      <h3 id="tlt-stake-h">Stake TOILET. Collect the stall’s mPOO.</h3>
      <p>Painters pay NEAR and mPOO. The stall buys mPOO with the NEAR and sends ${MPOO_SPLIT.stakers}% of all its mPOO to the stakers’ pool. The pool pays out at most ${pct(DAILY_RELEASE)} of itself a day, pro rata to stake, so payouts arrive as a steady drip and the pool swells when the wall is busy.</p>
    </div>
    <div class="mp-card">
      <div class="tlt-explorer">
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-spend">Painters spend this much NEAR a week</label><output data-o="spend" for="tlt-spend">100 NEAR</output></div>
          <input id="tlt-spend" type="range" min="10" max="2000" step="10" value="100">
        </div>
        <div class="tlt-ctrl">
          <div class="tlt-ctrl-top"><label for="tlt-mine">Your share of all staked TOILET</label><output data-o="mine" for="tlt-mine">1%</output></div>
          <input id="tlt-mine" type="range" min="0.1" max="25" step="0.1" value="1">
        </div>
      </div>
      <div class="tlt-outs">
        <div class="tlt-out"><strong data-o="pool" class="tlt-num">0</strong><span>NEAR of mPOO the pool settles around</span></div>
        <div class="tlt-out"><strong data-o="youWeek" class="tlt-num">0</strong><span>NEAR of mPOO to you a week, once the pool settles</span></div>
        <div class="tlt-out" data-c="burn"><strong data-o="flushed" class="tlt-num">0</strong><span>NEAR of mPOO flushed a week</span></div>
      </div>
      <p class="tlt-small"><b style="color:var(--mp-fg)">Paper hands pay.</b> Unstaking burns ${pct(EXIT_TAX)} of the TOILET you take out, every time, on that amount only.</p>
      <p class="tlt-small">Before swap costs. mPOO paid directly for credits joins the same split. <a href="/money">Live flows on Where the money goes →</a></p>
      <p><a class="mp-btn mp-btn-primary" href="/stake">Stake your TOILET →</a></p>
    </div>
  </section>

  <section class="tlt-sec" id="supply" aria-labelledby="tlt-supply-h">
    <div class="tlt-head">
      <p class="mp-eyebrow">Supply</p>
      <h3 id="tlt-supply-h">One billion. Then the tap’s off.</h3>
      <p>TOILET is only minted when a holder claims what their tiles earned. There’s no owner, no admin mint and no upgrade path. When the billion is reserved, earning stops for good.</p>
    </div>
    <div class="tlt-supply">
      <div class="mp-card">
        <p class="mp-eyebrow">Hard cap</p>
        <p class="tlt-cap">${fmt(TOILET_CAP)}</p>
        <p>TOILET earned is set aside against the cap the moment it accrues, so a late claimer never finds the cupboard bare.</p>
      </div>
      <div class="mp-card">
        <h4>Where TOILET goes</h4>
        <ul class="tlt-sinks">
          <li><b>Staked</b>Earns a share of the stall’s mPOO.</li>
          <li><b>Traded</b>An ordinary NEAR token. A buy or sell on the listed exchange can carry a small tax, like mPOO’s.</li>
          <li><b>Burned on unstake</b>${pct(EXIT_TAX)} of every unstaked amount goes up in smoke.</li>
          <li><b>Burned</b>Anyone can burn their own TOILET. Burns never reopen the cap.</li>
        </ul>
      </div>
    </div>
  </section>

  <p class="tlt-foot">The hero wall and the explorers use sample numbers. Pace, holdings and spending are inputs for thinking with, not forecasts, and nothing here promises a return. <span data-tlt-source></span></p>
</article>`;

/** Text for each live key, or null when the board hasn't confirmed it. */
export function liveValues(s: ToiletPageSnapshot): Record<string, string | null> {
  const e = s.emission;
  return {
    rate: e === null ? null : e.perCellSecond === 0n ? "Off" : formatAmount(perCellDay(e), TOILET_DECIMALS, { maxFraction: 2 }),
    rateNote: e === null ? null : e.perCellSecond === 0n ? "Earning is switched off on this board" : "TOILET per tile per day",
    accrued: e === null ? null : formatAmount(e.accruedTotal, TOILET_DECIMALS, { maxFraction: 2 }),
    remaining: e === null ? null : formatAmount(e.remaining, TOILET_DECIMALS, { maxFraction: 0 }),
    reserve: s.reserve === null ? null : `${formatAmount(s.reserve, MPOO_DECIMALS, { maxFraction: 2 })} mPOO`,
    burned: s.supply === null ? null : formatAmount(s.supply.burnedTotal, TOILET_DECIMALS, { maxFraction: 2 }),
    wet: s.tiers === null ? null : String(s.tiers.repaint_young_credits),
    dry: s.tiers === null ? null : String(s.tiers.repaint_base_credits),
    priceNote: s.nearPerCredit === null || s.tiers === null
      ? "At launch prices."
      : "At the board’s current prices.",
  };
}

export function mountToiletPage(root: HTMLElement, ctx: PageContext, overrides: Partial<ToiletPageDeps> = {}): PageDispose {
  const deps: ToiletPageDeps = { ...defaultDeps(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".tlt")!;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => page.querySelector<T>(sel)!;
  const out = (key: string) => q(`[data-o="${key}"]`);
  const input = (id: string) => q<HTMLInputElement>(`#tlt-${id}`);
  const cleanups: Array<() => void> = [];
  const intervals: number[] = [];
  let frame = 0;
  let disposed = false;
  let snapshot: ToiletPageSnapshot = EMPTY_PAGE;
  let loaded = false;
  const listen = (el: EventTarget, type: string, fn: EventListener) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  /* ——— Your TOILET ——— */
  const claimHost = q("[data-tlt-claim]");
  const claimConfig = { contractId: deps.board, toiletId: deps.toilet, network: deps.network, ...deps.claim };
  if (toiletConfigured(claimConfig)) {
    cleanups.push(mountToiletClaim(claimHost, ctx.services, claimConfig));
  } else {
    claimHost.innerHTML = `<h2 class="toilet-claim-h">Your TOILET</h2><p>This page isn’t connected to a board with TOILET, so there’s nothing to claim here.</p>`;
  }

  /* ——— Live values ——— */
  function applyLive(): void {
    const values = liveValues(snapshot);
    for (const el of page.querySelectorAll<HTMLElement>("[data-tl]")) {
      const v = values[el.dataset.tl!];
      // Prices fall back to the launch values already in the markup; figures show "…" until read.
      if (v !== null && v !== undefined) el.textContent = v;
      else if (!["wet", "dry"].includes(el.dataset.tl!)) el.textContent = loaded ? "Unavailable" : "…";
    }
    for (const el of page.querySelectorAll<HTMLElement>("[data-needs]")) {
      el.hidden = loaded && el.dataset.needs!.split(" ").some((k) => values[k] === null);
    }
    const liveYears = snapshot.emission ? yearsAtRate(snapshot.emission.perCellSecond) : null;
    const liveChip = q<HTMLButtonElement>("[data-years-live]");
    liveChip.hidden = liveYears === null;
    if (liveYears !== null) {
      liveChip.textContent = `The board’s rate · ${liveYears >= 2 ? `${fmt(liveYears, 1)} years` : `${Math.round(liveYears * 12)} months`}`;
      liveChip.dataset.years = String(liveYears);
    } else if (liveChip.getAttribute("aria-pressed") === "true") {
      pickYears(DEFAULT_YEARS);
    }
    q("[data-tlt-source]").textContent = !deps.configured
      ? "This preview isn’t connected to a board, so live numbers are hidden."
      : !loaded
        ? `Reading ${deps.board} on ${deps.network}…`
        : `Live numbers read from ${deps.board}${deps.toilet ? ` and ${deps.toilet}` : ""} on ${deps.network}. Anything they couldn’t confirm is left out, never guessed.`;
    // The board publishes its staking contract once `set_staking_contract` has been called.
    // Read it: claiming is live as soon as emission is, and staking is live as soon as this is set.
    const staking = snapshot.stakingContract ?? null;
    q("[data-tlt-live-h]").textContent = staking ? "Earning is live. Staking is open." : "Earning is live. Staking opens next.";
    q("[data-tlt-live-p]").textContent = staking
      ? `Paint with credits and your tiles start earning straight away. Staking is live on this board at ${staking}, funded and collecting the stakers’ share of the mPOO the stall takes in. The staking controls land on this page next.`
      : "Paint with credits and your tiles start earning straight away. Claim whenever you like: nothing is lost by waiting. Staking opens on this page once the staking contract is live.";
    q("[data-tlt-reserve-note]").textContent = staking
      ? `Forwarded to ${staking} with each distribution.`
      : "Held on the board until staking opens. Nobody can spend it, the owner included.";
    whale();
    resetMeter();
  }

  async function refresh(): Promise<void> {
    if (!deps.configured || disposed) return;
    const next = await deps.load().catch(() => EMPTY_PAGE);
    if (disposed) return;
    snapshot = next;
    loaded = true;
    applyLive();
  }

  /* ——— Earnings explorer ——— */
  let years = DEFAULT_YEARS;
  function earn(): void {
    const held = Number(input("tiles").value), hours = Number(input("survive").value), painted = Number(input("painted").value);
    out("tiles").textContent = fmt(held);
    out("survive").textContent = `${hours} h`;
    out("painted").textContent = fmt(painted);
    const r = earnOutcome({ years, held, hours, painted });
    out("you").textContent = smart(r.you);
    out("perTile").textContent = `${smart(r.perTileDay)} TOILET`;
    out("wallDay").textContent = `${fmt(r.wallDay)} TOILET`;
    out("minted").textContent = `${r.mintedPct.toFixed(1)}%`;
    out("runout").textContent = r.runYears >= 2 ? `${r.runYears.toFixed(1)} years` : `${Math.round(r.runYears * 12)} months`;
    const v = out("verdict");
    v.dataset.tone = r.tone;
    const p = r.mintedPct;
    const [head, body] = r.tone === "bad"
      ? ["Fast and dilutive.", `The wall mints ${p.toFixed(0)}% of supply a year. Stakers would need revenue worth ${p.toFixed(0)}% of TOILET’s value each year just to keep up, so most of what holders earn is new tokens, not money.`]
      : r.tone === "warn"
        ? ["Generous now, thinner later.", `${p.toFixed(0)}% of supply a year. Revenue has to match that share of TOILET’s value for staking to be paid by painters rather than by minting.`]
        : ["Revenue can keep up.", `${p.toFixed(1)}% of supply a year is a pace painter revenue can plausibly back. Smaller drips per tile, longer life.`];
    const b = document.createElement("b");
    b.textContent = head;
    v.replaceChildren(b, ` ${body}`);
  }
  function pickYears(next: number, chip?: HTMLElement): void {
    years = next;
    for (const x of page.querySelectorAll<HTMLElement>("[data-years], [data-years-live]")) {
      x.setAttribute("aria-pressed", String(chip ? x === chip : Number(x.dataset.years) === next && !x.hasAttribute("data-years-live")));
    }
    earn();
  }
  // The board's-rate chip gets its value once the board is read, so it's selected separately.
  for (const chip of page.querySelectorAll<HTMLElement>("[data-years], [data-years-live]")) {
    listen(chip, "click", () => pickYears(Number(chip.dataset.years), chip));
  }
  for (const id of ["tiles", "survive", "painted"]) listen(input(id), "input", earn);

  /* ——— Whale ——— */
  function whale(): void {
    const w = Number(input("whale").value), players = Number(input("pokers").value);
    const nearPerCredit = snapshot.nearPerCredit === null ? LAUNCH.nearPerCredit : Number(snapshot.nearPerCredit) / 1e24;
    const r = whaleOutcome({
      whaleTiles: w, players, nearPerCredit,
      wetCredits: snapshot.tiers?.repaint_young_credits ?? LAUNCH.wet,
      dryCredits: snapshot.tiers?.repaint_base_credits ?? LAUNCH.dry,
    });
    out("whale").textContent = `${fmt(w)} tiles · ${fmt(r.buyNear, 2)} NEAR`;
    out("pokers").textContent = `${fmt(players)} players`;
    out("share").textContent = pct(r.share);
    out("shareBar").style.width = `${r.share * 100}%`;
    out("answer").textContent = smart(r.answerNear);
    out("pokes").textContent = smart(r.pokeNear);
    out("fight").textContent = smart(r.stakersNear);
  }
  for (const id of ["whale", "pokers"]) listen(input(id), "input", whale);

  /* ——— Staking ——— */
  function stake(): void {
    const n = Number(input("spend").value), mine = Number(input("mine").value);
    out("spend").textContent = `${fmt(n)} NEAR`;
    out("mine").textContent = `${mine.toFixed(1)}%`;
    const r = stakeOutcome(n, mine / 100);
    out("pool").textContent = smart(r.pool);
    out("youWeek").textContent = smart(r.you);
    out("flushed").textContent = smart(r.flushed);
  }
  for (const id of ["spend", "mine"]) listen(input(id), "input", stake);

  /* ——— Hero: sample tiles change hands, your counter drips ——— */
  const wallEl = q("[data-tlt-wall]");
  const YOU = PALETTE[11].hex;
  const OTHERS = PALETTE.filter((c) => c.index !== 11 && c.index !== 0).map((c) => c.hex);
  const MINE = [14, 15, 16, 26, 27, 28, 38, 39, 40, 51, 52, 63];
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tiles = Array.from({ length: 12 * 7 }, (_, i) => {
    const el = document.createElement("div");
    el.className = "tlt-dt";
    const mine = MINE.includes(i);
    const color = mine ? YOU : OTHERS[Math.floor(rnd() * OTHERS.length)];
    el.style.background = color;
    el.classList.toggle("you", mine);
    wallEl.append(el);
    return { el, mine, color };
  });
  const mineCount = () => tiles.filter((t) => t.mine).length;
  function setTile(t: (typeof tiles)[number], mine: boolean, color: string): void {
    t.mine = mine;
    t.color = color;
    t.el.style.background = color;
    t.el.classList.toggle("you", mine);
    if (!deps.reducedMotion) {
      t.el.classList.remove("flash");
      void t.el.offsetWidth;
      t.el.classList.add("flash");
    }
    q("[data-tlt-tiles]").textContent = `${mineCount()} tiles`;
  }
  // Sample time runs 600× fast so the counter visibly moves.
  const SPEED = 600;
  let perTileSecond = 0;
  let earned = 0;
  let last = 0;
  function resetMeter(): void {
    const rate = snapshot.emission && snapshot.emission.perCellSecond > 0n ? Number(snapshot.emission.perCellSecond) / 1e18 : null;
    perTileSecond = rate ?? TOILET_CAP / (DEFAULT_YEARS * 365 * 86_400 * WALL_TILES);
    const pace = rate === null ? "4-year pace" : "board’s rate";
    q("[data-tlt-pace]").textContent = deps.reducedMotion ? `one hour, ${pace}` : `${pace}, ${SPEED}× speed`;
    if (deps.reducedMotion) q("[data-tlt-count]").textContent = fmt(mineCount() * perTileSecond * 3_600, 3);
  }
  function tick(now: number): void {
    if (disposed) return;
    const dt = last ? Math.min(1, (now - last) / 1000) : 0;
    last = now;
    if (!document.hidden) {
      earned += mineCount() * perTileSecond * dt * SPEED;
      q("[data-tlt-count]").textContent = fmt(earned, 3);
    }
    frame = requestAnimationFrame(tick);
  }
  const wet = () => snapshot.tiers?.repaint_young_credits ?? LAUNCH.wet;
  const dry = () => snapshot.tiers?.repaint_base_credits ?? LAUNCH.dry;
  const events: Array<() => string | null> = [
    () => { const t = tiles.find((x) => x.mine); if (!t) return null; setTile(t, false, PALETTE[14].hex); return "Someone painted over one of yours. That tile earns for them now."; },
    () => { const t = tiles.find((x) => !x.mine && x.color === PALETTE[14].hex) ?? tiles.find((x) => !x.mine)!; setTile(t, true, YOU); return `You painted it back. ${wet()} credits: their paint was still wet.`; },
    () => { const free = tiles.filter((x) => !x.mine); setTile(free[Math.floor(rnd() * free.length)], true, YOU); return `You took a dry tile for ${dry()} credit. One more tile earning.`; },
    () => { const mine = tiles.filter((x) => x.mine); setTile(mine[Math.floor(rnd() * mine.length)], false, OTHERS[Math.floor(rnd() * OTHERS.length)]); return "Lost another one. The wall never sleeps."; },
    () => { const free = tiles.filter((x) => !x.mine); setTile(free[Math.floor(rnd() * free.length)], true, YOU); return "Back on top."; },
  ];
  resetMeter();
  if (!deps.reducedMotion) {
    frame = requestAnimationFrame(tick);
    let ev = 0;
    intervals.push(window.setInterval(() => {
      if (document.hidden) return;
      const msg = events[ev++ % events.length]();
      if (msg) q("[data-tlt-log]").textContent = msg;
    }, 3200));
  }

  earn();
  whale();
  stake();
  applyLive();
  void refresh();
  if (deps.configured) {
    intervals.push(window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, deps.pollMs));
  }

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    intervals.forEach((id) => window.clearInterval(id));
    cleanups.forEach((fn) => fn());
    root.replaceChildren();
  };
}
