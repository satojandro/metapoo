import { PublicKey } from "@near-js/crypto";
import { encodeBase58 } from "../../drawing-session";
import type { ReadinessRpc } from "../account-readiness";
import type { HostIdentity, SessionStorage } from "./session";
import type { PrivyReview } from "./approval";
import { sendRecord } from "../send/plan";
export interface PendingSelfCustodyKey extends HostIdentity { publicKey: string; kind: "add-full-access" | "remove-own-key"; createdAtMs: number }
const KEY = "metapoo:privy:pending-self-custody:v1";
export function setPrivyPendingSelfCustodyKey(value: PendingSelfCustodyKey | null, storage: SessionStorage): void {
  if (value) storage.setItem(KEY, JSON.stringify(value)); else storage.removeItem(KEY);
}
export function getPrivyPendingSelfCustodyKey(storage: SessionStorage, now = Date.now()): PendingSelfCustodyKey | null {
  try {
    const raw = storage.getItem(KEY); if (!raw || raw.length > 2048) return null;
    const v = JSON.parse(raw) as PendingSelfCustodyKey;
    if (!v || typeof v.accountId !== "string" || !["mainnet", "testnet"].includes(v.networkId) || !Number.isSafeInteger(v.sessionEpoch) || v.sessionEpoch < 0 || !["add-full-access", "remove-own-key"].includes(v.kind) || !Number.isSafeInteger(v.createdAtMs) || now < v.createdAtMs || now - v.createdAtMs >= 600000) return null;
    parseCustodyPublicKey(v.publicKey); return v;
  } catch { return null; }
}
export function parseCustodyPublicKey(input: string): string {
  const value = input.trim();
  if (/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i.test(value) || [12, 24].includes(value.split(/\s+/).length)) throw new Error("That looks like a private key. Paste only your public key.");
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error("Enter an ed25519 public key.");
  try {
    const key = PublicKey.fromString(value);
    if (key.data.length !== 32 || key.toString() !== value) throw new Error();
    return value;
  } catch { throw new Error("Enter a 32-byte public key, never a private key or recovery phrase."); }
}
export function privyPublicKey(account: string): string {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("Invalid Privy account.");
  return `ed25519:${encodeBase58(Uint8Array.from(account.match(/../g)!, s => parseInt(s, 16)))}`;
}
export async function custodyKeyPermission(rpc: ReadinessRpc, account: string, key: string): Promise<unknown | null> {
  try { return sendRecord(await rpc("query", {request_type: "view_access_key", finality: "final", account_id: account, public_key: key})).permission; }
  catch (error) {
    const e = error as {name?: string; cause?: {name?: string}};
    if (e?.name === "UNKNOWN_ACCESS_KEY" || e?.cause?.name === "UNKNOWN_ACCESS_KEY") return null;
    throw new Error("We couldn't check this key. Retry.");
  }
}
/** Separate dispatch leaves the existing drawing-key AddKey/DeleteKey branches intact. */
export function reviewSelfCustodyKey(transactions: readonly unknown[], host: HostIdentity, pending: PendingSelfCustodyKey | null, permission: unknown, drawingKey?: string): PrivyReview | null {
  if (transactions.length !== 1) return null;
  const tx = sendRecord(transactions[0]);
  if (!Array.isArray(tx.actions) || tx.actions.length !== 1) return null;
  const action = sendRecord(tx.actions[0]), params = sendRecord(action.params);
  const adding = action.type === "AddKey" && sendRecord(params.accessKey).permission === "FullAccess";
  const removing = action.type === "DeleteKey" && pending?.kind === "remove-own-key";
  if (!adding && !removing) return null;
  const key = parseCustodyPublicKey(String(params.publicKey));
  if (tx.receiverId !== host.accountId || key === privyPublicKey(host.accountId) || key === drawingKey || !pending || pending.accountId !== host.accountId || pending.networkId !== host.networkId || pending.sessionEpoch !== host.sessionEpoch || pending.publicKey !== key || pending.kind !== (adding ? "add-full-access" : "remove-own-key") || Date.now() < pending.createdAtMs || Date.now() - pending.createdAtMs >= 600000 || (adding ? permission !== null : permission !== "FullAccess")) throw new Error("Self-custody request does not match a verified pending key.");
  return {eyebrow: "Self-custody", title: adding ? "Add your own key" : "Remove your key", lede: adding ? "This gives a key you control full access to your account. Privy keeps its key too, so both can sign." : "This removes access for this key. Privy keeps its sign-in key.", rows: [{label: adding ? "Adds" : "Removes", value: "A full-access key"}, {label: "Key", value: adding ? `${key.slice(0, 14)}…••••••••` : key, mono: true}, {label: "Account", value: host.accountId, mono: true}], notes: ["Both keys can move all your funds. If this key isn't yours, or someone else can see it, they can empty this account. Meta Poo can't reverse it."], details: [], approveLabel: adding ? "Add my key" : "Remove my key", requiresFunds: true, requiresHost: true, ...(adding ? {confirm: {suffix: key.slice(-8), acknowledgement: "I created this key myself and I'm the only one who has it"}} : {})};
}
