/**
 * AWAY-B: the page's side of linking an account to the Telegram alerts bot.
 *
 * The board server (`ops/board-server/server/src/telegram_api.rs`) issues a one-time code and
 * the text to sign, verifies the wallet's NEP-413 signature, and keeps the link. The page
 * never sees a chat id. It learns "alerts are on" from a *status token* the server hands out
 * only after a verified signature, kept in this browser: without it the server says nothing
 * about any account, so the panel shows "Get alerts" on a browser that never linked.
 */

export type TelegramAction = "link" | "unlink";

export interface TelegramChallenge {
  code: string;
  /** 32 bytes: the NEP-413 nonce. */
  nonce: Uint8Array;
  message: string;
  recipient: string;
  expiresAtMs: number;
}

export interface SignedTelegramMessage {
  publicKey: string;
  /** base64, as NEP-413 wallets return it. */
  signature: string;
}

/** Why a request did not do what was asked, in terms the panel can word. */
export type TelegramFailure =
  /** The code ran out or was used: start again. */
  | "expired"
  /** The signature is not from a full-access key of the account. */
  | "wrong-key"
  /** The signature does not match what was asked. */
  | "bad-signature"
  | "rate-limited"
  /** No server, network error, timeout, 5xx, or a body that does not hold together. */
  | "unavailable";

export class TelegramAlertsError extends Error {
  constructor(readonly failure: TelegramFailure) {
    super(`telegram alerts: ${failure}`);
  }
}

export interface TelegramAlertsClient {
  challenge(account: string, action: TelegramAction): Promise<TelegramChallenge>;
  link(
    account: string,
    code: string,
    signed: SignedTelegramMessage,
  ): Promise<{ linked: boolean; token: string }>;
  unlink(account: string, code: string, signed: SignedTelegramMessage): Promise<void>;
  /** `null`: the token is not this account's (any more). Otherwise whether alerts are on. */
  status(account: string, token: string): Promise<boolean | null>;
}

export interface TelegramAlertsOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export const TELEGRAM_ALERTS_TIMEOUT_MS = 12_000;

/** A Telegram bot username: 5–32 letters, digits or underscores (no `@`). */
export function parseBotUsername(raw: string): string {
  const name = raw.trim().replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name) ? name : "";
}

/** `https://t.me/<bot>?start=<code>`: opens the bot and sends it the code in one tap. */
export function botLink(bot: string, code: string): string {
  return `https://t.me/${bot}?start=${encodeURIComponent(code)}`;
}

function decodeNonce(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function parseChallenge(body: unknown): TelegramChallenge | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const nonce = decodeNonce(record.nonce);
  const { code, message, recipient, expires_at_ms: expiresAtMs } = record;
  if (
    !nonce ||
    typeof code !== "string" ||
    !/^[A-Z0-9]{6,32}$/.test(code) ||
    typeof message !== "string" ||
    // The wallet shows this text: never sign one that does not name the code just issued.
    !message.includes(code) ||
    typeof recipient !== "string" ||
    recipient === "" ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs)
  ) {
    return null;
  }
  return { code, nonce, message, recipient, expiresAtMs };
}

function failureFor(status: number): TelegramFailure {
  if (status === 410 || status === 409) return "expired";
  if (status === 403) return "wrong-key";
  if (status === 401) return "bad-signature";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

/** A client for the configured server, or `null` when `VITE_BOARD_SERVER_URL` is unset. */
export function createTelegramAlertsClient(
  options: TelegramAlertsOptions,
): TelegramAlertsClient | null {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return null;

  /** POST JSON; the status and the parsed body, or "unavailable". */
  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? TELEGRAM_ALERTS_TIMEOUT_MS,
    );
    try {
      const response = await (options.fetcher ?? fetch)(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      throw new TelegramAlertsError("unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  const signedBody = (account: string, code: string, signed: SignedTelegramMessage) => ({
    account,
    code,
    public_key: signed.publicKey,
    signature: signed.signature,
  });

  return {
    async challenge(account, action) {
      const answer = await post("/api/telegram/challenge", { account, action });
      if (answer.status !== 200) throw new TelegramAlertsError(failureFor(answer.status));
      const challenge = parseChallenge(answer.body);
      if (!challenge) throw new TelegramAlertsError("unavailable");
      return challenge;
    },
    async link(account, code, signed) {
      const answer = await post("/api/telegram/link", signedBody(account, code, signed));
      if (answer.status !== 200) throw new TelegramAlertsError(failureFor(answer.status));
      const body = (answer.body ?? {}) as Record<string, unknown>;
      const known = body.status === "linked" || body.status === "waiting_for_telegram";
      if (!known || typeof body.token !== "string" || body.token === "") {
        throw new TelegramAlertsError("unavailable");
      }
      return { linked: body.status === "linked", token: body.token };
    },
    async unlink(account, code, signed) {
      const answer = await post("/api/telegram/unlink", signedBody(account, code, signed));
      if (answer.status !== 200) throw new TelegramAlertsError(failureFor(answer.status));
    },
    async status(account, token) {
      const answer = await post("/api/telegram/status", { account, token });
      if (answer.status === 401) return null;
      const linked = (answer.body as { linked?: unknown } | null)?.linked;
      if (answer.status !== 200 || typeof linked !== "boolean") {
        throw new TelegramAlertsError("unavailable");
      }
      return linked;
    },
  };
}

/** Where this browser keeps the status token of one account on one network. */
export function tokenStorageKey(network: string, account: string): string {
  return `metapoo:telegram-alerts:${network}:${account}`;
}

/** Wallets return the signature as base64 text; some hand back the raw 64 bytes. */
export function signatureToBase64(signature: unknown): string {
  if (typeof signature === "string") return signature;
  if (signature instanceof Uint8Array) {
    return btoa(String.fromCharCode(...signature));
  }
  return "";
}
