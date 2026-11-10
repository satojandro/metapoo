import type { ApprovedNearTransaction, ApprovedTransactionRequest } from "../types";
export const SEND_GAS_FLOOR_YOCTO = "10000000000000000000000";
export const SEND_STORAGE_CAP_YOCTO = SEND_GAS_FLOOR_YOCTO;
export const SEND_FT_TRANSFER_GAS = "30000000000000";
export const SEND_STORAGE_DEPOSIT_GAS = "10000000000000";
// Transfer has no attached gas field. Budget a conservative protocol-action envelope.
export const SEND_NATIVE_GAS = "1000000000000";
export interface SendToken { contractId: string; symbol: string; decimals: number }
export interface SendPolicy {
  enabled: boolean;
  tokens: readonly SendToken[];
  blockedRecipients: readonly string[];
  storageMinimums: Readonly<Record<string, string>>;
}
export interface SendDescription {
  recipient: string; amount: string; token?: SendToken; registrationDeposit: string;
}
export function sendRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid transfer request.");
  return value as Record<string, unknown>;
}
export function sendAtomic(value: unknown, positive = false): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,39})$/.test(value) || (positive && BigInt(value) === 0n)) throw new Error("Invalid transfer amount.");
  return value;
}
export function sendAccount(value: unknown): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value)) throw new Error("That isn't a NEAR account.");
  return value;
}
/**
 * Accept a case-only correction of a valid account id; never rewrite anything else.
 * Spec §5.1: an uppercase paste must not silently become a different account, and an input
 * that is invalid for any reason other than case must be rejected, not repaired.
 */
export function normalizeRecipient(input: string): string {
  const value = input.trim();
  try { return sendAccount(value); } catch { /* maybe only the case is wrong */ }
  const lowered = value.toLowerCase();
  if (lowered === value) return sendAccount(value); // rethrows the original rejection
  return sendAccount(lowered);
}
/** Send args are flat objects. Scan their JSON keys before parsing to reject duplicates,
 * including escaped spellings, which JSON.parse otherwise silently overwrites. */
export function decodeSendArgs(value: unknown): Record<string, unknown> {
  if (value instanceof Uint8Array) {
    const json = new TextDecoder("utf-8", {fatal: true}).decode(value);
    const keys = [...json.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate transfer argument.");
    value = JSON.parse(json);
  }
  return sendRecord(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) throw new Error("Unexpected transfer fields.");
}
export function parseSendAmount(input: string, decimals: number): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error("Enter an exact decimal amount.");
  return sendAtomic(BigInt(match[1] + (match[2] ?? "").padEnd(decimals, "0")).toString(), true);
}
/** Claims ALL send-like actions before generic function-call rendering can accept them. */
export function classifySend(transactions: readonly unknown[], signer: string, policy: SendPolicy): SendDescription | null {
  const txs = transactions.map(sendRecord);
  for (const tx of txs) {
    sendAccount(tx.receiverId);
    if (tx.signerId !== undefined && tx.signerId !== signer) throw new Error("Signing account changed.");
    if (!Array.isArray(tx.actions) || !tx.actions.length || tx.actions.length > 16) throw new Error("Invalid transaction actions.");
  }
  const claimed = txs.some(tx => (tx.actions as unknown[]).some(value => {
    const a = sendRecord(value), p = sendRecord(a.params);
    if (a.type === "Transfer") return true;
    if (a.type !== "FunctionCall") return false;
    if (p.methodName === "ft_transfer") return true;
    if (p.methodName !== "storage_deposit") return false;
    const args = decodeSendArgs(p.args);
    return args.account_id !== undefined && args.account_id !== signer;
  }));
  if (!claimed) return null;
  if (!policy.enabled || txs.length !== 1) throw new Error("This transfer request isn't one Meta Poo can show you safely.");
  const tx = txs[0], actions = (tx.actions as unknown[]).map(sendRecord);
  const last = actions[actions.length - 1], p = sendRecord(last.params);
  if (last.type === "Transfer") {
    if (actions.length !== 1) throw new Error("Send must contain only its transfer.");
    exact(p, ["deposit"]);
    const recipient = sendAccount(tx.receiverId);
    if (recipient === signer) throw new Error("That's your own account.");
    return {recipient, amount: sendAtomic(p.deposit, true), registrationDeposit: "0"};
  }
  const token = policy.tokens.find(t => t.contractId === tx.receiverId);
  if (!token) throw new Error("Meta Poo can only send TOILET and mPOO from this window.");
  if (last.type !== "FunctionCall" || p.methodName !== "ft_transfer" || actions.length > 2) throw new Error("Invalid token send shape.");
  exact(p, ["methodName", "args", "gas", "deposit"]);
  const args = decodeSendArgs(p.args); exact(args, ["receiver_id", "amount"]);
  const recipient = sendAccount(args.receiver_id);
  if (recipient === signer || recipient === token.contractId || policy.blockedRecipients.includes(recipient)) throw new Error("Send to a different personal account; tokens sent to this contract cannot be recovered.");
  if (p.deposit !== "1" || BigInt(sendAtomic(p.gas, true)) > 50_000_000_000_000n) throw new Error("Invalid token transfer deposit or gas.");
  let registrationDeposit = "0";
  if (actions.length === 2) {
    const first = actions[0], reg = sendRecord(first.params), a = decodeSendArgs(reg.args);
    exact(reg, ["methodName", "args", "gas", "deposit"]); exact(a, ["account_id", "registration_only"]);
    registrationDeposit = sendAtomic(reg.deposit, true);
    if (first.type !== "FunctionCall" || reg.methodName !== "storage_deposit" || a.account_id !== recipient || a.registration_only !== true || BigInt(sendAtomic(reg.gas, true)) > 30_000_000_000_000n || registrationDeposit !== policy.storageMinimums[token.contractId] || BigInt(registrationDeposit) > BigInt(SEND_STORAGE_CAP_YOCTO)) throw new Error("Unreviewed recipient registration.");
  }
  return {recipient, amount: sendAtomic(args.amount, true), token, registrationDeposit};
}
export function validateSendTransaction(tx: ApprovedNearTransaction, request: ApprovedTransactionRequest, policy: SendPolicy): void {
  if (request.purpose !== "send" || request.transactions.length !== 1 || !classifySend([tx], request.context.accountId, policy)) throw new Error("Invalid Send approval.");
}
