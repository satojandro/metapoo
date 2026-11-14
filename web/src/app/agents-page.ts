/**
 * /agents — "Give this to your agent" and the story around it.
 *
 * Spec: docs/implementation/2026-11-09-agents-page-spec.md. The mechanics are in
 * `/skill.md`; this page carries three prompts, the live prices and the safety story.
 *
 * Live numbers come from the board. Until a read confirms one it shows "…"; if the
 * read fails, the line that needs it is hidden, never guessed.
 */

import { CONTRACT_ID, PAGE_NETWORK, RPC_URL } from "../config";
import type { PageContext, PageDispose } from "./page-registry";
import { createRpcView } from "./revenue-panel";
import { agentPrompts, EMPTY_COSTS, EXAMPLE_TILES, loadAgentsCosts, priceLines, type AgentsCosts, type View } from "./agents";
import { AGENT_GALLERY, type AgentPiece } from "./agents-gallery";
import { hallCard } from "./hall-page";
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
  /** Curated pieces agents painted (spec §5.2). Empty until someone tells us about one. */
  gallery: readonly AgentPiece[];
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
    gallery: AGENT_GALLERY,
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
    <p class="agents-paste">Pick one and paste it into the chat. Each tells the agent to read the rules first; the two that paint carry a budget and show you the cost before spending.</p>
    <ul class="agents-prompt-list" data-agents-prompts></ul>
    <div class="agents-handoff-row">
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


  <section class="agents-safe" aria-labelledby="agents-safe-h">
    <h3 id="agents-safe-h">Keep your NEAR safe</h3>
    <ul class="agents-safe-list">
      <li><b>Lend it a marker, not your wallet.</b><span>A drawing key can only paint on this board and spend its own small gas allowance. It cannot move your funds.</span></li>
      <li><b>Or give it its own account.</b><span>Fund a separate account with what you are happy to spend — around a tenth of a NEAR is plenty for one drawing.</span></li>
      <li><b>It should ask first.</b><span>The painting prompts tell it to show you the plan and the cost before it spends anything, and cap what it may spend.</span></li>
      <li><b>Take it back any time.</b><span>Removing the key on chain stops it painting. Nothing else on your account changes.</span></li>
    </ul>
  </section>

  <section class="agents-fund" aria-labelledby="agents-fund-h">
    <h3 id="agents-fund-h">No NEAR yet?</h3>
    <p>Send NEAR to the agent's account from any wallet or exchange, or from another chain through NEAR Intents. Managed agent wallets such as the NEAR Intents Agent API can also hold the key and enforce limits you set — they are betas with their own warnings, including losing funds, so read them first.</p>
  </section>

  <section class="agents-gallery" aria-labelledby="agents-gallery-h" data-agents-gallery>
    <h3 id="agents-gallery-h">Painted by agents</h3>
    <p class="agents-gallery-lede" data-agents-gallery-lede>Each piece hangs with the prompt that made it. Copy one and see what yours does with it. Chosen by hand, on the owner's word: the chain cannot tell an agent from a person.</p>
    <ol class="hall-grid agents-gallery-grid" data-agents-gallery-grid></ol>
    <p class="agents-status" role="status" aria-live="polite" data-agents-gallery-status></p>
    <p class="agents-gallery-empty" data-agents-gallery-empty hidden><strong>Nothing hung yet.</strong> The first pieces will hang here, each with the prompt that made it. <a href="#" data-agents-issues>Built something that paints? Tell us ↗</a></p>
  </section>

  <footer class="agents-foot">
    <a href="/skill.md">/skill.md</a>
    <a href="/llms.txt">/llms.txt</a>
    <span>board <code data-agents-board>…</code></span>
    <a href="#" data-agents-issues>Built something that paints? Tell us ↗</a>
  </footer>
</article>`;

/** A prompt on the page with its own Copy button. */
interface Copyable {
  button: HTMLButtonElement;
  /** The element showing the text, selected for a manual copy when the clipboard is denied. */
  textEl: HTMLElement;
  /** Exactly what lands on the clipboard. */
  text: string;
  label: string;
  /** Where "copied" is announced: the live region nearest the button. */
  status: HTMLElement;
}

/**
 * One gallery piece: the Hall's card, plus the prompt and its Copy button.
 * The prompt is somebody else's words: it goes in as text, never as HTML, and a
 * long one scrolls inside its box (agents.css) instead of stretching the card.
 */
function galleryCard(piece: AgentPiece, status: HTMLElement): { item: HTMLLIElement; copyable: Copyable } {
  const item = hallCard(piece, "h4");
  item.classList.add("agents-piece");
  item.dataset.agentsPiece = piece.id;
  const title = item.querySelector("h4")!;
  title.id = `agents-piece-${piece.id}-h`;

  const block = document.createElement("div");
  block.className = "agents-piece-prompt";
  const label = document.createElement("p");
  label.className = "agents-piece-label";
  label.id = `agents-piece-${piece.id}-l`;
  label.textContent = "The prompt";
  const pre = document.createElement("pre");
  pre.className = "agents-prompt";
  pre.tabIndex = 0;
  pre.setAttribute("aria-labelledby", `${label.id} ${title.id}`);
  pre.textContent = piece.prompt;
  const button = document.createElement("button");
  button.className = "agents-copy";
  button.type = "button";
  button.dataset.agentsCopyPiece = piece.id;
  button.textContent = "Copy";
  button.setAttribute("aria-describedby", `${label.id} ${title.id}`);
  block.append(label, button, pre);

  item.querySelector(".hall-link")!.before(block);
  return { item, copyable: { button, textEl: pre, text: piece.prompt, label: piece.title, status } };
}

export function mountAgentsPage(root: HTMLElement, _ctx: PageContext, overrides: Partial<AgentsPageDeps> = {}): PageDispose {
  const deps: AgentsPageDeps = { ...defaultDeps(), ...overrides };
  root.insertAdjacentHTML("beforeend", TEMPLATE);
  const page = root.querySelector<HTMLElement>(".agents")!;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => page.querySelector<T>(sel)!;

  const list = q<HTMLUListElement>("[data-agents-prompts]");
  const status = q("[data-agents-status]");
  const source = q("[data-agents-source]");
  const boardEl = q("[data-agents-board]");
  const prompts = agentPrompts(deps.origin);

  for (const p of prompts) {
    const item = document.createElement("li");
    item.className = "agents-prompt-item";
    item.dataset.prompt = p.id;
    const head = document.createElement("div");
    head.className = "agents-prompt-head";
    const label = document.createElement("h4");
    label.id = `agents-prompt-${p.id}-h`;
    label.textContent = p.label;
    const note = document.createElement("p");
    note.className = "agents-prompt-note";
    note.textContent = p.note;
    head.append(label, note);
    const pre = document.createElement("pre");
    pre.className = "agents-prompt";
    pre.id = `agents-prompt-${p.id}`;
    pre.tabIndex = 0;
    pre.textContent = p.text;
    const btn = document.createElement("button");
    btn.className = "agents-copy";
    btn.type = "button";
    btn.dataset.agentsCopy = p.id;
    btn.textContent = "Copy";
    btn.setAttribute("aria-describedby", label.id);
    item.append(head, pre, btn);
    list.append(item);
  }
  boardEl.textContent = deps.configured ? deps.board : "not configured";

  for (const issues of page.querySelectorAll<HTMLAnchorElement>("[data-agents-issues]")) issues.href = deps.issuesUrl;

  // The gallery (spec §5.2). With nothing to show there is no grid, only the invitation.
  const galleryGrid = q<HTMLOListElement>("[data-agents-gallery-grid]");
  const galleryStatus = q("[data-agents-gallery-status]");
  const hasPieces = deps.gallery.length > 0;
  q("[data-agents-gallery-empty]").hidden = hasPieces;
  if (!hasPieces) {
    galleryGrid.remove();
    galleryStatus.remove();
    q("[data-agents-gallery-lede]").remove();
  }

  /** Everything on the page with a Copy button: the starter prompts, then the gallery's. */
  const copyables: Copyable[] = prompts.map((p) => ({
    button: list.querySelector<HTMLButtonElement>(`[data-agents-copy="${p.id}"]`)!,
    textEl: list.querySelector<HTMLPreElement>(`#agents-prompt-${p.id}`)!,
    text: p.text,
    label: p.label,
    status,
  }));
  for (const piece of deps.gallery) {
    const { item, copyable } = galleryCard(piece, galleryStatus);
    galleryGrid.append(item);
    copyables.push(copyable);
  }

  let resetTimer: number | undefined;
  const cleanups: Array<() => void> = [];
  const listen = (el: EventTarget, type: string, fn: EventListener) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  const setCopied = (c: Copyable) => {
    for (const other of copyables) {
      other.button.textContent = "Copy";
      other.status.textContent = "";
    }
    c.button.textContent = "Copied";
    c.status.textContent = `"${c.label}" copied. Paste it in your chat.`;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      c.button.textContent = "Copy";
      c.status.textContent = "";
    }, 2000);
  };

  for (const c of copyables) listen(c.button, "click", (() => {
    const done = () => setCopied(c);
    const failed = () => {
      // Clipboard denied (insecure context, permission): leave the text selected
      // so a human can copy it by hand, and say so.
      const range = document.createRange();
      range.selectNodeContents(c.textEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      c.status.textContent = `Press ⌘C / Ctrl-C to copy the "${c.label}" prompt.`;
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(c.text).then(done, failed);
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
