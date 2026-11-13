/**
 * The "Get a name" section of /how-it-works (NAMES, spec §3, owner decision §3.4).
 *
 * One wallet, one path: Meteor. The section is a story in three beats — see your name on the
 * wall before doing any work, hear what does not move, then the steps. The steps come from
 * `meteor-name-steps.ts`, which is a draft until the owner has checked it on a device; while
 * it is, the section says so on the page.
 *
 * Mounted only when `VITE_NAMES_GUIDE=true`. Nothing here touches the wallet or the chain:
 * the preview is typed text shown in a mock card.
 */

import { checkTypedName, isImplicitId, seesGetAName } from "../shared/get-a-name";
import { shortAccount } from "../shared/short-account";
import type { MeteorGuide } from "./meteor-name-steps";
import "./how-it-works-names.css";

export interface NameGuideDeps {
  enabled: boolean;
  /** The signed-in account, or null. */
  account(): string | null;
  /** Called with a listener for sign-in changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Whether the current sign-in is Privy. Never throws. */
  isPrivy(): Promise<boolean>;
  /** "near" on mainnet, "testnet" otherwise. */
  suffix: string;
  guide: MeteorGuide;
  verified: boolean;
}

/** A sample id for visitors who are not signed in, so the "before" is still a real shape. */
export const SAMPLE_HEX = "3f9a1b2c0d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829304a5b6c21e";
const SAMPLE_NAME = "alice";

export function nameSuffix(network: string): string {
  return network === "mainnet" ? "near" : "testnet";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TEMPLATE = `
  <div class="hiw-head">
    <p class="mp-eyebrow">Your name on the wall</p>
    <h3 id="hiw-name-h">Sign your work.</h3>
    <p>Everything you paint is signed. Right now the wall signs yours with a long account id nobody can read, or remember. A name changes that: when someone covers your tiles, they know who to come after.</p>
  </div>
  <p class="hiw-name-draft" data-name-draft hidden><b>Draft.</b> These steps haven’t been checked on a phone yet. Don’t rely on them.</p>
  <p class="hiw-name-status" data-name-status hidden></p>

  <div class="hiw-name-try">
    <div class="hiw-name-form">
      <label class="hiw-name-label" for="hiw-name-input">Try a name</label>
      <div class="hiw-name-field">
        <input id="hiw-name-input" type="text" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="64" aria-describedby="hiw-name-hint" data-name-input>
        <span class="hiw-name-suffix" data-name-suffix aria-hidden="true"></span>
      </div>
      <p class="hiw-name-hint" id="hiw-name-hint" data-name-hint role="status"></p>
    </div>

    <div class="hiw-name-preview" aria-label="How the wall would show you" data-name-preview>
      <figure class="hiw-name-mock">
        <figcaption>A tile you painted</figcaption>
        <dl class="hiw-name-facts">
          <div><dt>Colour</dt><dd><i class="hiw-name-swatch" aria-hidden="true"></i>Gold</dd></div>
          <div><dt>Painted by</dt><dd><span class="hiw-name-who" data-name-who></span><span class="hiw-name-you">you</span></dd></div>
          <div><dt>When</dt><dd>just now</dd></div>
        </dl>
      </figure>
      <figure class="hiw-name-mock">
        <figcaption>Who holds the wall</figcaption>
        <ol class="hiw-name-rows">
          <li><span class="hiw-name-rank">1</span><i style="background: var(--mp-near)" aria-hidden="true"></i><span class="hiw-name-row-name">misfits-validator.near</span><span class="hiw-name-tiles">261 tiles</span></li>
          <li data-you="true"><span class="hiw-name-rank">2</span><i style="background: var(--mp-tag)" aria-hidden="true"></i><span class="hiw-name-row-name"><span data-name-who></span> (you)</span><span class="hiw-name-tiles">148 tiles</span></li>
          <li><span class="hiw-name-rank">3</span><i style="background: var(--mp-stake)" aria-hidden="true"></i><span class="hiw-name-row-name">poo-lord.near</span><span class="hiw-name-tiles">97 tiles</span></li>
        </ol>
      </figure>
      <p class="hiw-small">A preview with made-up tile counts. It doesn’t check whether the name is taken. Meteor tells you when you create it.</p>
    </div>
  </div>

  <div class="hiw-name-honest">
    <h4>Before you start: nothing moves</h4>
    <p>A name isn’t a label on the account you have. It’s a new account, and a new account starts empty. Tiles you hold stay signed by the old id until someone covers them. Credits you bought stay with the old account, and so does the TOILET it earned. There’s no way to send any of it across.</p>
    <p>So get your name early, before you’ve built much. Use up your credits and claim your TOILET on the old account first.</p>
    <p data-name-privy><b>Signed in with Google or email?</b> That account can’t be given a name. The way to a name is a Meteor wallet with a named account, connected here in place of that sign-in. It starts empty too.</p>
  </div>

  <div class="hiw-name-steps">
    <h4>Get your name with <span data-name-wallet></span></h4>
    <p class="hiw-small">Your name is created in a NEAR wallet, not by Meta Poo. We use one wallet for this: <span data-name-wallet></span>.<span data-name-cost hidden></span></p>
    <ol data-name-steps></ol>
    <p class="hiw-small" data-name-phone hidden></p>
    <p class="hiw-name-cta"><a class="mp-btn mp-btn-primary" data-name-open target="_blank" rel="noopener noreferrer">Open Meteor Wallet ↗</a></p>
  </div>`;

/**
 * Build the section. Returns null (and builds nothing) when the feature is off.
 * The caller places `element` on the page and calls `dispose` when the page goes.
 */
export function createNameGuide(deps: NameGuideDeps): { element: HTMLElement; dispose(): void } | null {
  if (!deps.enabled) return null;

  const section = el("section", "hiw-sec hiw-name");
  section.id = "hiw-name";
  section.setAttribute("aria-labelledby", "hiw-name-h");
  section.innerHTML = TEMPLATE;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => section.querySelector<T>(sel)!;
  const all = (sel: string) => Array.from(section.querySelectorAll<HTMLElement>(sel));

  const { guide, suffix } = deps;
  let disposed = false;
  let privy = false;
  let checkedFor: string | null | undefined;

  q("[data-name-draft]").hidden = deps.verified;
  for (const node of all("[data-name-wallet]")) node.textContent = guide.walletName;
  q("[data-name-suffix]").textContent = `.${suffix}`;
  const cost = q("[data-name-cost]");
  cost.hidden = !guide.cost.verified;
  if (guide.cost.verified) cost.textContent = ` ${guide.cost.text}`;
  const phone = q("[data-name-phone]");
  phone.hidden = !guide.phoneNote;
  phone.textContent = guide.phoneNote;
  q<HTMLAnchorElement>("[data-name-open]").href = guide.walletUrl;
  q("[data-name-steps]").replaceChildren(
    ...guide.steps.map((step) => {
      const li = el("li");
      const text = el("div");
      text.append(el("h5", undefined, step.title), el("p", undefined, step.body));
      li.append(text);
      return li;
    }),
  );

  const input = q<HTMLInputElement>("[data-name-input]");
  const hint = q("[data-name-hint]");
  const preview = q("[data-name-preview]");
  input.placeholder = SAMPLE_NAME;

  /** The id the wall shows today: the viewer's own when it is a hex id, else the sample. */
  function before(): string {
    const account = deps.account();
    return shortAccount(account && isImplicitId(account) ? account : SAMPLE_HEX);
  }

  function renderPreview(): void {
    const typed = checkTypedName(input.value, suffix);
    const shown = typed.ok ? typed.name : before();
    preview.dataset.named = String(typed.ok);
    for (const node of all("[data-name-who]")) node.textContent = shown;
    input.setAttribute("aria-invalid", String(!typed.ok && input.value.trim() !== ""));
    hint.dataset.state = typed.ok ? "ok" : input.value.trim() ? "bad" : "idle";
    hint.textContent = typed.ok
      ? `That’s how the wall would sign you: ${typed.name}.`
      : typed.reason || `Right now the wall signs you ${before()}. Type the name you’d rather have.`;
  }

  function renderStatus(): void {
    const account = deps.account();
    const status = q("[data-name-status]");
    const offered = seesGetAName({ accountId: account, privy });
    // A named account has nothing to do here: say so instead of selling it a second name.
    const named = account !== null && !offered;
    status.hidden = !named;
    status.textContent = named ? `You already have one: ${account}. Nothing to do here.` : "";
    section.dataset.viewer = account === null ? "out" : named ? "named" : privy ? "privy" : "hex";
    renderPreview();
  }

  function sync(): void {
    const account = deps.account();
    renderStatus();
    if (account === checkedFor) return;
    checkedFor = account;
    privy = false;
    if (account === null) return;
    void deps.isPrivy().then(
      (value) => {
        if (disposed || deps.account() !== account) return;
        privy = value;
        renderStatus();
      },
      () => undefined,
    );
  }

  const onInput = (): void => renderPreview();
  input.addEventListener("input", onInput);
  const unsubscribe = deps.subscribe(sync);
  sync();

  return {
    element: section,
    dispose(): void {
      disposed = true;
      unsubscribe();
      input.removeEventListener("input", onInput);
      section.remove();
    },
  };
}
