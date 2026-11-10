// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { mountPrivySignPage } from "./sign-page";
import { setPrivyHostIdentity } from "./session";
import { setPrivyPendingSelfCustodyKey } from "./self-custody";
import type { PrivyPageRuntime } from "./runtime";
const pages: {dispose(): void}[] = [];
afterEach(() => { pages.forEach(p => p.dispose()); pages.length = 0; localStorage.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const flush = () => new Promise(r => setTimeout(r, 0));
it("requires the masked suffix and checkbox, then rejects an intent cleared during readiness", async () => {
  const address = "12".repeat(32), key = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const host = {accountId: address, networkId: "testnet" as const, sessionEpoch: 1};
  setPrivyHostIdentity(host, localStorage);
  setPrivyPendingSelfCustodyKey({...host, publicKey: key, kind: "add-full-access", createdAtMs: Date.now()}, localStorage);
  vi.stubGlobal("fetch", vi.fn(async () => ({ok: true, json: async () => ({error: {cause: {name: "UNKNOWN_ACCESS_KEY"}}})})));
  const sign = vi.fn();
  const runtime: PrivyPageRuntime = {
    initialize: vi.fn(), handshake: vi.fn(async () => ({targetOrigin: "http://localhost:5173", sign, payload: {kind: "signAndSendTransaction", network: "testnet", receiverId: address, actions: [{type: "AddKey", params: {publicKey: key, accessKey: {permission: "FullAccess"}}}]}})),
    user: {get: vi.fn(async () => ({user: {linked_accounts: [{type: "wallet", chain_type: "near", id: "w", address}]}}))}, createNearWallet: vi.fn(), logout: vi.fn(), sendEmailCode: vi.fn(), loginEmail: vi.fn(), googleUrl: vi.fn(), completeOAuth: vi.fn(), assertReady: vi.fn(async () => {setPrivyPendingSelfCustodyKey(null, localStorage);}), rejectBeforeBroadcast: vi.fn(), dispose: vi.fn(),
  };
  const root = document.createElement("main"); document.body.append(root);
  const page = mountPrivySignPage(root, {runtime, config: {appId: "app", clientId: "client", network: "testnet", origin: "http://localhost:5173", signPageUrl: "http://localhost:5173/privy-sign.html", rpcUrl: "https://rpc.testnet.near.org", selfCustodyEnabled: true}, storage: localStorage, boardContractId: "wall.testnet", location: {href: "http://localhost:5173/privy-sign.html"}, navigate: vi.fn(), replaceUrl: vi.fn(), close: vi.fn()}); pages.push(page); await page.ready;
  const approve = [...root.querySelectorAll("button")].find(b => b.textContent === "Add my key")!;
  expect(approve).toBeDefined(); expect(approve.disabled).toBe(true);
  expect(root.innerHTML).not.toContain(key.slice(-8));
  const suffix = root.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!, ack = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  suffix.value = key.slice(-8); suffix.dispatchEvent(new Event("input")); expect(approve.disabled).toBe(true);
  ack.checked = true; ack.dispatchEvent(new Event("change")); expect(approve.disabled).toBe(false);
  approve.click(); await flush(); await flush(); expect(sign).not.toHaveBeenCalled();
});
