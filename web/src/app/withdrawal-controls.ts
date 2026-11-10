import type { AppServices } from "./services";
import { SEND_ENABLED, SELF_CUSTODY_ENABLED } from "../integrations/send/config";
import { isConnectedPrivyWallet } from "../wallet";
import "./send-sheet.css";
export function mountWithdrawalControls(host: HTMLElement, services: AppServices, refresh: () => void): () => void {
  if (!SEND_ENABLED && !SELF_CUSTODY_ENABLED) return () => {};
  let disposed = false, generation = 0;
  const cleanups: (() => void)[] = [];
  const send = document.createElement("button"), custody = document.createElement("button");
  for (const button of [send, custody]) { button.type = "button"; button.className = "action secondary mp-withdrawal-open"; button.hidden = true; host.append(button); }
  send.textContent = "Send"; custody.textContent = "Self-custody";
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
  send.onclick = () => void open("send"); custody.onclick = () => void open("custody");
  const update = async () => {
    const version = ++generation, connected = !!services.wallet.getSession().accountId;
    closeDialog?.(); closeDialog = undefined;
    send.hidden = !SEND_ENABLED || !connected; custody.hidden = true;
    if (SELF_CUSTODY_ENABLED && connected && await isConnectedPrivyWallet() && !disposed && generation === version) custody.hidden = false;
  };
  cleanups.push(services.wallet.subscribe(() => void update())); void update();
  return () => { disposed = true; generation++; closeDialog?.(); cleanups.forEach(fn => fn()); send.remove(); custody.remove(); };
}
