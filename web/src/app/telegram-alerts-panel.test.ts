// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  TelegramAlertsError,
  tokenStorageKey,
  type TelegramAlertsClient,
  type TelegramChallenge,
} from "../board-server/telegram-alerts";
import type { WalletSession } from "../wallet";
import { createOperationsStore } from "./operations";
import type { AppServices } from "./services";
import { mountTelegramAlerts, type TelegramAlertsDeps } from "./telegram-alerts-panel";

const ALICE = "alice.near";
const challenge = (code = "ABCDEFGHJK"): TelegramChallenge => ({
  code,
  nonce: new Uint8Array(32),
  message: `Send Telegram alerts when tiles of ${ALICE} on Meta Poo are covered. Code: ${code}`,
  recipient: "metapoo.example",
  expiresAtMs: 10 * 60_000,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  vi.useRealTimers();
});

function setup(
  overrides: Partial<TelegramAlertsDeps> = {},
  session: WalletSession = { accountId: ALICE, networkId: "mainnet" },
) {
  let listener: (s: WalletSession) => void = () => {};
  const services: AppServices = {
    wallet: {
      getSession: () => session,
      connect: async () => {},
      disconnect: async () => {},
      subscribe: (l) => {
        listener = l;
        l(session);
        return () => {};
      },
      whenReady: Promise.resolve(session),
    },
    operations: createOperationsStore(),
  };
  const client = {
    challenge: vi.fn(async (): Promise<TelegramChallenge> => challenge()),
    link: vi.fn(async (): Promise<{ linked: boolean; token: string }> => ({ linked: true, token: "tok" })),
    unlink: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<boolean | null> => true),
  } satisfies TelegramAlertsClient;
  const sign = vi.fn(async () => ({ accountId: ALICE, publicKey: "ed25519:abc", signature: "c2ln" }));
  const storage = memoryStorage();
  const deps = {
    client,
    bot: "MetaPooBot",
    network: "mainnet",
    canSign: async () => true,
    sign,
    storage,
    pollMs: 1_000,
    now: () => 0,
    ...overrides,
  };
  const host = document.createElement("section");
  document.body.append(host);
  const dispose = mountTelegramAlerts(host, services, deps);
  cleanup.push(() => {
    dispose();
    host.remove();
  });
  const click = (action: string) => host.querySelector<HTMLElement>(`[data-tg="${action}"]`)!.click();
  const has = (action: string) => host.querySelector(`[data-tg="${action}"]`) !== null;
  const status = () => host.querySelector(".telegram-alerts-status")?.textContent ?? "";
  return { host, client, sign, storage: deps.storage as ReturnType<typeof memoryStorage>, click, has, status, setSession: (s: WalletSession) => listener(s) };
}

it("stays hidden with no board server, no bot username, or no wallet", async () => {
  expect(setup({ client: null }).host.hidden).toBe(true);
  expect(setup({ bot: "" }).host.hidden).toBe(true);
  const signedOut = setup({}, { accountId: null, networkId: null });
  await Promise.resolve();
  expect(signedOut.host.hidden).toBe(true);
  expect(signedOut.client.status).not.toHaveBeenCalled();
});

it("offers to link, without asking the server anything, in a browser with no token", async () => {
  const t = setup();
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  expect(t.host.hidden).toBe(false);
  expect(t.client.status).not.toHaveBeenCalled();
  expect(t.client.challenge).not.toHaveBeenCalled();
});

it("tells a sign-in that cannot sign messages so, and offers no control", async () => {
  const t = setup({ canSign: async () => false });
  await vi.waitFor(() => expect(t.status()).toContain("Google or email"));
  expect(t.host.querySelectorAll("button, a")).toHaveLength(0);
  expect(t.client.challenge).not.toHaveBeenCalled();
});

it("links: shows the code and the bot link, signs exactly the server's challenge, keeps the token", async () => {
  const t = setup();
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  t.click("start");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  expect(t.client.challenge).toHaveBeenCalledWith(ALICE, "link");
  expect(t.host.querySelector(".telegram-alerts-code")!.textContent).toBe("ABCDEFGHJK");
  const open = t.host.querySelector<HTMLAnchorElement>('[data-tg="open-bot"]')!;
  expect(open.href).toBe("https://t.me/MetaPooBot?start=ABCDEFGHJK");
  expect(open.rel).toContain("noopener");
  expect(t.sign).not.toHaveBeenCalled(); // the wallet is asked only on the player's click

  t.click("sign");
  await vi.waitFor(() => expect(t.has("stop")).toBe(true));
  const asked = challenge();
  expect(t.sign).toHaveBeenCalledWith({
    accountId: ALICE,
    message: asked.message,
    recipient: asked.recipient,
    nonce: asked.nonce,
  });
  expect(t.client.link).toHaveBeenCalledWith(ALICE, "ABCDEFGHJK", {
    publicKey: "ed25519:abc",
    signature: "c2ln",
  });
  expect(t.storage.items.get(tokenStorageKey("mainnet", ALICE))).toBe("tok");
  expect(t.status()).toContain("Alerts are on");
});

it("signed before the bot has the code: waits, polls, and turns on when the bot gets it", async () => {
  vi.useFakeTimers();
  const t = setup();
  t.client.link.mockResolvedValue({ linked: false, token: "tok" });
  t.client.status.mockResolvedValue(false);
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  t.click("start");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  t.click("sign");
  await vi.waitFor(() => expect(t.host.textContent).toContain("Waiting for the bot"));
  expect(t.has("sign")).toBe(false);
  expect(t.has("open-bot")).toBe(true);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.client.status).toHaveBeenCalledTimes(1);
  expect(t.has("stop")).toBe(false);
  t.client.status.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.has("stop")).toBe(true);
  // And the polling stops there.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(t.client.status).toHaveBeenCalledTimes(2);
});

it("stops polling when the code runs out", async () => {
  vi.useFakeTimers();
  let now = 0;
  const t = setup({ now: () => now });
  t.client.link.mockResolvedValue({ linked: false, token: "tok" });
  t.client.status.mockResolvedValue(false);
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  t.click("start");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  t.click("sign");
  await vi.waitFor(() => expect(t.host.textContent).toContain("Waiting for the bot"));
  now = 10 * 60_000;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.status()).toContain("ran out");
  const calls = t.client.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(t.client.status.mock.calls.length).toBe(calls);
});

it("a wallet that says no changes nothing and keeps the code; a refused key ends it", async () => {
  const t = setup();
  t.sign.mockRejectedValueOnce(new Error("User rejected the request"));
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  t.click("start");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  t.click("sign");
  await vi.waitFor(() => expect(t.status()).toContain("did not sign"));
  expect(t.client.link).not.toHaveBeenCalled();
  expect(t.has("sign")).toBe(true);
  expect(t.storage.items.size).toBe(0);

  t.client.link.mockRejectedValueOnce(new TelegramAlertsError("wrong-key"));
  t.click("sign");
  await vi.waitFor(() => expect(t.status()).toContain("full-access"));
  expect(t.has("start")).toBe(true);
  expect(t.storage.items.size).toBe(0);
});

it("shows linked from this browser's token, and forgets a token the server no longer knows", async () => {
  const key = tokenStorageKey("mainnet", ALICE);
  const linked = setup({ storage: memoryStorage({ [key]: "tok" }) });
  await vi.waitFor(() => expect(linked.has("stop")).toBe(true));
  expect(linked.client.status).toHaveBeenCalledWith(ALICE, "tok");

  const storage = memoryStorage({ [key]: "old" });
  const stale = setup({ storage });
  stale.client.status.mockResolvedValue(null);
  await vi.waitFor(() => expect(stale.has("start")).toBe(true));
  expect(storage.items.has(key)).toBe(false);
});

it("an unreachable server is reported as unavailable, not as off, and the token is kept", async () => {
  const key = tokenStorageKey("mainnet", ALICE);
  const storage = memoryStorage({ [key]: "tok" });
  const t = setup({ storage });
  t.client.status.mockRejectedValue(new TelegramAlertsError("unavailable"));
  await vi.waitFor(() => expect(t.status()).toContain("unavailable"));
  expect(storage.items.get(key)).toBe("tok");
});

it("stopping asks the wallet to sign an unlink challenge, and only then forgets the token", async () => {
  const key = tokenStorageKey("mainnet", ALICE);
  const storage = memoryStorage({ [key]: "tok" });
  const t = setup({ storage });
  const unlinkChallenge = { ...challenge("ZYXWVUTSRQ"), message: `Stop Telegram alerts for ${ALICE} on Meta Poo. Code: ZYXWVUTSRQ` };
  t.client.challenge.mockResolvedValue(unlinkChallenge);
  await vi.waitFor(() => expect(t.has("stop")).toBe(true));
  t.click("stop");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  expect(t.client.challenge).toHaveBeenCalledWith(ALICE, "unlink");
  expect(t.client.unlink).not.toHaveBeenCalled();

  // Changing your mind costs nothing.
  t.click("cancel");
  expect(t.has("stop")).toBe(true);
  expect(storage.items.get(key)).toBe("tok");

  t.click("stop");
  await vi.waitFor(() => expect(t.has("sign")).toBe(true));
  t.click("sign");
  await vi.waitFor(() => expect(t.status()).toContain("Alerts are off"));
  expect(t.sign).toHaveBeenLastCalledWith(expect.objectContaining({ message: unlinkChallenge.message }));
  expect(t.client.unlink).toHaveBeenCalledWith(ALICE, "ZYXWVUTSRQ", { publicKey: "ed25519:abc", signature: "c2ln" });
  expect(storage.items.has(key)).toBe(false);
  expect(t.has("start")).toBe(true);
});

it("a late answer for one account never paints over another", async () => {
  let release: (c: TelegramChallenge) => void = () => {};
  const t = setup();
  t.client.challenge.mockReturnValue(new Promise<TelegramChallenge>((resolve) => (release = resolve)));
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  t.click("start");
  t.setSession({ accountId: "bob.near", networkId: "mainnet" });
  await vi.waitFor(() => expect(t.has("start")).toBe(true));
  release(challenge());
  await Promise.resolve();
  await Promise.resolve();
  expect(t.host.querySelector(".telegram-alerts-code")).toBeNull();
  t.setSession({ accountId: null, networkId: null });
  await vi.waitFor(() => expect(t.host.hidden).toBe(true));
});
