/** Immutable identity captured when a player starts a funding or swap operation. */
export interface OperationContext {
  operationId: string;
  accountId: string;
  networkId: "mainnet" | "testnet";
  sessionEpoch: number;
}
export interface ApprovedNearAction {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    deposit: string;
  };
}
export interface ApprovedNearTransaction {
  receiverId: string;
  actions: readonly ApprovedNearAction[];
}
export interface ApprovedTransactionRequest {
  context: OperationContext;
  purpose: "funding-unwrap" | "mpoo-acquisition";
  transactions: readonly ApprovedNearTransaction[];
  approval: {
    summary: string;
    maxNativeSpendYocto: string;
    quoteId?: string;
    expiresAtMs?: number;
  };
}
export interface ApprovedTransactionStep {
  index: number;
  status: "confirmed" | "failed" | "unknown";
  transactionHash: string | null;
  detail?: string;
}
export interface ApprovedTransactionResult {
  steps: ApprovedTransactionStep[];
  completedSteps: number;
}
export function assertAtomic(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid atomic amount");
  return BigInt(value);
}
export function sameIdentity(
  a: OperationContext,
  b: OperationContext | null,
): boolean {
  return (
    !!b &&
    a.accountId === b.accountId &&
    a.networkId === b.networkId &&
    a.sessionEpoch === b.sessionEpoch
  );
}
