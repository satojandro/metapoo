import { describe, expect, it, vi } from "vitest";
import {
  botLink,
  createTelegramAlertsClient,
  parseBotUsername,
  parseChallenge,
  signatureToBase64,
  TelegramAlertsError,
} from "./telegram-alerts";

const NONCE = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const challengeBody = {
  code: "ABCDEFGHJK",
  nonce: NONCE,
  message: "Send Telegram alerts when tiles of alice.near on Meta Poo are covered. Code: ABCDEFGHJK",
  recipient: "metapoo.example",
  expires_at_ms: 1_800_000_600_000,
};

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  );
}

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof TelegramAlertsError) return error.failure;
    throw error;
  }
  return "no error";
}

describe("telegram alerts client", () => {
  it("is absent without a board server", () => {
    expect(createTelegramAlertsClient({ baseUrl: "" })).toBeNull();
  });

  it("only accepts a bot username Telegram could have issued", () => {
    expect(parseBotUsername(" @MetaPooBot ")).toBe("MetaPooBot");
    for (const bad of ["", "bot", "meta poo", "https://t.me/x", "a/b?start=1", "1abcdef"]) {
      expect(parseBotUsername(bad)).toBe("");
    }
    expect(botLink("MetaPooBot", "ABCDEFGHJK")).toBe("https://t.me/MetaPooBot?start=ABCDEFGHJK");
  });

  it("posts the account and action, and reads the challenge", async () => {
    const fetcher = answering(200, challengeBody);
    const client = createTelegramAlertsClient({ baseUrl: "https://board.example/", fetcher })!;
    const challenge = await client.challenge("alice.near", "link");
    expect(fetcher.mock.calls[0][0]).toBe("https://board.example/api/telegram/challenge");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      account: "alice.near",
      action: "link",
    });
    expect(challenge.code).toBe("ABCDEFGHJK");
    expect(challenge.nonce).toEqual(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(challenge.recipient).toBe("metapoo.example");
  });

  it("refuses a challenge that does not hold together, rather than asking the wallet to sign it", () => {
    expect(parseChallenge(challengeBody)).not.toBeNull();
    expect(parseChallenge({ ...challengeBody, nonce: btoa("short") })).toBeNull();
    expect(parseChallenge({ ...challengeBody, nonce: "***" })).toBeNull();
    expect(parseChallenge({ ...challengeBody, message: "Transfer everything" })).toBeNull();
    expect(parseChallenge({ ...challengeBody, recipient: "" })).toBeNull();
    expect(parseChallenge({ ...challengeBody, code: "<b>" })).toBeNull();
    expect(parseChallenge(null)).toBeNull();
  });

  it("sends the wallet's public key and signature, and reads linked or waiting", async () => {
    const signed = { publicKey: "ed25519:abc", signature: "c2ln" };
    const fetcher = answering(200, { status: "waiting_for_telegram", token: "tok" });
    const client = createTelegramAlertsClient({ baseUrl: "https://board.example", fetcher })!;
    expect(await client.link("alice.near", "ABCDEFGHJK", signed)).toEqual({ linked: false, token: "tok" });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      account: "alice.near",
      code: "ABCDEFGHJK",
      public_key: "ed25519:abc",
      signature: "c2ln",
    });
    const linked = createTelegramAlertsClient({
      baseUrl: "https://board.example",
      fetcher: answering(200, { status: "linked", token: "tok" }),
    })!;
    expect((await linked.link("alice.near", "ABCDEFGHJK", signed)).linked).toBe(true);
  });

  it("names each refusal, and reads everything else as unavailable, never as linked", async () => {
    const signed = { publicKey: "ed25519:abc", signature: "c2ln" };
    const cases: Array<[number, unknown, string]> = [
      [410, { error: "x" }, "expired"],
      [409, { error: "x" }, "expired"],
      [403, { error: "x" }, "wrong-key"],
      [401, { error: "x" }, "bad-signature"],
      [429, { error: "x" }, "rate-limited"],
      [503, null, "unavailable"],
      [404, null, "unavailable"],
      [200, { status: "linked" }, "unavailable"],
      [200, { status: "something", token: "tok" }, "unavailable"],
    ];
    for (const [status, body, expected] of cases) {
      const client = createTelegramAlertsClient({
        baseUrl: "https://board.example",
        fetcher: answering(status, body),
      })!;
      expect(await failure(client.link("alice.near", "ABCDEFGHJK", signed)), `${status}`).toBe(expected);
    }
    const offline = createTelegramAlertsClient({
      baseUrl: "https://board.example",
      fetcher: vi.fn(async () => {
        throw new TypeError("network");
      }),
    })!;
    expect(await failure(offline.challenge("alice.near", "link"))).toBe("unavailable");
    expect(await failure(offline.unlink("alice.near", "ABCDEFGHJK", signed))).toBe("unavailable");
  });

  it("reads status as on, off, or not this browser's to know", async () => {
    const client = (status: number, body: unknown) =>
      createTelegramAlertsClient({ baseUrl: "https://board.example", fetcher: answering(status, body) })!;
    expect(await client(200, { linked: true }).status("alice.near", "tok")).toBe(true);
    expect(await client(200, { linked: false }).status("alice.near", "tok")).toBe(false);
    expect(await client(401, { error: "unknown token" }).status("alice.near", "tok")).toBeNull();
    expect(await failure(client(503, null).status("alice.near", "tok"))).toBe("unavailable");
    expect(await failure(client(200, { linked: "yes" }).status("alice.near", "tok"))).toBe("unavailable");
  });

  it("turns a raw signature into base64 and leaves text alone", () => {
    expect(signatureToBase64("c2ln")).toBe("c2ln");
    expect(signatureToBase64(Uint8Array.from([115, 105, 103]))).toBe("c2ln");
    expect(signatureToBase64(undefined)).toBe("");
  });
});
