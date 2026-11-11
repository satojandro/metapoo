import { CONTRACT_ID, RPC_URL } from "../config";
import { getAcquisitionContext, isConnectedPrivyWallet, signAndSendSelfCustodyKey } from "../wallet";
import { createAcquisitionRpc } from "../integrations/rpc";
import { parseCustodyPublicKey, privyPublicKey } from "../integrations/privy/self-custody";
import { reconcileCustodyAttempt } from "../integrations/privy/custody-attempt";
import { sendRecord } from "../integrations/send/plan";
import { sameIdentity } from "../integrations/types";
import "./self-custody.css";

/**
 * The readable form of an ed25519 key, for a row that has to fit a phone.
 *
 * `shortAccount` is for account ids and checks a 64-hex shape, so it leaves a key untouched;
 * a key is a different kind of fact and gets its own ends. The full string still reaches the
 * player through the row's `title` and `aria-label`, so nothing is hidden from a screen reader.
 */
export function shortCustodyKey(key: string): string {
  return key.length > 18 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key;
}

export function mountSelfCustodyPanel(root: HTMLElement): () => void {
  // A key is not a sentence: name, what it can do, and the key itself each get a row.
  // The explanatory opening and the approval wording are pending owner sign-off, so the
  // existing sentences below are left exactly as they were and the structure sits around them.
  root.innerHTML = `<section class="mp-custody"><h2>Self-custody</h2><p class="mp-custody-status" role="status"></p><button type="button" class="mp-btn" data-refresh>Refresh keys</button><dl class="mp-custody-keys" data-keys></dl><p class="mp-custody-risk">Both full-access keys can move all your funds. Keep your own key safe. Meta Poo can't recover it.</p><h3>Add your own key</h3><ol class="mp-custody-steps"><li>Create a key in a wallet you control</li><li>Paste its public key here — never a private key or recovery phrase</li><li>Approve the change in your wallet</li></ol><label>Your public key<input autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ed25519:…"></label><button type="button" class="mp-btn mp-btn-primary" data-add>Add your own key</button><p class="mp-custody-note">Removing Privy's key requires a verified external wallet connected to this same account. This option is awaiting wallet compatibility testing.</p></section>`;
  const status = root.querySelector<HTMLElement>('[role="status"]')!, list = root.querySelector<HTMLElement>("[data-keys]")!, input = root.querySelector("input")!;
  // Created here rather than in the template so the panel's static copy stays untouched.
  const discard = document.createElement("button");
  discard.type = "button"; discard.className = "mp-btn"; discard.textContent = "I've checked — discard this attempt"; discard.hidden = true;
  root.querySelector("[data-refresh]")!.after(discard);
  let disposed = false, busy = false, generation = 0;
  const run = async (task: () => Promise<void>) => { if (disposed || busy) return; busy = true; root.querySelectorAll("button").forEach(b => b.disabled = true); try { await task(); } catch (e) { if (!disposed) status.textContent = e instanceof Error ? e.message : "We couldn't load your keys. Retry."; } finally { busy = false; if (!disposed) root.querySelectorAll("button").forEach(b => b.disabled = false); } };
  const actionButton = (label: string) => { const button = document.createElement("button"); button.type = "button"; button.className = "mp-btn"; button.textContent = label; return button; };
  /** One key: its name, what it may do, the shortened key, and — when removable — its control. */
  const keyRow = (name: string, access: string, key: string) => {
    const group = document.createElement("div"); group.className = "mp-custody-key"; group.setAttribute("data-key-row", "");
    const title = document.createElement("dt"); title.className = "mp-custody-key-name"; title.textContent = name;
    const permission = document.createElement("dd"); permission.className = "mp-custody-key-access"; permission.textContent = access;
    const fact = document.createElement("dd"); fact.className = "mp-custody-key-fact";
    const value = document.createElement("span"); value.className = "mp-custody-key-value"; value.setAttribute("data-key-value", "");
    value.textContent = shortCustodyKey(key); value.title = key; value.setAttribute("aria-label", key);
    fact.append(value);
    const action = document.createElement("dd"); action.className = "mp-custody-key-action";
    group.append(title, permission, fact, action);
    return { group, action };
  };
  /**
   * Removing a key asks in the panel, not in the browser's `confirm()` box: the question
   * belongs beside the key it is about, and the destructive button is only armed by a click
   * on the confirm button — nothing signs from this row before that.
   */
  const askToRemove = (action: HTMLElement, trigger: HTMLButtonElement, remove: () => Promise<void>) => {
    const confirm = document.createElement("div"); confirm.className = "mp-custody-confirm"; confirm.setAttribute("data-confirm", ""); confirm.setAttribute("role", "group"); confirm.setAttribute("aria-label", "Confirm removing this key");
    const question = document.createElement("p"); question.textContent = "Remove this full-access key? Privy keeps its sign-in key.";
    const proceed = actionButton("Remove key"); proceed.classList.add("mp-custody-danger"); proceed.setAttribute("data-confirm-remove", "");
    const keep = actionButton("Keep it"); keep.setAttribute("data-keep", "");
    proceed.onclick = () => void run(remove);
    keep.onclick = () => { action.replaceChildren(trigger); trigger.focus(); };
    confirm.append(question, proceed, keep);
    action.replaceChildren(confirm);
    // The question is new content; focus follows it so a keyboard user is not left behind.
    proceed.focus();
  };
  const refresh = async () => {
    const context = getAcquisitionContext("custody-keys"), version = ++generation;
    if (!context || !await isConnectedPrivyWallet()) throw new Error("Connect your Privy account first.");
    status.textContent = "Loading keys…"; list.replaceChildren(); discard.hidden = true;
    const rpc = createAcquisitionRpc(RPC_URL);
    const result = sendRecord(await rpc("query", {request_type: "view_access_key_list", finality: "final", account_id: context.accountId}));
    if (disposed || generation !== version || !sameIdentity(context, getAcquisitionContext(context.operationId))) return;
    if (!Array.isArray(result.keys)) throw new Error("We couldn't load your keys. Retry.");
    const own = privyPublicKey(context.accountId); let privyPresent = false, otherFull = 0;
    const keys = result.keys.map(value => { const row = sendRecord(value); const permission = sendRecord(row.access_key).permission; return {key: String(row.public_key), permission}; });
    for (const {key, permission} of keys) {
      const full = permission === "FullAccess";
      if (key === own && full) privyPresent = true; else if (full) otherFull++;
      const fn = !full ? sendRecord(sendRecord(permission).FunctionCall) : null;
      const name = key === own ? "Privy (your sign-in)" : full ? "Your key" : fn?.receiver_id === CONTRACT_ID ? "Drawing key" : "Other limited key";
      // Copy approved 11 Nov (sign-off doc §3.3): a drawing key also spends the account's
      // credits, and any other limited key is only known to be scoped to one contract.
      const { group, action } = keyRow(name, full ? "Full access" : fn?.receiver_id === CONTRACT_ID ? "Limited access — can paint here and spend your credits" : "Limited access — one contract only", key);
      if (full && key !== own && key.startsWith("ed25519:")) {
        const trigger = actionButton("Remove this key"); trigger.setAttribute("data-remove", "");
        trigger.onclick = () => askToRemove(action, trigger, async () => {
          const current = getAcquisitionContext(crypto.randomUUID()); if (!current || !sameIdentity(context, current)) throw new Error("Account changed.");
          const outcome = await signAndSendSelfCustodyKey(current, key, "remove-own-key");
          if (disposed) return;
          // Refresh first, then say what happened: the removed key used to stay on screen with
          // its confirmation still open (review of PR #111, item 7).
          const message = outcome.confirmed ? "Key removed on chain." : "Key change unresolved. Check your keys again before trying another change.";
          await refresh();
          if (!disposed) status.textContent = message;
        });
        action.append(trigger);
      }
      list.append(group);
    }
    // A failed key change must not block every later payment: settle it against the chain.
    // A landed change clears the marker, a transaction that failed on chain clears it too, and
    // an attempt whose outcome was lost can only be cleared by the player saying they checked.
    let notice = "", unresolved = false;
    try {
      const settled = await reconcileCustodyAttempt(localStorage, context.networkId, context.accountId, rpc);
      if (settled.state === "failed") notice = "That key change failed on chain. Nothing changed, so you can try again.";
      if (settled.state === "unknown") { unresolved = true; notice = "A key change is still unresolved. Check your wallet's transaction history before trying again."; }
    } catch { notice = "We couldn't check the last key change. Retry."; }
    if (disposed || generation !== version) return;
    discard.hidden = !unresolved;
    status.textContent = `${notice ? `${notice} ` : ""}${!privyPresent ? "This account is now controlled by your own wallet. Connect with that wallet to continue." : otherFull ? "You and Privy can both sign for this account." : "Only Privy can sign for this account."}`;
  };
  root.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () => void run(refresh);
  discard.onclick = () => void run(async () => {
    const context = getAcquisitionContext("custody-keys"); if (!context) throw new Error("Connect your Privy account first.");
    const settled = await reconcileCustodyAttempt(localStorage, context.networkId, context.accountId, createAcquisitionRpc(RPC_URL), {discard: true});
    await refresh();
    status.textContent = settled.state === "applied" ? "Your key change did land on chain. Keys refreshed." : "Attempt discarded. Your keys are unchanged.";
    discard.hidden = true;
  });
  root.querySelector<HTMLButtonElement>("[data-add]")!.onclick = () => void run(async () => {
    // Do not persist or echo invalid input: it might be a pasted private key.
    let key: string; try { key = parseCustodyPublicKey(input.value); } catch (e) { input.value = ""; throw e; }
    const context = getAcquisitionContext(crypto.randomUUID()); if (!context) throw new Error("Connect first.");
    const outcome = await signAndSendSelfCustodyKey(context, key);
    if (!disposed) { input.value = ""; await refresh(); status.textContent = outcome.confirmed ? "Your full-access key is confirmed on chain. You and Privy can both sign." : "Key change unresolved. Check your keys again before trying another change."; }
  });
  void run(refresh);
  return () => { disposed = true; generation++; root.replaceChildren(); };
}
