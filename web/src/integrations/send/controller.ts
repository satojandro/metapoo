import { CONTRACT_ID, RPC_URL } from "../../config";
import { getAcquisitionContext, readConnectedAccountReadiness, signAndSendApprovedTransactions } from "../../wallet";
import { createAcquisitionRpc } from "../rpc";
import { estimateGasCeiling, computeSpendableNative } from "../gas-budget";
import { sameIdentity, type ApprovedNearAction, type ApprovedTransactionRequest, type OperationContext } from "../types";
import { SEND_POLICY } from "./config";
import { checkSendRecipient, sendView } from "./checks";
import { SEND_FT_TRANSFER_GAS, SEND_STORAGE_DEPOSIT_GAS, SEND_NATIVE_GAS, SEND_GAS_FLOOR_YOCTO, SEND_STORAGE_CAP_YOCTO, sendAtomic, sendAccount, sendRecord, parseSendAmount } from "./plan";
export interface SendPlan { request: ApprovedTransactionRequest; recipient: string; symbol: string; decimals: number; amount: string; maximum: string; registration: string; gas: string; tokenBalance?: string }
export async function planSend(context: OperationContext, asset: string, recipientInput: string, amountInput: string | "MAX"): Promise<SendPlan> {
  const assertCurrent = () => { if (!sameIdentity(context, getAcquisitionContext(context.operationId))) throw new Error("Your connected account changed. Nothing was sent."); };
  assertCurrent();
  if (!SEND_POLICY.enabled) throw new Error("Send is disabled.");
  const recipient = sendAccount(recipientInput.trim().toLowerCase());
  if (recipient === context.accountId) throw new Error("That's your own account. Enter a different recipient.");
  const token = SEND_POLICY.tokens.find(t => t.contractId === asset);
  if (asset !== "NEAR" && !token) throw new Error("This asset is unavailable.");
  const rpc = createAcquisitionRpc(RPC_URL);
  await checkSendRecipient(rpc, recipient); assertCurrent();
  const ready = await readConnectedAccountReadiness(context); assertCurrent();
  if (ready.state !== "ready") throw new Error("Balance unavailable — retry.");
  const gasPrice = sendAtomic(sendRecord(await rpc("gas_price", {block_id: ready.blockHash})).gas_price, true);
  let registration = "0", tokenBalance: string | undefined;
  if (token) {
    if (recipient === token.contractId || recipient === CONTRACT_ID) throw new Error("Tokens sent to this contract cannot be recovered.");
    // Staking is configured on chain, not in an environment variable.
    const revenue = sendRecord(await sendView(rpc, CONTRACT_ID, "get_revenue_state"));
    if (revenue.staking_contract === recipient) throw new Error("Tokens sent to the staking contract cannot be recovered.");
    const metadata = sendRecord(await sendView(rpc, token.contractId, "ft_metadata"));
    if (metadata.decimals !== token.decimals) throw new Error("Token metadata changed. Sending is paused.");
    tokenBalance = sendAtomic(await sendView(rpc, token.contractId, "ft_balance_of", {account_id: context.accountId}));
    const storage = await sendView(rpc, token.contractId, "storage_balance_of", {account_id: recipient});
    if (storage === null) {
      registration = sendAtomic(sendRecord(await sendView(rpc, token.contractId, "storage_balance_bounds")).min, true);
      if (BigInt(registration) > BigInt(SEND_STORAGE_CAP_YOCTO)) throw new Error("This token's registration cost has changed. Sending is paused.");
    } else sendAtomic(sendRecord(storage).total);
  }
  assertCurrent();
  const gasUnits = token ? BigInt(SEND_FT_TRANSFER_GAS) + (registration === "0" ? 0n : BigInt(SEND_STORAGE_DEPOSIT_GAS)) : BigInt(SEND_NATIVE_GAS);
  const gas = estimateGasCeiling(gasUnits.toString(), gasPrice);
  const budget = computeSpendableNative({spendableBeforeGasYocto: ready.spendableBeforeGasYocto, payableDepositsYocto: (BigInt(registration) + (token ? 1n : 0n)).toString(), gasCeilingYocto: gas, playReserveYocto: SEND_GAS_FLOOR_YOCTO});
  if (!budget.canPay) throw new Error("Add NEAR for network fees. Send keeps 0.01 NEAR for future fees.");
  const maximum = tokenBalance ?? budget.maxInputYocto;
  const amount = amountInput === "MAX" ? sendAtomic(maximum, true) : parseSendAmount(amountInput, token?.decimals ?? 24);
  if (BigInt(amount) > BigInt(maximum)) throw new Error("Your balance changed or the amount is too high. Check the amount. Send keeps 0.01 NEAR for fees.");
  const actions: ApprovedNearAction[] = token ? [
    ...(registration === "0" ? [] : [{type: "FunctionCall" as const, params: {methodName: "storage_deposit", args: {account_id: recipient, registration_only: true}, gas: SEND_STORAGE_DEPOSIT_GAS, deposit: registration}}]),
    {type: "FunctionCall", params: {methodName: "ft_transfer", args: {receiver_id: recipient, amount}, gas: SEND_FT_TRANSFER_GAS, deposit: "1"}},
  ] : [{type: "Transfer", params: {deposit: amount}}];
  return {recipient, symbol: token?.symbol ?? "NEAR", decimals: token?.decimals ?? 24, amount, maximum, registration, gas, tokenBalance, request: {context, purpose: "send", transactions: [{receiverId: token?.contractId ?? recipient, actions}], approval: {summary: `Send ${amount} atomic units to ${recipient}`, maxNativeSpendYocto: (BigInt(gas) + BigInt(registration) + (token ? 1n : BigInt(amount))).toString(), expiresAtMs: Date.now() + 120000}}};
}
export async function submitSend(plan: SendPlan) {
  const result = await signAndSendApprovedTransactions(plan.request);
  const step = result.steps[0];
  if (!sameIdentity(plan.request.context, getAcquisitionContext(plan.request.context.operationId))) throw new Error("Account changed. Check this transfer from the original account.");
  // A hash or a wallet callback alone is never sufficient for a success screen.
  if (step?.status === "confirmed" && plan.tokenBalance !== undefined) {
    try {
      const balance = sendAtomic(await sendView(createAcquisitionRpc(RPC_URL), plan.request.transactions[0].receiverId, "ft_balance_of", {account_id: plan.request.context.accountId}));
      if (BigInt(plan.tokenBalance) - BigInt(balance) < BigInt(plan.amount)) return {...step, status: "unknown" as const};
    } catch { return {...step, status: "unknown" as const}; }
  }
  return step;
}
