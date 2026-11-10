import { CONTRACT_ID, RPC_URL } from "../config";
import { getAcquisitionContext, isConnectedPrivyWallet, signAndSendSelfCustodyKey } from "../wallet";
import { createAcquisitionRpc } from "../integrations/rpc";
import { parseCustodyPublicKey, privyPublicKey } from "../integrations/privy/self-custody";
import { sendRecord } from "../integrations/send/plan";
import { sameIdentity } from "../integrations/types";
import "./self-custody.css";
export function mountSelfCustodyPanel(root: HTMLElement): () => void {
  root.innerHTML = `<section class="mp-custody"><h2>Self-custody</h2><p role="status"></p><button type="button" data-refresh>Refresh keys</button><ul data-keys></ul><p>Both full-access keys can move all your funds. Keep your own key safe. Meta Poo can't recover it.</p><label>Your public key<input autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ed25519:…"></label><p>Create a key in a wallet you control. Paste only the public key. Never paste a private key or recovery phrase.</p><button type="button" data-add>Add your own key</button><p>Removing Privy's key requires a verified external wallet connected to this same account. This option is awaiting wallet compatibility testing.</p></section>`;
  const status = root.querySelector<HTMLElement>('[role="status"]')!, list = root.querySelector<HTMLElement>("[data-keys]")!, input = root.querySelector("input")!;
  let disposed = false, busy = false, generation = 0;
  const run = async (task: () => Promise<void>) => { if (disposed || busy) return; busy = true; root.querySelectorAll("button").forEach(b => b.disabled = true); try { await task(); } catch (e) { if (!disposed) status.textContent = e instanceof Error ? e.message : "We couldn't load your keys. Retry."; } finally { busy = false; if (!disposed) root.querySelectorAll("button").forEach(b => b.disabled = false); } };
  const refresh = async () => {
    const context = getAcquisitionContext("custody-keys"), version = ++generation;
    if (!context || !await isConnectedPrivyWallet()) throw new Error("Connect your Privy account first.");
    status.textContent = "Loading keys…"; list.replaceChildren();
    const result = sendRecord(await createAcquisitionRpc(RPC_URL)("query", {request_type: "view_access_key_list", finality: "final", account_id: context.accountId}));
    if (disposed || generation !== version || !sameIdentity(context, getAcquisitionContext(context.operationId))) return;
    if (!Array.isArray(result.keys)) throw new Error("We couldn't load your keys. Retry.");
    const own = privyPublicKey(context.accountId); let privyPresent = false, otherFull = 0;
    const keys = result.keys.map(value => { const row = sendRecord(value); const permission = sendRecord(row.access_key).permission; return {key: String(row.public_key), permission}; });
    for (const {key, permission} of keys) {
      const full = permission === "FullAccess";
      if (key === own && full) privyPresent = true; else if (full) otherFull++;
      const row = document.createElement("li");
      const fn = !full ? sendRecord(sendRecord(permission).FunctionCall) : null;
      row.textContent = `${key === own ? "Privy (your sign-in)" : full ? "Your key" : fn?.receiver_id === CONTRACT_ID ? "Drawing key" : "Other limited key"} · ${full ? "Full access" : "Limited access"} · ${key}`;
      if (full && key !== own && key.startsWith("ed25519:")) {
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove this key";
        remove.onclick = () => void run(async () => {
          if (!window.confirm("Remove this full-access key? Privy keeps its sign-in key.")) return;
          const current = getAcquisitionContext(crypto.randomUUID()); if (!current || !sameIdentity(context, current)) throw new Error("Account changed.");
          const outcome = await signAndSendSelfCustodyKey(current, key, "remove-own-key");
          if (!disposed) status.textContent = outcome.confirmed ? "Key removed on chain." : "Key change unresolved. Refresh before trying again.";
        }); row.append(remove);
      }
      list.append(row);
    }
    const pendingKey = `metapoo:custody:attempt:${context.networkId}:${context.accountId}`;
    const raw = localStorage.getItem(pendingKey);
    if (raw && raw.length < 2048) {
      const pending = JSON.parse(raw) as {kind: string; publicKey: string};
      if (pending.kind === "add-full-access" ? keys.some(k => k.key === pending.publicKey && k.permission === "FullAccess") : pending.kind === "remove-own-key" && !keys.some(k => k.key === pending.publicKey)) localStorage.removeItem(pendingKey);
    }
    status.textContent = !privyPresent ? "This account is now controlled by your own wallet. Connect with that wallet to continue." : otherFull ? "You and Privy can both sign for this account." : "Only Privy can sign for this account.";
  };
  root.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () => void run(refresh);
  root.querySelector<HTMLButtonElement>("[data-add]")!.onclick = () => void run(async () => {
    // Do not persist or echo invalid input: it might be a pasted private key.
    let key: string; try { key = parseCustodyPublicKey(input.value); } catch (e) { input.value = ""; throw e; }
    const context = getAcquisitionContext(crypto.randomUUID()); if (!context) throw new Error("Connect first.");
    const outcome = await signAndSendSelfCustodyKey(context, key);
    if (!disposed) { input.value = ""; await refresh(); status.textContent = outcome.confirmed ? "Your full-access key is confirmed on chain. You and Privy can both sign." : "Key change unresolved. Refresh before trying again."; }
  });
  void run(refresh);
  return () => { disposed = true; generation++; root.replaceChildren(); };
}
