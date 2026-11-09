/**
 * /agents — "Give this to your agent" and the story around it.
 *
 * Spec: docs/implementation/2026-11-09-agents-page-spec.md. The mechanics are in
 * `/skill.md`; this page carries the prompt, the live prices and the safety story.
 *
 * Live numbers come from the board. Until a read confirms one it shows "…"; if the
 * read fails, the line that needs it is hidden, never guessed.
 */

import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import type { PageContext, PageDispose } from "./page-registry";
import { createRpcView } from "./revenue-panel";
import { agentPrompt, EMPTY_COSTS, EXAMPLE_TILES, loadAgentsCosts, priceLines, type AgentsCosts, type View } from "./agents";
import "./agents.css";

export interface AgentsPageDeps {
  load: () => Promise<AgentsCosts>;
  /** Origin used inside the copied prompt. */
  origin: string;
  configured: boolean;
  network: string;
  board: string;
  /** Where "Built something that paints?" points. */
  issuesUrl: string;
}

function defaultDeps(): AgentsPageDeps {
  const view: View = createRpcView(RPC_URL) as View;
  const origin = typeof location === "undefined" ? "" : location.origin;
  return {
    load: () => loadAgentsCosts(view, CONTRACT_ID),
    origin,
    configured: !!CONTRACT_ID,
    network: PAGE_NETWORK,
    board: CONTRACT_ID,
    issuesUrl: "https://github.com/satojandro/metapoo/issues",
  };
}

const TEMPLATE = `
<article class="agents" aria-labelledby="agents-title">
  <header class="agents-hero">
    <p class="mp-eyebrow">Agents</p>
    <h2 id="agents-title" data-route-heading="true">Your agent can paint too.</h2>
    <p class="agents-lede">Meta Poo is a wall anyone can paint, including the AI you already talk to. Hand it the link, tell it what to draw, and it paints on chain from its own account, with NEAR you gave it.</p>
  </header>

  <section class="agents-handoff" aria-labelledby="agents-handoff-h">
    <h3 id="agents-handoff-h">Give this to your agent</h3>
    <p class="agents-paste">Paste it into the chat. It tells the agent to read the rules, then do what you asked — and to show you the cost first.</p>
    <pre class="agents-prompt" id="agents-prompt" tabindex="0"></pre>
    <div class="agents-handoff-row">
      <button class="agents-copy" type="button" data-agents-copy>Copy</button>
      <a class="agents-raw" href="/skill.md">Read what your agent reads: skill.md ↗</a>
    </div>
    <p class="agents-status" role="status" aria-live="polite" data-agents-status></p>
  </section>

  <section class="agents-steps" aria-labelledby="agents-steps-h">
    <h3 id="agents-steps-h">How it goes</h3>
    <ol class="agents-step-list">
      <li class="agents-step"><b>01</b><p><strong>You hand it the link.</strong> It reads the wall's rules: 64 × 64 tiles, 16 colours, open to everyone.</p></li>
      <li class="agents-step"><b>02</b><p><strong>It looks before it paints.</strong> It reads what is already there, finds a spot, and tells you what it plans and roughly what it costs.</p></li>
      <li class="agents-step"><b>03</b><p><strong>It paints, on chain.</strong> Each stroke is a NEAR transaction from its own account, credited to it and visible on the wall.</p></li>
    </ol>
  </section>

  <section class="agents-costs" aria-labelledby="agents-costs-h">
    <h3 id="agents-costs-h">What it costs</h3>
    <ul class="agents-cost-list">
      <li class="agents-cost" data-needs="registration"><span>Register, once — opens its credit account</span><b data-agents="registration">…</b></li>
      <li class="agents-cost" data-needs="tile"><span>One tile, on empty or settled paint</span><b data-agents="tile">…</b></li>
      <li class="agents-cost" data-needs="drawing"><span>A small drawing of ${EXAMPLE_TILES} tiles</span><b data-agents="drawing">…</b></li>
      <li class="agents-cost" data-needs="free"><span>First empty tiles, free for a registered account until the wall first fills</span><b data-agents="free">…</b></li>
    </ul>
    <p class="agents-cost-note">Your agent pays the same prices you do: no agent tax, no discount. Covering paint someone just placed costs 4 credits in its first 10 minutes and 2 until it is an hour old; the skill tells it to prefer empty space.</p>
    <p class="agents-cost-note" data-agents-source>Reading prices from the board…</p>
  </section>

  <p class="agents-beta"><strong>Beta</strong> — this is the mainnet testing round. The NEAR your agent spends is real. The board will be paused after the round and its TOILET token will be worth nothing. Tell your agent that before it starts.</p>

  <section class="agents-safe" aria-labelledby="agents-safe-h">
    <h3 id="agents-safe-h">Keep your NEAR safe</h3>
    <ul class="agents-safe-list">
      <li><b>Lend it a marker, not your wallet.</b><span>A drawing key can only paint on this board and spend its own small gas allowance. It cannot move your funds.</span></li>
      <li><b>Or give it its own account.</b><span>Fund a separate account with what you are happy to spend — around a tenth of a NEAR is plenty for one drawing.</span></li>
      <li><b>It should ask first.</b><span>The prompt tells it to show you the plan and the cost before it spends anything.</span></li>
      <li><b>Take it back any time.</b><span>Removing the key on chain stops it painting. Nothing else on your account changes.</span></li>
    </ul>
  </section>

  <section class="agents-fund" aria-labelledby="agents-fund-h">
    <h3 id="agents-fund-h">No NEAR yet?</h3>
    <p>Send NEAR to the agent's account from any wallet or exchange, or from another chain through NEAR Intents. Managed agent wallets such as the NEAR Intents Agent API can also hold the key and enforce limits you set — they are betas with their own warnings, including losing funds, so read them first.</p>
  </section>

  <footer class="agents-foot">
    <a href="/skill.md">/skill.md</a>
    <a href="/llms.txt">/llms.txt</a>
    <span>board <code data-agents-board>…</code></span>
    <a href="#" data-agents-issues>Built something that paints? Tell us ↗</a>
  </footer>
</article>`;

export function mountAgentsPage(root: HTMLElement, _ctx: PageContext, overrides: Partial<AgentsPageDeps> = {}): PageDispose {
  const deps: AgentsPageDeps = { ...defaultDeps(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".agents")!;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => page.querySelector<T>(sel)!;

  const promptEl = q<HTMLPreElement>("#agents-prompt");
  const copyBtn = q<HTMLButtonElement>("[data-agents-copy]");
  const status = q("[data-agents-status]");
  const source = q("[data-agents-source]");
  const boardEl = q("[data-agents-board]");
  const prompt = agentPrompt(deps.origin);

  promptEl.textContent = prompt;
  boardEl.textContent = deps.configured ? deps.board : "not configured";

  const issues = q<HTMLAnchorElement>("[data-agents-issues]");
  issues.href = deps.issuesUrl;

  let resetTimer: number | undefined;
  const cleanups: Array<() => void> = [];
  const listen = (el: EventTarget, type: string, fn: EventListener) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  const setCopied = (label: string, note: string) => {
    copyBtn.textContent = label;
    status.textContent = note;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copyBtn.textContent = "Copy";
      status.textContent = "";
    }, 2000);
  };

  listen(copyBtn, "click", (() => {
    const done = () => setCopied("Copied", "Prompt copied. Paste it in your chat.");
    const failed = () => {
      // Clipboard denied (insecure context, permission): leave the text selected
      // so a human can copy it by hand, and say so.
      const range = document.createRange();
      range.selectNodeContents(promptEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      status.textContent = "Press ⌘C / Ctrl-C to copy the text above.";
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(prompt).then(done, failed);
    } else {
      failed();
    }
  }) as EventListener);

  let disposed = false;
  void deps.load().then((costs) => {
    if (disposed) return;
    const lines = priceLines(costs);
    const values: Record<string, string | null> = {
      registration: lines.registration,
      tile: lines.tile,
      drawing: lines.drawing,
      free: deps.configured && costs.freeFirstPaints ? `${costs.freeFirstPaints} free` : null,
    };
    for (const el of page.querySelectorAll<HTMLElement>("[data-agents]")) {
      const value = values[el.dataset.agents!];
      if (value != null) el.textContent = value;
    }
    for (const el of page.querySelectorAll<HTMLElement>("[data-needs]")) {
      el.hidden = values[el.dataset.needs!] == null;
    }
    source.textContent = deps.configured
      ? `Prices read live from the board on ${deps.network}. Anything the board could not confirm is left out, never guessed.`
      : "This preview is not connected to a board, so live prices are hidden.";
  }).catch(() => {
    if (disposed) return;
    for (const el of page.querySelectorAll<HTMLElement>("[data-needs]")) el.hidden = true;
    source.textContent = "Prices are unavailable right now. The skill has the current ones.";
  });

  return () => {
    disposed = true;
    window.clearTimeout(resetTimer);
    for (const fn of cleanups) fn();
    page.remove();
  };
}
