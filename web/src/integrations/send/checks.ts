import type { ReadinessRpc } from "../account-readiness";
import { classifySend, sendRecord, sendAtomic, type SendPolicy, type SendDescription } from "./plan";
export async function sendView(rpc: ReadinessRpc, contract: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const result = sendRecord(await rpc("query", {request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(String.fromCharCode(...bytes))}));
  if (!Array.isArray(result.result) || !result.result.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("Invalid contract response.");
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(new Uint8Array(result.result)));
}
export async function checkSendRecipient(rpc: ReadinessRpc, recipient: string): Promise<void> {
  // Only a NEAR implicit account may be new; no RPC failure is interpreted as absence.
  if (/^[0-9a-f]{64}$/.test(recipient)) return;
  try { await rpc("query", {request_type: "view_account", finality: "final", account_id: recipient}); }
  catch (error) {
    const e = error as {name?: string; cause?: {name?: string}};
    if (e?.name === "UNKNOWN_ACCOUNT" || e?.cause?.name === "UNKNOWN_ACCOUNT") throw new Error("That account doesn't exist on NEAR yet.");
    throw new Error("We couldn't check that account right now. Try again.");
  }
}
/** Reads are supplied by the signing page itself, never by the requesting payload. */
export async function checkSend(transactions: readonly unknown[], signer: string, policy: SendPolicy, rpc: ReadinessRpc): Promise<{policy: SendPolicy; send: SendDescription | null; alreadyRegistered: boolean}> {
  // Discover registration minima only for contracts on the build-time allowlist.
  const minimums: Record<string, string> = {};
  for (const value of transactions) {
    const tx = sendRecord(value);
    if (!policy.tokens.some(t => t.contractId === tx.receiverId) || !Array.isArray(tx.actions) || !tx.actions.some(a => sendRecord(sendRecord(a).params).methodName === "ft_transfer")) continue;
    if (tx.actions.some(a => sendRecord(sendRecord(a).params).methodName === "storage_deposit")) {
      const bounds = sendRecord(await sendView(rpc, String(tx.receiverId), "storage_balance_bounds"));
      minimums[String(tx.receiverId)] = sendAtomic(bounds.min, true);
    }
  }
  const checked = {...policy, storageMinimums: minimums};
  const send = classifySend(transactions, signer, checked);
  if (!send) return {policy: checked, send, alreadyRegistered: false};
  await checkSendRecipient(rpc, send.recipient);
  let alreadyRegistered = false;
  if (send.token) {
    const board = policy.blockedRecipients[0];
    if (board) {
      const revenue = sendRecord(await sendView(rpc, board, "get_revenue_state"));
      if (revenue.staking_contract === send.recipient) throw new Error("Tokens sent to the staking contract cannot be recovered.");
    }
    const metadata = sendRecord(await sendView(rpc, send.token.contractId, "ft_metadata"));
    if (metadata.decimals !== send.token.decimals) throw new Error("We couldn't check this token right now. Nothing was sent.");
    const storage = await sendView(rpc, send.token.contractId, "storage_balance_of", {account_id: send.recipient});
    if (storage !== null) { sendAtomic(sendRecord(storage).total); alreadyRegistered = true; }
    if (!alreadyRegistered && send.registrationDeposit === "0") throw new Error("The recipient must be registered. Go back and send again.");
  }
  return {policy: checked, send, alreadyRegistered};
}
