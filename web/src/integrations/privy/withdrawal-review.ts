import { reviewPrivyRequest, type SigningSession } from "./approval";
import type { PrivyConfig } from "./config";
import { getPrivyHostIdentity, getPrivyPendingDrawingAuthorization, type PrivyNearWallet, type SessionStorage } from "./session";
import { checkSend } from "../send/checks";
import { createAcquisitionRpc } from "../rpc";
import { sendRecord } from "../send/plan";
import { getPrivyPendingSelfCustodyKey, custodyKeyPermission } from "./self-custody";

/** Both the first render and the approval click perform independent chain reads. */
export async function reviewWithdrawalRequest(session: SigningSession, config: PrivyConfig, wallet: PrivyNearWallet, storage: SessionStorage, board: string, drawingKey?: string) {
  const payload = sendRecord(session.payload);
  const txs = payload.kind === "signAndSendTransaction" ? [payload] : payload.transactions;
  let checks: Parameters<typeof reviewPrivyRequest>[7];
  if (Array.isArray(txs) && txs.length > 0 && txs.length <= 16) {
    const rpc = createAcquisitionRpc(config.rpcUrl);
    // Existing non-withdrawal requests retain their synchronous review and avoid new RPC reads.
    const sendLike = txs.some(tx => Array.isArray(tx.actions) && tx.actions.some((a: {type?: string; params?: {methodName?: string}}) => a.type === "Transfer" || a.params?.methodName === "ft_transfer" || a.params?.methodName === "storage_deposit"));
    if (sendLike) {
      const result = await checkSend(txs, wallet.address, {enabled: config.sendEnabled === true, tokens: config.sendTokens ?? [], blockedRecipients: [board, ...(config.sendBlockedRecipients ?? [])], storageMinimums: {}}, rpc);
      checks = {sendPolicy: result.policy, alreadyRegistered: result.alreadyRegistered};
    }
    const pending = getPrivyPendingSelfCustodyKey(storage);
    if (config.selfCustodyEnabled && pending && txs.length === 1 && txs[0].actions?.length === 1 && txs[0].actions[0].params?.publicKey === pending.publicKey) {
      const permission = await custodyKeyPermission(rpc, wallet.address, pending.publicKey);
      if (JSON.stringify(pending) !== JSON.stringify(getPrivyPendingSelfCustodyKey(storage))) throw new Error("Pending key changed. Review again.");
      checks = {...checks, pendingCustody: pending, keyPermission: permission};
    }
  }
  return reviewPrivyRequest(session, config, wallet, getPrivyHostIdentity(storage), board, drawingKey, getPrivyPendingDrawingAuthorization(storage), checks);
}
