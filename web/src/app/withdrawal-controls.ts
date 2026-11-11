import type { AppServices } from "./services";
import { SEND_ENABLED, SELF_CUSTODY_ENABLED } from "../integrations/send/config";
import { isConnectedPrivyWallet } from "../wallet";
import "./send-sheet.css";

export function mountWithdrawalControls(host: HTMLElement, services: AppServices, refresh: () => void): () => void {
  if (!SEND_ENABLED && !SELF_CUSTODY_ENABLED) return () => {};
  let disposed = false, generation = 0;
  const cleanups: (() => void)[] = [];
  // Two different destinations behind two similar-looking buttons: each gets a sentence,
  // under one heading, so Send is not mistaken for "get my key out".
  const block = document.createElement("section");
  block.className = "wallet-move-funds";
  block.innerHTML = `<h2>Move funds out</h2>`;
  const row = (label: string, line: string) => {
    const item = document.createElement("div");
    item.className = "wallet-move-row";
    const button = document.createElement("button");
    button.type = "button"; button.className = "action secondary mp-withdrawal-open"; button.hidden = true;
    button.textContent = label;
    const copy = document.createElement("p");
    copy.textContent = line;
    item.append(button, copy);
    item.hidden = true;
    block.append(item);
    return { item, button };
  };
  const sendRow = row("Send", "Move NEAR or TOILET to another NEAR account.");
  const custodyRow = row("Self-custody", "Add a key you control, so this wallet is not only recoverable through your sign-in.");
  host.append(block);
  let closeDialog: (() => void) | undefined;
  const open = async (kind: "send" | "custody") => {
    closeDialog?.();
    const dialog = document.createElement("dialog"); dialog.className = "mp-withdrawal-dialog"; dialog.setAttribute("aria-label", kind === "send" ? "Send" : "Self-custody");
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close";
    const body = document.createElement("div"); dialog.append(close, body); document.body.append(dialog);
    let unmount: (() => void) | undefined, closed = false;
    closeDialog = () => { closed = true; unmount?.(); dialog.remove(); };
    close.onclick = closeDialog; dialog.oncancel = closeDialog;
    if (dialog.showModal) dialog.showModal(); else dialog.open = true;
    try {
      if (kind === "send") { const module = await import("./send-sheet"); if (!disposed && !closed) unmount = module.mountSendSheet(body, refresh); }
      else { const module = await import("./self-custody-panel"); if (!disposed && !closed) unmount = module.mountSelfCustodyPanel(body); }
    } catch { body.textContent = "These controls couldn't load. Close and retry."; }
  };
  sendRow.button.onclick = () => void open("send"); custodyRow.button.onclick = () => void open("custody");
  const update = async () => {
    const version = ++generation, connected = !!services.wallet.getSession().accountId;
    closeDialog?.(); closeDialog = undefined;
    sendRow.button.hidden = sendRow.item.hidden = !SEND_ENABLED || !connected;
    custodyRow.button.hidden = custodyRow.item.hidden = true;
    if (SELF_CUSTODY_ENABLED && connected && await isConnectedPrivyWallet() && !disposed && generation === version) {
      custodyRow.button.hidden = custodyRow.item.hidden = false;
    }
    // An empty heading is worse than no heading: the block appears only with a control in it.
    block.hidden = sendRow.item.hidden && custodyRow.item.hidden;
  };
  cleanups.push(services.wallet.subscribe(() => void update())); void update();
  return () => { disposed = true; generation++; closeDialog?.(); cleanups.forEach(fn => fn()); block.remove(); };
}
