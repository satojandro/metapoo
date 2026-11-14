/**
 * AWAY-B (return-and-growth spec §1.3): "Get alerts on Telegram" in the wallet panel.
 *
 * Opt-in, and removable from the same place. Shown only when the page has a board server
 * and a bot username, and a wallet is connected. Linking is two clicks because each needs
 * its own user gesture: one opens Telegram with the code, one asks the wallet to sign
 * (a signature only: no transaction, no fee). Either order works.
 *
 * What this browser knows about the link is a status token the server issued after a
 * verified signature (`board-server/telegram-alerts.ts`). A browser without one cannot ask
 * whether the account is linked, so it offers to link.
 */

import { BOARD_SERVER_URL, PAGE_NETWORK, TELEGRAM_BOT } from "../config";
import {
  botLink,
  createTelegramAlertsClient,
  parseBotUsername,
  signatureToBase64,
  TelegramAlertsError,
  tokenStorageKey,
  type TelegramAction,
  type TelegramAlertsClient,
  type TelegramChallenge,
  type TelegramFailure,
} from "../board-server/telegram-alerts";
import { isUserRejection } from "../tx-outcome";
import { connectedWalletCanSignMessages, signOwnershipMessage } from "../wallet";
import type { AppServices } from "./services";
import "./telegram-alerts.css";

export interface TelegramAlertsDeps {
  client: TelegramAlertsClient | null;
  /** Bot username, already validated; empty hides the panel. */
  bot: string;
  network: string;
  canSign: () => Promise<boolean>;
  sign: typeof signOwnershipMessage;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** How often to ask whether the bot has received the code, while waiting for it. */
  pollMs: number;
  now: () => number;
}

function defaultStorage(): TelegramAlertsDeps["storage"] {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultDeps(): TelegramAlertsDeps {
  return {
    client: createTelegramAlertsClient({ baseUrl: BOARD_SERVER_URL }),
    bot: parseBotUsername(TELEGRAM_BOT),
    network: PAGE_NETWORK,
    canSign: connectedWalletCanSignMessages,
    sign: signOwnershipMessage,
    storage: defaultStorage(),
    pollMs: 3_000,
    now: () => Date.now(),
  };
}

const FAILURE_COPY: Record<TelegramFailure, string> = {
  expired: "That code ran out. Start again.",
  "wrong-key":
    "That signature can’t confirm this account. Sign with the account’s own (full-access) key, not a painting key.",
  "bad-signature": "The wallet’s signature did not match. Start again.",
  "rate-limited": "Too many tries. Wait a minute and try again.",
  unavailable: "Telegram alerts are unavailable right now. Try again later.",
};

type View =
  | { kind: "hidden" }
  /** Connected with a sign-in that cannot sign messages (Google or email, today). */
  | { kind: "cannot-sign" }
  | { kind: "off"; note?: string }
  | { kind: "busy"; text: string }
  /** A code is out: open Telegram, approve in the wallet. */
  | { kind: "linking"; challenge: TelegramChallenge; signed: boolean; note?: string }
  | { kind: "on"; note?: string }
  /** Stop was pressed: the wallet has to sign that too. */
  | { kind: "stopping"; challenge: TelegramChallenge; note?: string };

export function mountTelegramAlerts(
  host: HTMLElement,
  services: AppServices,
  overrides: Partial<TelegramAlertsDeps> = {},
): () => void {
  const deps = { ...defaultDeps(), ...overrides };
  const client = deps.client;
  host.classList.add("telegram-alerts");
  host.hidden = true;
  if (!client || !deps.bot) return () => {};

  let account: string | null = null;
  let view: View = { kind: "hidden" };
  /** Bumped on every account change and dispose, so a late answer cannot repaint. */
  let epoch = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const key = () => tokenStorageKey(deps.network, account ?? "");
  const readToken = (): string | null => {
    try {
      return deps.storage?.getItem(key()) ?? null;
    } catch {
      return null;
    }
  };
  const writeToken = (token: string | null): void => {
    try {
      if (token === null) deps.storage?.removeItem(key());
      else deps.storage?.setItem(key(), token);
    } catch {
      /* Storage blocked: the link still works; this browser just forgets it is linked. */
    }
  };

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text = "",
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function button(label: string, action: string, onClick: () => void, primary = false) {
    const node = el("button", primary ? "mp-btn mp-btn-primary" : "mp-btn", label);
    node.type = "button";
    node.dataset.tg = action;
    node.addEventListener("click", onClick);
    return node;
  }

  function botAnchor(code: string): HTMLAnchorElement {
    const link = el("a", "mp-btn telegram-alerts-open", `Open @${deps.bot}`);
    link.href = botLink(deps.bot, code);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.dataset.tg = "open-bot";
    return link;
  }

  function render(next: View): void {
    view = next;
    clearTimeout(pollTimer);
    host.hidden = next.kind === "hidden";
    host.replaceChildren();
    if (next.kind === "hidden") return;
    host.append(el("h2", "telegram-alerts-h", "Telegram alerts"));
    const status = el("p", "telegram-alerts-status");
    status.setAttribute("role", "status");
    const actions = el("div", "telegram-alerts-actions");

    switch (next.kind) {
      case "cannot-sign":
        status.textContent =
          "Not available for Google or email sign-ins yet: linking needs a wallet that can sign a message.";
        break;
      case "off":
        status.textContent =
          next.note ?? "Get a Telegram message when your tiles are covered. One an hour at most.";
        actions.append(button("Get alerts on Telegram", "start", () => void start("link"), true));
        break;
      case "busy":
        status.textContent = next.text;
        break;
      case "linking": {
        const steps = el("ol", "telegram-alerts-steps");
        const first = el("li", "", "Send this code to the bot: ");
        first.append(el("code", "telegram-alerts-code", next.challenge.code), " ", botAnchor(next.challenge.code));
        const second = el(
          "li",
          "",
          next.signed
            ? "Signed. Waiting for the bot to get the code…"
            : "Approve a signature in your wallet. No transaction, no fee. ",
        );
        if (!next.signed) {
          second.append(button("Approve in wallet", "sign", () => void signLink(next.challenge), true));
        }
        steps.append(first, second);
        host.append(steps);
        status.textContent = next.note ?? "The code works once and lasts ten minutes.";
        actions.append(button("Cancel", "cancel", () => void refresh()));
        if (next.signed) schedulePoll(next.challenge);
        break;
      }
      case "on":
        status.textContent =
          next.note ?? `Alerts are on. @${deps.bot} messages you when your tiles are covered.`;
        actions.append(button("Stop Telegram alerts", "stop", () => void start("unlink")));
        break;
      case "stopping":
        status.textContent =
          next.note ??
          "Approve a signature to stop alerts. No transaction, no fee. (Sending /stop to the bot works too.)";
        actions.append(
          button("Approve in wallet", "sign", () => void signUnlink(next.challenge), true),
          button("Keep alerts", "cancel", () => render({ kind: "on" })),
        );
        break;
    }
    host.append(status);
    if (actions.childElementCount > 0) host.append(actions);
  }

  function copyFor(error: unknown): string {
    if (error instanceof TelegramAlertsError) return FAILURE_COPY[error.failure];
    if (isUserRejection(error)) return "The wallet did not sign, so nothing changed.";
    return "The wallet could not sign that. Nothing changed.";
  }

  /** What this browser can know: on (a live token says so), or off. */
  async function refresh(): Promise<void> {
    const mine = ++epoch;
    clearTimeout(pollTimer);
    if (!account) return render({ kind: "hidden" });
    if (!(await deps.canSign())) {
      if (mine === epoch) render({ kind: "cannot-sign" });
      return;
    }
    if (mine !== epoch) return;
    const token = readToken();
    if (!token) return render({ kind: "off" });
    render({ kind: "busy", text: "Checking…" });
    try {
      const linked = await client!.status(account, token);
      if (mine !== epoch) return;
      // A token the server no longer knows (alerts were stopped elsewhere) is forgotten.
      if (linked === null) writeToken(null);
      render(linked ? { kind: "on" } : { kind: "off" });
    } catch {
      // Unknown, not "off": say so. Linking again is harmless, it replaces the link.
      if (mine === epoch) render({ kind: "off", note: FAILURE_COPY.unavailable });
    }
  }

  async function start(action: TelegramAction): Promise<void> {
    if (!account) return;
    const mine = epoch;
    const back: View = action === "link" ? { kind: "off" } : { kind: "on" };
    render({ kind: "busy", text: "One moment…" });
    try {
      const challenge = await client!.challenge(account, action);
      if (mine !== epoch) return;
      render(
        action === "link"
          ? { kind: "linking", challenge, signed: false }
          : { kind: "stopping", challenge },
      );
    } catch (error) {
      if (mine === epoch) render({ ...back, note: copyFor(error) });
    }
  }

  async function signed(challenge: TelegramChallenge) {
    const result = await deps.sign({
      accountId: account!,
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: challenge.nonce,
    });
    return { publicKey: result.publicKey, signature: signatureToBase64(result.signature) };
  }

  async function signLink(challenge: TelegramChallenge): Promise<void> {
    if (!account) return;
    const mine = epoch;
    const owner = account;
    try {
      const proof = await signed(challenge);
      const answer = await client!.link(owner, challenge.code, proof);
      if (mine !== epoch) return;
      writeToken(answer.token);
      render(answer.linked ? { kind: "on" } : { kind: "linking", challenge, signed: true });
    } catch (error) {
      if (mine !== epoch) return;
      const gone = error instanceof TelegramAlertsError && error.failure !== "unavailable";
      // A refusal ends this code; a wallet "no" or an outage leaves it usable.
      render(
        gone
          ? { kind: "off", note: copyFor(error) }
          : { kind: "linking", challenge, signed: false, note: copyFor(error) },
      );
    }
  }

  async function signUnlink(challenge: TelegramChallenge): Promise<void> {
    if (!account) return;
    const mine = epoch;
    const owner = account;
    try {
      const proof = await signed(challenge);
      await client!.unlink(owner, challenge.code, proof);
      if (mine !== epoch) return;
      writeToken(null);
      render({ kind: "off", note: "Alerts are off. The bot has forgotten this account." });
    } catch (error) {
      if (mine !== epoch) return;
      const gone = error instanceof TelegramAlertsError && error.failure !== "unavailable";
      render(gone ? { kind: "on", note: copyFor(error) } : { kind: "stopping", challenge, note: copyFor(error) });
    }
  }

  /** Signed, but the bot has not had the code yet: ask until it has, or the code runs out. */
  function schedulePoll(challenge: TelegramChallenge): void {
    const mine = epoch;
    pollTimer = setTimeout(() => {
      void (async () => {
        const token = readToken();
        if (mine !== epoch || view.kind !== "linking" || !account || !token) return;
        if (deps.now() >= challenge.expiresAtMs) {
          return render({ kind: "off", note: "The code ran out before the bot got it. Start again." });
        }
        const linked = await client!.status(account, token).catch(() => false);
        if (mine !== epoch || view.kind !== "linking") return;
        if (linked) render({ kind: "on" });
        else schedulePoll(challenge);
      })();
    }, deps.pollMs);
  }

  const unsubscribe = services.wallet.subscribe((session) => {
    if (session.accountId === account && view.kind !== "hidden") return;
    account = session.accountId;
    void refresh();
  });

  return () => {
    epoch++;
    clearTimeout(pollTimer);
    unsubscribe();
    host.replaceChildren();
    host.hidden = true;
  };
}
