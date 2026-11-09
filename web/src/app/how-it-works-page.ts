/**
 * /how-it-works. Approved design: docs/visual-concepts/how-it-works-draft.html.
 *
 * Live numbers come from the board. Until a read confirms one, it shows "…"; if
 * the read fails, the number (or the sentence that needs it) is hidden, never
 * guessed. The sample-wall story and the practice wall are client-side only.
 */

import { PALETTE } from "@shared/palette.ts";
import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import type { PageContext, PageDispose } from "./page-registry";
import { MPOO_SPLIT, NEAR_SPLIT, createRpcView } from "./revenue-panel";
import {
  EMPTY_SNAPSHOT, wallTiles, durationText, happyHourClock, loadHowItWorks, minutesText, nearText,
  practicePrices, practiceReceipt, practiceTier, spendOutcome, utcClock, weekdayName,
  type HowItWorksSnapshot, type PracticeCell, type PracticePhase,
} from "./how-it-works";
import { STORY, practiceSeed, type StoryPixel } from "./how-it-works-story";
import "./how-it-works.css";

export interface HowItWorksDeps {
  load: () => Promise<HowItWorksSnapshot>;
  now: () => number;
  configured: boolean;
  network: string;
  board: string;
  reducedMotion: boolean;
  /** How often live numbers are re-read. */
  pollMs: number;
}

function defaultDeps(): HowItWorksDeps {
  const view = createRpcView(RPC_URL);
  return {
    load: () => loadHowItWorks(view, CONTRACT_ID),
    now: () => Date.now(),
    configured: !!CONTRACT_ID,
    network: PAGE_NETWORK,
    board: CONTRACT_ID,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    pollMs: 60_000,
  };
}

const MAX_STROKE = 64;
const COLS = 16;
const ROWS = 10;
const near = (n: number) => `${(Math.round(n * 1e4) / 1e4).toLocaleString(undefined, { maximumFractionDigits: 4 })} NEAR`;
const pct = (n: number) => `${Math.round(n)}%`;
const OUTCOME = spendOutcome(100);

const TEMPLATE = `
<article class="hiw" aria-labelledby="hiw-title">
  <header class="hiw-hero">
    <div class="hiw-hero-copy">
      <p class="mp-eyebrow">How it works</p>
      <h2 id="hiw-title" data-route-heading="true">The only public stall on the whole internet.</h2>
      <p class="hiw-lede">One wall, open to everyone on earth. An AI agent can paint here too: <a href="/agents">hand yours the link</a>. Write your name, draw something rude, leave a love note, cross out somebody else’s. Come back tomorrow and see what survived.</p>
      <section class="hiw-rules" aria-labelledby="hiw-rules-h">
        <h3 id="hiw-rules-h">Rules of the stall</h3>
        <ol>
          <li><span><a href="#hiw-paint">Leave your mark.</a> Every tile you paint stays until someone paints over it.</span></li>
          <li><span><a href="#hiw-paint">Wet paint costs more to cover.</a><span data-needs="tiers"> Fresh work is protected for <span data-hiw="midWin">…</span>.</span></span></li>
          <li data-fill="open" data-needs="freeFirst"><span><a href="#hiw-free">Your first <span data-hiw="freeFirst">…</span> tiles are free</a> while the wall fills up.</span></li>
          <li data-fill="done" hidden><span><a href="#hiw-free">Paint free in the weekly happy hour.</a> The wall is full, so free first paints are over.</span></li>
          <li><span><a href="#hiw-stall">The stall runs itself.</a> Nobody pockets what it earns.</span></li>
          <li class="hiw-wash"><span>Wash your hands.</span></li>
        </ol>
      </section>
    </div>
    <figure class="hiw-demo">
      <div class="hiw-canvas-box">
        <canvas data-hiw-canvas width="128" height="128" aria-label="A sample wall: art gets painted, vandalised and painted back"></canvas>
        <span class="hiw-canvas-tag" data-hiw-tag>Sample wall · day 1</span>
      </div>
      <ol class="hiw-log" data-hiw-log aria-live="polite" aria-label="What just happened on the sample wall"></ol>
    </figure>
  </header>

  <section class="hiw-sec" id="hiw-paint" aria-labelledby="hiw-paint-h">
    <div class="hiw-head">
      <p class="mp-eyebrow">Painting · try it</p>
      <h3 id="hiw-paint-h">Wet paint costs more to cover.</h3>
      <p data-needs="tiers">You paint with credits. A dry or empty tile costs <span data-hiw="base">…</span>. Paint less than <span data-hiw="midWin">…</span> old costs <span data-hiw="mid">…</span> to cover, and paint less than <span data-hiw="youngWin">…</span> old costs <span data-hiw="young">…</span>. New work gets a moment on the wall before someone wipes it.</p>
      <p data-unless="tiers" hidden>You paint with credits. Fresh paint costs more to cover than dry paint, so new work gets a moment on the wall before someone wipes it.</p>
    </div>
    <div class="hiw-prices" aria-label="What credits cost">
      <span class="hiw-price" data-needs="price"><b data-hiw="price">…</b> per credit</span>
      <span class="hiw-price"><b>−20%</b> paying in mPOO</span>
      <span class="hiw-price" data-needs="regFee"><b data-hiw="regFee">…</b> once, to open your account</span>
      <span class="hiw-price"><b>${MAX_STROKE}</b> tiles per stroke</span>
    </div>
    <div class="hiw-ladder" aria-label="Repaint prices" data-needs="tiers">
      <div class="hiw-rung" data-t="young"><strong><span data-hiw="young">…</span> credits</strong><span>wet: painted under <span data-hiw="youngWin">…</span> ago</span></div>
      <div class="hiw-rung" data-t="mid"><strong><span data-hiw="mid">…</span> credits</strong><span>drying: painted less than <span data-hiw="midWin">…</span> ago</span></div>
      <div class="hiw-rung" data-t="base"><strong><span data-hiw="base">…</span> credit</strong><span>dry, or never painted</span></div>
    </div>

    <div class="hiw-play">
      <div class="hiw-controls">
        <div class="hiw-seg" role="group" aria-label="Wall phase">
          <span class="hiw-seg-label">Phase</span>
          <button class="mp-chip" type="button" data-phase="filling" aria-pressed="false">Still filling</button>
          <button class="mp-chip" type="button" data-phase="normal" aria-pressed="true">Normal day</button>
          <button class="mp-chip" type="button" data-phase="happy" aria-pressed="false">Happy hour</button>
        </div>
        <div class="hiw-seg" role="group" aria-label="Wall view">
          <span class="hiw-seg-label">View</span>
          <button class="mp-chip" type="button" data-view="art" aria-pressed="false">Art</button>
          <button class="mp-chip" type="button" data-view="price" aria-pressed="true">Price</button>
          <button class="mp-chip" type="button" data-view="age" aria-pressed="false">Age</button>
        </div>
      </div>
      <p class="hiw-note" data-hiw-note role="status"></p>

      <div class="hiw-wallbox">
        <div class="hiw-bar">
          <p class="hiw-clock" data-hiw-clock>Sample clock <span>· 0 min</span></p>
          <div class="hiw-btns">
            <button class="mp-btn" type="button" data-skip="5">Wait 5 min</button>
            <button class="mp-btn" type="button" data-skip="30">Wait 30 min</button>
          </div>
        </div>
        <div class="hiw-grid" data-hiw-grid data-view="price" aria-label="Practice wall. Click or drag across tiles to add them to your stroke."></div>
        <div class="hiw-legend" data-hiw-legend aria-hidden="true"></div>
      </div>

      <aside class="hiw-side mp-card" aria-label="Your practice stroke">
        <h4>Your stroke</h4>
        <div class="hiw-palette" data-hiw-palette role="group" aria-label="Colour"></div>
        <p class="hiw-pick" data-hiw-pick></p>
        <dl class="hiw-receipt">
          <div><dt>Tiles selected</dt><dd data-r="cells">0 / ${MAX_STROKE}</dd></div>
          <div><dt>Free tiles</dt><dd data-r="free">0</dd></div>
          <div><dt>Credits</dt><dd data-r="credits">0</dd></div>
          <div class="hiw-total" data-needs="price"><dt>Costs about</dt><dd data-r="near">0 NEAR</dd></div>
        </dl>
        <p class="hiw-info" data-hiw-info>Drag across the wall to pick tiles. Hover a tile to see how wet it is.</p>
        <div class="hiw-btns">
          <button class="mp-btn mp-btn-primary" type="button" data-hiw-paint disabled>Paint stroke</button>
          <button class="mp-btn" type="button" data-hiw-clear disabled>Clear</button>
        </div>
        <p class="hiw-small" data-hiw-practice-source>Practice only. Nothing here touches the real wall or your wallet.</p>
      </aside>
    </div>
  </section>

  <section class="hiw-sec hiw-hype" id="hiw-free" aria-labelledby="hiw-free-h">
    <div class="hiw-hype-top">
      <div class="hiw-hype-copy" data-fill="open">
        <p class="mp-eyebrow">Free paint</p>
        <h3 id="hiw-free-h">Get on the wall <em>before it fills.</em></h3>
        <p data-needs="freeFirst">Every new account gets <span data-hiw="freeFirst">…</span> tiles on the house. No credits needed. Open your account and start painting today.</p>
        <p>When the last of the ${wallTiles().toLocaleString("en-US")} tiles gets its first coat, free paint ends for good. The wall gets made by whoever shows up first. Be one of them.</p>
        <a class="mp-btn mp-btn-primary hiw-cta" href="/"><span data-needs="freeFirst">Grab your <span data-hiw="freeFirst">…</span> tiles →</span><span data-unless="freeFirst" hidden>Start painting →</span></a>
      </div>
      <div class="hiw-hype-copy" data-fill="done" hidden>
        <p class="mp-eyebrow">Free paint</p>
        <h3>The wall is full. <em>Now it’s a turf war.</em></h3>
        <p>Every tile has had its first coat, so free first paints are over for good. Happy hour is how you paint for free now.</p>
        <a class="mp-btn mp-btn-primary hiw-cta" href="/">Go to the wall →</a>
      </div>
      <div class="hiw-count" data-needs="painted">
        <strong data-hiw="blank">…</strong>
        <span>tiles still blank</span>
        <div class="hiw-meter" role="img" data-hiw-meter-label><i data-hiw-meter></i></div>
        <p class="hiw-meter-row"><span><span data-hiw="painted">…</span> / ${wallTiles().toLocaleString("en-US")} painted</span><span data-hiw="pct">…</span></p>
      </div>
    </div>
    <div class="hiw-hype-cols" data-needs="happy">
      <div class="mp-card">
        <h4>Then every <span data-hiw="hhDay">…</span>, happy hour.</h4>
        <p>Once the wall is full, the stall opens free painting for <span data-hiw="hhLength">…</span> each week. Every dry tile costs nothing, up to <span data-hiw="hhCap">…</span> tiles each, <span data-hiw="hhWho">…</span>.</p>
        <div class="hiw-week" data-hiw-week aria-hidden="true"></div>
      </div>
      <div class="mp-card">
        <h4>Next happy hour</h4>
        <p class="hiw-hh-clock" data-hiw-hh-clock>…</p>
        <p class="hiw-hh-when" data-hiw-hh-when></p>
        <p class="hiw-small">Free tiles earn no TOILET until someone repaints them with credits.</p>
      </div>
    </div>
  </section>

  <section class="hiw-sec" id="hiw-stall" aria-labelledby="hiw-stall-h">
    <div class="hiw-head">
      <p class="mp-eyebrow">The autonomous stall</p>
      <h3 id="hiw-stall-h">The stall runs itself.</h3>
      <p>Once you buy credits, that money belongs to the game. It doesn’t sit in anyone’s wallet. The contract holds it and sends it out on a schedule, along lines nobody can redraw. Here’s what the stall does with what it earns.</p>
    </div>
    <div class="hiw-flow">
      <div class="hiw-step" data-c="near"><p class="hiw-k">1 · It earns</p><h4>Painters buy credits</h4><p>NEAR and mPOO land on the board. ${NEAR_SPLIT.team}% of the NEAR goes to the team.</p></div>
      <div class="hiw-step" data-c="mpoo"><p class="hiw-k">2 · It buys mPOO</p><h4>${NEAR_SPLIT.buyback}% of NEAR buys back</h4><p>The buyback swaps NEAR for mPOO on the market and hands it back to the stall.</p></div>
      <div class="hiw-step" data-c="stake"><p class="hiw-k">3 · It pays stakers</p><h4>${MPOO_SPLIT.stakers}% of mPOO</h4><p>Goes to people staking TOILET. ${MPOO_SPLIT.team}% goes to the team.</p></div>
      <div class="hiw-step" data-c="burn"><p class="hiw-k">4 · It flushes</p><h4>${MPOO_SPLIT.burn}% of mPOO</h4><p>Sent to an address with no key. It never comes back.</p></div>
    </div>
    <div class="mp-card hiw-sim">
      <div class="hiw-sim-top">
        <label for="hiw-spend">If painters spend this much NEAR in a week</label>
        <output for="hiw-spend" data-hiw-spend-out>100 NEAR</output>
        <input id="hiw-spend" type="range" min="10" max="2000" step="10" value="100">
      </div>
      <div class="hiw-outs">
        <div class="hiw-out" data-c="stake"><strong data-o="stakers">63</strong><span>NEAR of mPOO to TOILET stakers</span></div>
        <div class="hiw-out" data-c="burn"><strong data-o="flushed">18</strong><span>NEAR of mPOO flushed forever</span></div>
        <div class="hiw-out" data-c="team"><strong data-o="team">19</strong><span>NEAR to the team, part in mPOO</span></div>
      </div>
      <div class="hiw-split" aria-label="Of every NEAR: ${pct(OUTCOME.stakers)} stakers, ${pct(OUTCOME.flushed)} flushed, ${pct(OUTCOME.team)} team">
        <span data-c="stake" style="flex:${OUTCOME.stakers}">${pct(OUTCOME.stakers)} stakers</span>
        <span data-c="burn" style="flex:${OUTCOME.flushed}">${pct(OUTCOME.flushed)} flush</span>
        <span data-c="team" style="flex:${OUTCOME.team}">${pct(OUTCOME.team)} team</span>
      </div>
      <p class="hiw-small">Before swap costs. mPOO paid directly for credits skips the buyback and splits ${MPOO_SPLIT.team} / ${MPOO_SPLIT.stakers} / ${MPOO_SPLIT.burn} straight away. <a href="/money">Watch it happen live on Where the money goes →</a></p>
    </div>
  </section>

  <section class="hiw-sec" aria-labelledby="hiw-fair-h">
    <div class="hiw-head">
      <p class="mp-eyebrow">House rules, enforced by code</p>
      <h3 id="hiw-fair-h">Not even the owner can rig the stall.</h3>
      <p>The owner can tune a few knobs. The contract decides how far and how fast, and every change is a public transaction.</p>
    </div>
    <div class="hiw-limits">
      <div><h4>No price shocks</h4><p>Prices can at most double or halve per change, once every 24 hours. Repaint prices count too.</p></div>
      <div><h4>Wet paint stays protected</h4><p>Covering a tile tops out at 8 credits, and fresher paint always costs at least as much as dry.</p></div>
      <div><h4>No surprise happy hours</h4><p>Ending one is instant. Starting, moving or growing one waits 24 hours.</p></div>
      <div><h4>The split is welded on</h4><p>${NEAR_SPLIT.team} / ${NEAR_SPLIT.buyback} for NEAR, ${MPOO_SPLIT.team} / ${MPOO_SPLIT.stakers} / ${MPOO_SPLIT.burn} for mPOO. Changing it takes a new contract and a review.</p></div>
      <div><h4>Payout accounts move slowly</h4><p>Team and buyback accounts can change once a week, in public. The staking contract is set once, ever.</p></div>
      <div><h4>One emergency stop</h4><p>The owner can pause painting and buying. The wall stays readable and payouts keep flowing.</p></div>
    </div>
  </section>

  <section class="hiw-next" aria-labelledby="hiw-next-h">
    <p class="mp-eyebrow">Coming next</p>
    <h4 id="hiw-next-h">Tiles that earn TOILET</h4>
    <p>Tiles you paint with credits will earn TOILET for as long as they survive on the wall. Stake TOILET and you take a share of everything the stall earns. Earning switches on in a later round.</p>
    <p><a href="/toilet">How TOILET works →</a></p>
  </section>

  <p class="hiw-foot" data-hiw-source role="status"></p>
</article>`;

/** Text for each live key, or null when the board hasn't confirmed it. */
export function liveValues(s: HowItWorksSnapshot): Record<string, string | null> {
  const t = s.tiers, hh = s.happyHour;
  const blank = s.painted === null ? null : wallTiles() - s.painted;
  return {
    price: s.nearPerCredit === null ? null : `${nearText(s.nearPerCredit)} NEAR`,
    regFee: s.registrationFee === null ? null : `${nearText(s.registrationFee)} NEAR`,
    tiers: t ? "yes" : null,
    young: t ? String(t.repaint_young_credits) : null,
    mid: t ? String(t.repaint_mid_credits) : null,
    base: t ? String(t.repaint_base_credits) : null,
    youngWin: t ? minutesText(t.repaint_young_ns) : null,
    midWin: t ? minutesText(t.repaint_mid_ns) : null,
    freeFirst: s.freeFirstPerAccount === null || s.freeFirstPerAccount === 0 ? null : String(s.freeFirstPerAccount),
    painted: s.painted === null ? null : s.painted.toLocaleString("en-US"),
    blank: blank === null ? null : blank.toLocaleString("en-US"),
    pct: s.painted === null ? null : `${Math.floor((s.painted / wallTiles()) * 100)}%`,
    happy: hh ? "yes" : null,
    hhDay: hh ? weekdayName(hh.weekday) : null,
    hhLength: hh ? durationText(hh.lengthS).replace(/^one /, "an ") : null,
    hhCap: hh ? String(hh.cap) : null,
    hhWho: hh ? (hh.requiresPurchase ? "for anyone who has bought credits before" : "for anyone with a credit account") : null,
  };
}

export function mountHowItWorksPage(root: HTMLElement, _ctx: PageContext, overrides: Partial<HowItWorksDeps> = {}): PageDispose {
  const deps: HowItWorksDeps = { ...defaultDeps(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".hiw")!;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => page.querySelector<T>(sel)!;
  const intervals: number[] = [];
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let snapshot: HowItWorksSnapshot = EMPTY_SNAPSHOT;
  let loaded = false;
  const listen = (el: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };
  const every = (ms: number, fn: () => void) => { intervals.push(window.setInterval(fn, ms)); };

  /* ——— Live values ——— */
  function applyLive(): void {
    const values = liveValues(snapshot);
    for (const el of page.querySelectorAll<HTMLElement>("[data-hiw]")) {
      const key = el.dataset.hiw!;
      el.textContent = values[key] ?? "…";
    }
    // While loading, show "…"; once read, hide whatever the board couldn't confirm.
    for (const el of page.querySelectorAll<HTMLElement>("[data-needs]")) {
      el.hidden = loaded && el.dataset.needs!.split(" ").some((k) => values[k] === null);
    }
    for (const el of page.querySelectorAll<HTMLElement>("[data-unless]")) {
      el.hidden = !loaded || values[el.dataset.unless!] !== null;
    }
    const full = snapshot.firstFillComplete === true;
    for (const el of page.querySelectorAll<HTMLElement>("[data-fill]")) {
      const show = el.dataset.fill === (full ? "done" : "open");
      if (!show) el.hidden = true;
      else if (!el.hasAttribute("data-needs")) el.hidden = false;
    }
    const painted = snapshot.painted;
    if (painted !== null) {
      q("[data-hiw-meter]").style.width = `${(painted / wallTiles()) * 100}%`;
      q("[data-hiw-meter-label]").setAttribute("aria-label", `${painted.toLocaleString("en-US")} of ${wallTiles().toLocaleString("en-US")} tiles painted`);
    }
    const week = q("[data-hiw-week]");
    week.replaceChildren();
    if (snapshot.happyHour) {
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d, i) => {
        const span = document.createElement("span");
        span.textContent = d;
        if (i === snapshot.happyHour!.weekday) span.className = "on";
        week.append(span);
      });
    }
    renderHappyHour();
    const source = q("[data-hiw-source]");
    source.textContent = !deps.configured
      ? "This preview isn’t connected to a board, so live numbers are hidden. The sample wall and the practice wall are examples."
      : !loaded
        ? `Reading ${deps.board} on ${deps.network}…`
        : `Numbers read live from ${deps.board} on ${deps.network}. Anything the board couldn’t confirm is left out, never guessed. The sample wall and the practice wall are examples.`;
    prices = practicePrices(snapshot.tiers);
    freeStart = { first: snapshot.freeFirstPerAccount ?? 25, happy: snapshot.happyHour?.cap ?? 100 };
    q("[data-hiw-practice-source]").textContent = snapshot.tiers
      ? "Practice only, at the board’s real prices. Nothing here touches the real wall or your wallet."
      : "Practice only, at launch prices. Nothing here touches the real wall or your wallet.";
    renderAll();
  }

  function renderHappyHour(): void {
    const hh = snapshot.happyHour;
    const clockEl = q("[data-hiw-hh-clock]"), whenEl = q("[data-hiw-hh-when]");
    if (!hh) return;
    if (!hh.enabled) {
      clockEl.textContent = snapshot.firstFillComplete === true ? "Switched off for now" : "Starts once the wall is full";
    } else {
      clockEl.textContent = happyHourClock(deps.now(), hh).label;
    }
    const startMs = happyHourClock(deps.now(), hh).startMs;
    const local = new Date(startMs).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    whenEl.textContent = `${weekdayName(hh.weekday)}s ${utcClock(hh.startS)} · ${local} for you`;
  }

  async function refresh(): Promise<void> {
    if (!deps.configured || disposed) return;
    const next = await deps.load().catch(() => EMPTY_SNAPSHOT);
    if (disposed) return;
    snapshot = next;
    loaded = true;
    applyLive();
  }

  /* ——— Hero: the sample wall ——— */
  const canvas = q<HTMLCanvasElement>("[data-hiw-canvas]");
  const ctx2d = canvas.getContext?.("2d") ?? null;
  const logEl = q("[data-hiw-log]");
  const tagEl = q("[data-hiw-tag]");
  const token = (name: string) => getComputedStyle(page).getPropertyValue(name).trim();
  function blankWall(): void {
    if (!ctx2d) return;
    const tile = token("--mp-card") || "transparent", grout = token("--mp-card-2") || tile;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      ctx2d.fillStyle = x % 8 === 0 || y % 8 === 0 ? grout : tile;
      ctx2d.fillRect(x, y, 1, 1);
    }
  }
  const put = ([x, y, c]: StoryPixel) => {
    if (!ctx2d || x < 0 || x >= 128 || y < 0 || y >= 128) return;
    ctx2d.fillStyle = PALETTE[c].hex;
    ctx2d.fillRect(x, y, 1, 1);
  };
  const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  function log(at: number, say: string, day: number, animate: boolean): void {
    const li = document.createElement("li");
    if (animate) li.className = "new";
    const time = document.createElement("time");
    time.textContent = `Day ${day} · ${hhmm(at)}`;
    const span = document.createElement("span");
    span.textContent = say;
    li.append(time, span);
    logEl.prepend(li);
    while (logEl.children.length > 3) logEl.lastElementChild!.remove();
    tagEl.textContent = `Sample wall · day ${day}`;
  }
  blankWall();
  if (deps.reducedMotion) {
    STORY.forEach((ev) => ev.px().forEach(put));
    STORY.slice(-3).forEach((ev) => log(ev.at, ev.say, 1, false));
  } else {
    let day = 1, step = 0, wait = 6;
    let queue: StoryPixel[] = [];
    every(90, () => {
      if (document.hidden) return;
      if (wait > 0) { wait -= 1; return; }
      if (!queue.length) {
        if (step >= STORY.length) {
          step = 0; day += 1; blankWall(); logEl.replaceChildren();
          log(0, "The demo starts over. The real wall never resets.", day, true);
          wait = 18;
          return;
        }
        const ev = STORY[step++];
        queue = ev.px();
        log(ev.at, ev.say, day, true);
      }
      // One stroke is at most 64 tiles, like the real wall.
      queue.splice(0, MAX_STROKE).forEach(put);
      if (!queue.length) wait = 14;
    });
  }

  /* ——— The practice wall ——— */
  const gridEl = q("[data-hiw-grid]");
  let prices = practicePrices(null);
  let freeStart = { first: 25, happy: 100 };
  let free = { ...freeStart };
  let freeTouched = false;
  let clock = 0;
  let phase: PracticePhase = "normal";
  let view: "art" | "price" | "age" = "price";
  let pick = PALETTE.findIndex((c) => c.name === "Bubblegum");
  const cells: Array<PracticeCell & { el: HTMLButtonElement }> = practiceSeed(COLS, ROWS).map((c) => ({ ...c, el: document.createElement("button") }));
  const selected = new Set<number>();

  cells.forEach((cell, i) => {
    const b = cell.el;
    b.type = "button";
    b.className = "hiw-cell";
    b.dataset.i = String(i);
    b.tabIndex = i === 0 ? 0 : -1;
    if (i % COLS >= 12) b.classList.add("hiw-wide");
    gridEl.append(b);
  });

  const budget = () => (freeTouched ? free : freeStart);
  function shownPrice(i: number): number {
    return practiceReceipt([cells[i]], clock, phase, prices, budget()).credits;
  }
  const tierVar = (credits: number) => credits === 0 ? "var(--mp-near)" : credits === prices.young ? "var(--mp-burn)"
    : credits === prices.mid ? "var(--mp-tag)" : "var(--mp-stake)";

  function renderCell(i: number): void {
    const cell = cells[i], el = cell.el, p = shownPrice(i);
    el.classList.toggle("is-blank", cell.color === null);
    el.classList.toggle("is-sel", selected.has(i));
    el.classList.remove("is-dark-text");
    el.style.boxShadow = "";
    el.style.setProperty("--hiw-pick", PALETTE[pick].hex);
    if (view === "age") {
      if (cell.color === null || cell.at === null) { el.style.background = ""; el.textContent = ""; }
      else {
        const age = clock - cell.at;
        el.style.background = age < prices.youngMin ? "var(--mp-burn)" : age < prices.midMin ? "var(--mp-tag)" : "var(--mp-team)";
        el.classList.add("is-dark-text");
        el.textContent = age < 60 ? String(age) : `${Math.floor(age / 60)}h`;
      }
    } else {
      el.style.background = cell.color === null ? "" : PALETTE[cell.color].hex;
      el.textContent = view === "price" ? String(p) : "";
      if (view === "price") el.style.boxShadow = `inset 0 -3px 0 ${tierVar(p)}`;
    }
    const name = cell.color === null ? "Blank tile" : `${PALETTE[cell.color].name} tile`;
    el.setAttribute("aria-label", `${name}, costs ${p} credit${p === 1 ? "" : "s"}${selected.has(i) ? ", selected" : ""}`);
  }

  function renderReceipt(): void {
    const r = practiceReceipt([...selected].map((i) => cells[i]), clock, phase, prices, budget());
    q("[data-r=cells]").textContent = `${r.cells} / ${MAX_STROKE}`;
    q("[data-r=free]").textContent = String(r.free);
    q("[data-r=credits]").textContent = String(r.credits);
    q("[data-r=near]").textContent = snapshot.nearPerCredit === null ? "" : near(r.credits * Number(snapshot.nearPerCredit) / 1e24);
    q<HTMLButtonElement>("[data-hiw-paint]").disabled = selected.size === 0;
    q<HTMLButtonElement>("[data-hiw-clear]").disabled = selected.size === 0;
  }

  function renderLegend(): void {
    const el = q("[data-hiw-legend]");
    el.replaceChildren();
    const items: Array<[string, string, string]> = view === "price"
      ? [["burn", String(prices.young), "wet"], ["tag", String(prices.mid), "drying"], ["stake", String(prices.base), "dry"], ["near", "0", "free"]]
      : view === "age"
        ? [["burn", "min", `under ${prices.youngMin}`], ["tag", "min", `${prices.youngMin}–${prices.midMin}`], ["team", "h", "older"]]
        : [];
    for (const [c, label, text] of items) {
      const span = document.createElement("span");
      const i = document.createElement("i");
      i.dataset.c = c;
      i.textContent = label;
      span.append(i, text);
      el.append(span);
    }
  }

  function renderClock(): void {
    const h = Math.floor(clock / 60), m = clock % 60;
    q("[data-hiw-clock]").innerHTML = `Sample clock <span>· ${h ? `${h} h ` : ""}${m} min</span>`;
  }

  function note(): string {
    const b = budget();
    if (phase === "filling") return `The wall isn’t full yet, so blank tiles are free until you’ve used your free paints. ${b.first} left in this practice.`;
    if (phase === "happy") return `Happy hour: every dry tile is free, up to ${freeStart.happy} each. Wet and drying paint still costs. ${b.happy} free left in this practice.`;
    return "Every tile costs credits. See the wet pink tag? Wait a bit and it gets cheaper to cover.";
  }

  function renderAll(): void {
    cells.forEach((_, i) => renderCell(i));
    renderReceipt();
    renderClock();
    renderLegend();
    gridEl.dataset.view = view;
    q("[data-hiw-note]").textContent = note();
  }

  const info = (t: string) => { q("[data-hiw-info]").textContent = t; };
  function describe(i: number): void {
    const cell = cells[i], p = shownPrice(i);
    const age = cell.at === null ? null : clock - cell.at;
    const what = cell.color === null || age === null ? "Blank tile"
      : `${PALETTE[cell.color].name}, painted ${age < 60 ? `${age} min` : `${Math.floor(age / 60)} h ${age % 60} min`} ago`;
    const tier = practiceTier(cell, clock, prices);
    const why = p === 0 ? (phase === "happy" ? "free in happy hour" : "free first paint")
      : cell.color === null ? "never painted" : tier === prices.young ? "still wet" : tier === prices.mid ? "drying" : "dry";
    info(`${what} · ${p} credit${p === 1 ? "" : "s"} (${why})`);
  }

  function toggle(i: number, add: boolean): void {
    if (add && !selected.has(i)) {
      if (selected.size >= MAX_STROKE) { info(`A stroke holds at most ${MAX_STROKE} tiles. Paint this one, then start another.`); return; }
      selected.add(i);
    } else if (!add) selected.delete(i);
    renderCell(i);
    renderReceipt();
  }

  let dragging = false, dragAdd = true;
  const cellAt = (e: PointerEvent): number | null => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null;
    return el && el.classList.contains("hiw-cell") && gridEl.contains(el) ? Number(el.dataset.i) : null;
  };
  listen(gridEl, "pointerdown", ((e: PointerEvent) => {
    const i = cellAt(e) ?? (e.target instanceof HTMLElement && e.target.dataset.i ? Number(e.target.dataset.i) : null);
    if (i === null) return;
    e.preventDefault();
    dragging = true;
    dragAdd = !selected.has(i);
    toggle(i, dragAdd);
    describe(i);
  }) as EventListener);
  listen(gridEl, "pointermove", ((e: PointerEvent) => {
    const i = cellAt(e);
    if (i === null) return;
    if (dragging) toggle(i, dragAdd);
    describe(i);
  }) as EventListener);
  listen(window, "pointerup", () => { dragging = false; });
  listen(window, "pointercancel", () => { dragging = false; });
  listen(gridEl, "keydown", ((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (!target.dataset.i) return;
    const i = Number(target.dataset.i);
    const cols = getComputedStyle(gridEl).gridTemplateColumns.split(" ").filter(Boolean).length || COLS;
    const x = i % COLS, y = Math.floor(i / COLS);
    const mv = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (mv) {
      e.preventDefault();
      const n = Math.min(ROWS - 1, Math.max(0, y + mv[1])) * COLS + Math.min(cols - 1, Math.max(0, x + mv[0]));
      cells[i].el.tabIndex = -1;
      cells[n].el.tabIndex = 0;
      cells[n].el.focus();
      describe(n);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle(i, !selected.has(i));
      describe(i);
    }
  }) as EventListener);

  listen(q("[data-hiw-paint]"), "click", () => {
    const stroke = [...selected];
    const r = practiceReceipt(stroke.map((i) => cells[i]), clock, phase, prices, budget());
    free = r.budget;
    freeTouched = true;
    for (const i of stroke) {
      cells[i].color = pick;
      cells[i].at = clock;
      if (!deps.reducedMotion) {
        cells[i].el.classList.remove("is-just");
        void cells[i].el.offsetWidth;
        cells[i].el.classList.add("is-just");
      }
    }
    selected.clear();
    renderAll();
    info(`Painted ${r.cells} tile${r.cells === 1 ? "" : "s"} for ${r.credits} credit${r.credits === 1 ? "" : "s"}. The paint is wet: covering it costs ${prices.young} a tile for the next ${prices.youngMin} minutes.`);
  });
  listen(q("[data-hiw-clear]"), "click", () => { selected.clear(); renderAll(); info("Selection cleared."); });
  for (const b of page.querySelectorAll<HTMLButtonElement>("[data-skip]")) {
    listen(b, "click", () => {
      clock += Number(b.dataset.skip);
      renderAll();
      info(`${b.dataset.skip} minutes later. The paint is drying and getting cheaper to cover.`);
    });
  }
  for (const b of page.querySelectorAll<HTMLButtonElement>("[data-phase]")) {
    listen(b, "click", () => {
      phase = b.dataset.phase as PracticePhase;
      for (const x of page.querySelectorAll("[data-phase]")) x.setAttribute("aria-pressed", String(x === b));
      renderAll();
    });
  }
  for (const b of page.querySelectorAll<HTMLButtonElement>("button[data-view]")) {
    listen(b, "click", () => {
      view = b.dataset.view as typeof view;
      for (const x of page.querySelectorAll("button[data-view]")) x.setAttribute("aria-pressed", String(x === b));
      renderAll();
    });
  }

  const paletteEl = q("[data-hiw-palette]");
  PALETTE.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hiw-swatch";
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute("aria-label", c.name);
    b.setAttribute("aria-pressed", String(i === pick));
    listen(b, "click", () => {
      pick = i;
      for (const s of paletteEl.querySelectorAll("button")) s.setAttribute("aria-pressed", String(s === b));
      q("[data-hiw-pick]").textContent = `Colour ${i} · ${c.name}`;
      renderAll();
    });
    paletteEl.append(b);
  });
  q("[data-hiw-pick]").textContent = `Colour ${pick} · ${PALETTE[pick].name}`;

  /* ——— The autonomous stall ——— */
  const spend = q<HTMLInputElement>("#hiw-spend");
  const fmt = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
  function renderSpend(): void {
    const n = Number(spend.value);
    q("[data-hiw-spend-out]").textContent = `${n.toLocaleString()} NEAR`;
    const o = spendOutcome(n);
    q("[data-o=stakers]").textContent = fmt(o.stakers);
    q("[data-o=flushed]").textContent = fmt(o.flushed);
    q("[data-o=team]").textContent = fmt(o.team);
  }
  listen(spend, "input", renderSpend);
  renderSpend();

  /* ——— Start ——— */
  applyLive();
  every(1000, () => { if (!document.hidden && snapshot.happyHour) renderHappyHour(); });
  if (deps.configured) {
    void refresh();
    every(deps.pollMs, () => { if (!document.hidden) void refresh(); });
  }

  return () => {
    disposed = true;
    intervals.forEach((id) => window.clearInterval(id));
    cleanups.forEach((fn) => fn());
    page.remove();
  };
}
