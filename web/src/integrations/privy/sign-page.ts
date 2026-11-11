import { reviewWithdrawalRequest } from "./withdrawal-review";
import { reviewPrivyRequest, type SigningSession } from "./approval";
import type { PrivyConfig } from "./config";
import type { PrivyPageRuntime } from "./runtime";
import {
  ensureNearWallet,
  getPrivyHostIdentity,
  getPrivyPendingDrawingAuthorization,
  sameHostIdentity,
  type PrivyNearWallet,
  type SessionStorage,
} from "./session";

export interface PrivyPageOptions {
  config: PrivyConfig;
  runtime: PrivyPageRuntime;
  storage: SessionStorage;
  boardContractId: string;
  drawingPublicKey?: string;
  location: Pick<Location, "href">;
  navigate(url: string): void;
  replaceUrl(url: string): void;
  close(): void;
}

/** Standalone approval page. Mounting it never signs; only its explicit Approve button can sign. */
export function mountPrivySignPage(
  root: HTMLElement,
  options: PrivyPageOptions,
): { dispose(): void; ready: Promise<void> } {
  const { runtime, config, storage } = options;
  let disposed = false,
    busy = false,
    signingStarted = false;
  let original: SigningSession | null = null;
  let bound: SigningSession | null = null;
  let wallet: PrivyNearWallet | null = null;
  let capturedHost = getPrivyHostIdentity(storage);
  const cleanup: Array<() => void> = [];
  root.replaceChildren();
  const doc = root.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Brand bar: the same wordmark as the game, plus who handles sign-in and which network.
  const brand = el("header", "ps-brand");
  const wordmark = el("span", "ps-wordmark", "meta poo.");
  const trust = el("span", "ps-trust");
  const lock = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  lock.setAttribute("viewBox", "0 0 16 16");
  lock.setAttribute("class", "ps-lock");
  lock.setAttribute("aria-hidden", "true");
  const shackle = doc.createElementNS(lock.namespaceURI, "path");
  shackle.setAttribute("d", "M5 7V5a3 3 0 0 1 6 0v2");
  const body = doc.createElementNS(lock.namespaceURI, "rect");
  for (const [k, v] of Object.entries({ x: "3", y: "7", width: "10", height: "7", rx: "1.5" }))
    body.setAttribute(k, v);
  lock.append(shackle, body);
  const secure = el("span", "ps-secure", "Secure sign-in");
  secure.prepend(lock);
  trust.append(
    secure,
    el("span", "ps-pill", `NEAR ${config.network}`),
  );
  brand.append(wordmark, trust);
  const card = el("section", "ps-card");
  const eyebrow = el("p", "mp-eyebrow ps-eyebrow");
  const heading = el("h1", "ps-title");
  const lede = el("p", "ps-lede");
  const content = el("div", "ps-content");
  const status = el("p", "ps-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = el("div", "ps-actions");
  const cancel = el("button", "mp-btn ps-btn ps-btn-quiet", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    if (!busy) {
      // After invoking the signer, a lost response can still mean funds moved.
      // Only this explicit pre-sign action can release the host's unsent marker.
      if (!signingStarted) runtime.rejectBeforeBroadcast(config.origin);
      options.close();
    }
  });
  actions.append(cancel);
  card.append(eyebrow, heading, lede, content, status, actions);
  const footer = el(
    "footer",
    "ps-foot",
    "Meta Poo never sees your keys or holds your money. Sign-in and signing are handled by Privy.",
  );
  root.append(brand, card, footer);
  const say = (text: string, tone: "info" | "error" = "info") => {
    if (disposed) return;
    status.textContent = text;
    status.dataset.tone = tone;
  };
  const screen = (kicker: string, title: string, intro = "") => {
    eyebrow.textContent = kicker;
    heading.textContent = title;
    lede.textContent = intro;
    lede.hidden = !intro;
    content.replaceChildren();
    // A new screen never carries over the previous screen's Approve/Connect button.
    actions.replaceChildren(cancel);
    status.textContent = "";
  };
  let confirmationSync: (() => void) | undefined;
  const setBusy = (value: boolean) => {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = value;
    });
    confirmationSync?.();
  };
  const action = (
    label: string,
    run: () => Promise<void>,
    primary = true,
  ): HTMLButtonElement => {
    const button = el(
      "button",
      primary ? "mp-btn mp-btn-primary ps-btn" : "mp-btn ps-btn",
      label,
    );
    button.type = "button";
    const handler = async () => {
      if (busy || disposed) return;
      setBusy(true);
      try {
        await run();
      } catch {
        say(
          "That didn't go through. Check your connection and try again, or close this window and return to the game.",
          "error",
        );
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    button.addEventListener("click", handler);
    cleanup.push(() => button.removeEventListener("click", handler));
    return button;
  };
  const field = (label: string, type: string) => {
    const wrap = el("label", "ps-field");
    wrap.append(el("span", "ps-field-label", label));
    const input = el("input", "ps-input");
    input.type = type;
    input.required = true;
    wrap.append(input);
    content.append(wrap);
    return input;
  };

  async function prepareReview(): Promise<void> {
    if (!original || disposed) return;
    // The withdrawal review reads the chain (token metadata, registration, key state), so the
    // window has to say something before those round trips answer — it used to render nothing.
    say("Checking this request with the chain…");
    wallet = await ensureNearWallet(runtime, config.network, storage);
    if (disposed) return;
    // Re-handshake with an explicit wallet: upstream's default selects the first NEAR wallet.
    // The executor remains listening until RESULT/ERROR, including after an OAuth page reload.
    bound = await runtime.handshake(wallet);
    if (disposed) return;
    if (JSON.stringify(bound.payload) !== JSON.stringify(original.payload))
      throw new Error("Wallet request changed.");
    const host = getPrivyHostIdentity(storage);
    const review = await reviewWithdrawalRequest(
      bound,
      config,
      wallet,
      storage,
      options.boardContractId,
      options.drawingPublicKey,
    );
    if (review.requiresHost && !sameHostIdentity(capturedHost, host))
      throw new Error("Connected account changed.");
    screen(review.eyebrow, review.title, review.lede);
    // Every value below comes from the payload that will be signed, as text nodes.
    const facts = el("dl", "ps-facts");
    for (const row of review.rows) {
      const item = el("div", "ps-fact");
      item.append(
        el("dt", "", row.label),
        el("dd", row.mono ? "ps-mono" : "", row.value),
      );
      facts.append(item);
    }
    content.append(facts);
    for (const note of review.notes) content.append(el("p", "ps-note", note));
    if (review.details.length) {
      const technical = el("details", "ps-technical");
      technical.append(el("summary", "", "Technical details"));
      const list = el("ul", "ps-mono");
      for (const line of review.details) list.append(el("li", "", line));
      technical.append(list);
      content.append(technical);
    }
    const suffix = el("input", "ps-input");
    suffix.autocomplete = "off"; suffix.spellcheck = false;
    const ack = el("input"); ack.type = "checkbox";
    if (review.confirm) {
      const label = el("label", "", "Type the last 8 characters of the public key, exactly as your wallet shows them");
      label.append(suffix);
      const acknowledgement = el("label", "", review.confirm.acknowledgement);
      acknowledgement.prepend(ack);
      content.append(label, acknowledgement);
    }
    const approve = action(
      review.approveLabel,
      async () => {
        if (!bound || !wallet || disposed) return;
        // Re-read identity after every potentially slow provider or RPC step.
        const currentWallet = await ensureNearWallet(
          runtime,
          config.network,
          storage,
        );
        if (
          currentWallet.id !== wallet.id ||
          currentWallet.address !== wallet.address
        )
          throw new Error("Wallet changed.");
        if (review.requiresFunds) {
          try {
            await runtime.assertReady(currentWallet);
          } catch {
            say(
              "We couldn't confirm your account has NEAR for network fees yet. A brand-new account needs its first NEAR before it can approve anything. Add some, wait a moment, then approve again.",
              "error",
            );
            return;
          }
        }
        const freshReview = await reviewWithdrawalRequest(
          bound,
          config,
          currentWallet,
          storage,
          options.boardContractId,
          options.drawingPublicKey,
        );
        if (freshReview.confirm && (!ack.checked || suffix.value.trim() !== freshReview.confirm.suffix)) throw new Error("Confirm the key from your own wallet.");
        if (
          disposed ||
          (review.requiresHost &&
            !sameHostIdentity(capturedHost, getPrivyHostIdentity(storage)))
        ) {
          throw new Error("Connected account changed.");
        }
        // The vendor signs the immutable payload displayed above. No retry follows a signing error.
        say(
          "Signing… Keep this window open, and don't retry in the game until it reports back.",
        );
        try {
          signingStarted = true;
          await bound.sign();
          screen("Done", "All set");
          say("Sent to the game. This window closes on its own; the game confirms the result.");
        } catch {
          screen("Check the game", "We couldn't confirm the result");
          say(
            "It may or may not have gone through. Close this window and check the original operation in the game before trying again.",
            "error",
          );
        }
      },
    );
    // A stable handle for tests and assistive tooling: the label changes per action.
    approve.setAttribute("data-approve", "");
    if (review.confirm) {
      const sync = () => { approve.disabled = busy || suffix.value.trim() !== review.confirm!.suffix || !ack.checked; };
      suffix.addEventListener("input", sync); ack.addEventListener("change", sync);
      confirmationSync = sync;
      sync();
    }
    actions.prepend(approve);
  }

  function renderLogin(): void {
    if (disposed) return;
    screen(
      "Sign in",
      "Sign in to start painting",
      "Use Google or your email. You'll get a NEAR account to go with it: nothing to install, no seed phrase to write down.",
    );
    const google = action("Continue with Google", async () => {
      options.navigate(await runtime.googleUrl());
    });
    google.classList.add("ps-btn-wide");
    content.append(google, el("p", "ps-divider", "or"));
    const email = field("Email", "email");
    email.autocomplete = "email";
    email.placeholder = "you@example.com";
    const sendCode = action(
      "Email me a code",
      async () => {
        if (!email.checkValidity()) {
          email.reportValidity();
          return;
        }
        const address = email.value.trim();
        await runtime.sendEmailCode(address);
        renderCode(address);
      },
      false,
    );
    sendCode.classList.add("ps-btn-wide");
    content.append(
      sendCode,
      el(
        "p",
        "ps-note",
        "Painting needs a little NEAR for network fees. After you sign in, the game shows you how to add some.",
      ),
    );
  }

  function renderCode(address: string): void {
    if (disposed) return;
    screen(
      "Sign in",
      "Check your email",
      `We sent a 6-digit code to ${address}. Enter it below to finish signing in.`,
    );
    const code = field("Code", "text");
    code.autocomplete = "one-time-code";
    code.inputMode = "numeric";
    code.classList.add("ps-code");
    const submit = action("Sign in", async () => {
      if (!code.value.trim()) return;
      await runtime.loginEmail(address, code.value.trim());
      await prepareReview();
    });
    submit.classList.add("ps-btn-wide");
    const back = el("button", "ps-link", "Use a different email");
    back.type = "button";
    const onBack = () => {
      if (!busy) renderLogin();
    };
    back.addEventListener("click", onBack);
    cleanup.push(() => back.removeEventListener("click", onBack));
    content.append(submit, back);
    code.focus();
  }

  const ready = (async () => {
    try {
      screen("Sign in", "Opening secure sign-in…");
      await runtime.initialize();
      if (disposed) return;
      original = await runtime.handshake();
      if (disposed) return;
      // Validate request network/origin before provisioning a wallet or opening OAuth.
      const payload = original.payload as { network?: unknown } | null;
      if (
        original.targetOrigin !== config.origin ||
        payload?.network !== config.network
      ) {
        screen("Request refused", "This request can't be signed here");
        say(
          "It has a missing or different network, or came from a site we don't trust. Nothing was signed. Close this window and return to the game.",
          "error",
        );
        return;
      }
      capturedHost = getPrivyHostIdentity(storage);
      const callback = new URL(options.location.href);
      const code = callback.searchParams.get("privy_oauth_code"),
        state = callback.searchParams.get("privy_oauth_state");
      if (code || state) {
        if (!code || !state) throw new Error("Incomplete OAuth callback.");
        try {
          await runtime.completeOAuth(code, state);
        } finally {
          callback.searchParams.delete("privy_oauth_code");
          callback.searchParams.delete("privy_oauth_state");
          options.replaceUrl(callback.href);
        }
      }
      if (disposed) return;
      const { user } = await runtime.user.get();
      if (disposed) return;
      if (user) await prepareReview();
      else renderLogin();
    } catch (error) {
      // Never swallow the cause. Every distinct failure here (SDK init, handshake, wallet
      // provisioning, RPC) used to collapse into one sentence, so an unsupported chain and a
      // mistyped origin looked identical to the user and to whoever was debugging it.
      const reason =
        error instanceof Error && error.message
          ? error.message
          : String(error ?? "unknown error");
      console.error("[privy-sign] initialization failed:", error);
      try {
        doc.documentElement.dataset.privySignError = reason;
        // Same-origin note to self: the game page can read this to report what went wrong.
        globalThis.localStorage?.setItem("privy-sign:lastError", reason);
      } catch {
        // Diagnostics must never be the thing that breaks the page.
      }
      screen("Sign in", "Sign-in couldn't start");
      say(
        "Close this window and try again from the game. Nothing was signed.",
        "error",
      );
      const detail = el("small", "ps-reason");
      detail.id = "privy-sign-error-detail";
      detail.textContent = `Reason: ${reason}`;
      content.append(detail);
    }
  })();
  return {
    ready,
    dispose() {
      disposed = true;
      cleanup.forEach((fn) => fn());
      runtime.dispose();
      root.replaceChildren();
    },
  };
}
