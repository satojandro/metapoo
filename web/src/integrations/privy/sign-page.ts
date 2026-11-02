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
    busy = false;
  let original: SigningSession | null = null;
  let bound: SigningSession | null = null;
  let wallet: PrivyNearWallet | null = null;
  let capturedHost = getPrivyHostIdentity(storage);
  const cleanup: Array<() => void> = [];
  root.replaceChildren();
  const doc = root.ownerDocument;
  const heading = doc.createElement("h1");
  heading.textContent = "Sign in to Meta Poo";
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = doc.createElement("div");
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    if (!busy) options.close();
  });
  root.append(heading, status, content, cancel);
  const say = (text: string) => {
    if (!disposed) status.textContent = text;
  };
  const setBusy = (value: boolean) => {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = value;
    });
  };
  const action = (
    label: string,
    run: () => Promise<void>,
  ): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    const handler = async () => {
      if (busy || disposed) return;
      setBusy(true);
      try {
        await run();
      } catch {
        say(
          "The request could not complete. Check your connection, then retry or return to the game.",
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
    const wrap = doc.createElement("label");
    wrap.textContent = label;
    const input = doc.createElement("input");
    input.type = type;
    input.required = true;
    wrap.append(input);
    content.append(wrap);
    return input;
  };

  async function prepareReview(): Promise<void> {
    if (!original || disposed) return;
    wallet = await ensureNearWallet(runtime, config.network, storage);
    if (disposed) return;
    // Re-handshake with an explicit wallet: upstream's default selects the first NEAR wallet.
    // The executor remains listening until RESULT/ERROR, including after an OAuth page reload.
    bound = await runtime.handshake(wallet);
    if (disposed) return;
    if (JSON.stringify(bound.payload) !== JSON.stringify(original.payload))
      throw new Error("Wallet request changed.");
    const host = getPrivyHostIdentity(storage);
    const review = reviewPrivyRequest(
      bound,
      config,
      wallet,
      host,
      options.boardContractId,
      options.drawingPublicKey,
      getPrivyPendingDrawingAuthorization(storage),
    );
    if (review.requiresHost && !sameHostIdentity(capturedHost, host))
      throw new Error("Connected account changed.");
    heading.textContent = review.title;
    content.replaceChildren();
    for (const line of review.details) {
      const p = doc.createElement("p");
      p.textContent = line;
      content.append(p);
    }
    const approve = action(
      review.requiresHost ? "Approve" : "Connect account",
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
        reviewPrivyRequest(
          bound,
          config,
          currentWallet,
          getPrivyHostIdentity(storage),
          options.boardContractId,
          options.drawingPublicKey,
          getPrivyPendingDrawingAuthorization(storage),
        );
        if (review.requiresFunds) {
          try {
            await runtime.assertReady(currentWallet);
          } catch {
            say(
              "Your account, signing key and native NEAR for network fees could not be verified. Check your balance, or try again when the network is available.",
            );
            return;
          }
        }
        if (
          disposed ||
          (review.requiresHost &&
            !sameHostIdentity(capturedHost, getPrivyHostIdentity(storage)))
        ) {
          throw new Error("Connected account changed.");
        }
        // The vendor signs the immutable payload displayed above. No retry follows a signing error.
        say(
          "Requesting your wallet approval. Do not submit this request again while its outcome is unknown.",
        );
        try {
          await bound.sign();
          content.replaceChildren();
          say(
            "Wallet response sent to the game. The game will check transaction confirmation.",
          );
        } catch {
          content.replaceChildren();
          say(
            "The wallet did not return a confirmed result. Close this window and check the original operation in the game before retrying.",
          );
        }
      },
    );
    content.append(approve);
    say(
      review.requiresFunds
        ? "You pay network fees from your native NEAR balance."
        : "Connecting does not send a blockchain transaction.",
    );
  }

  function renderLogin(): void {
    if (disposed) return;
    heading.textContent = "Sign in to Meta Poo";
    content.replaceChildren();
    const google = action("Continue with Google", async () => {
      options.navigate(await runtime.googleUrl());
    });
    content.append(google);
    const email = field("Email address", "email");
    email.autocomplete = "email";
    content.append(
      action("Send email code", async () => {
        if (!email.checkValidity()) {
          email.reportValidity();
          return;
        }
        await runtime.sendEmailCode(email.value.trim());
        const address = email.value.trim();
        content.replaceChildren();
        const code = field("Email verification code", "text");
        code.autocomplete = "one-time-code";
        code.inputMode = "numeric";
        content.append(
          action("Sign in with code", async () => {
            if (!code.value.trim()) return;
            await runtime.loginEmail(address, code.value.trim());
            await prepareReview();
          }),
        );
        say("Check your email for a sign-in code.");
        code.focus();
      }),
    );
    say(
      "Use Google or an email code. A new account needs native NEAR before it can authorize drawing or spend.",
    );
  }

  const ready = (async () => {
    try {
      say("Connecting to the sign-in service…");
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
        say(
          "This request has a missing or different network, or an untrusted origin. Return to the game.",
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
    } catch {
      say(
        "Sign-in could not be restored. Return to the game and try again. No request was automatically signed.",
      );
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
