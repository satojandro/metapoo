import type {
  OperationContext,
  ApprovedTransactionRequest,
  ApprovedTransactionResult,
} from "../types";

/** All amounts crossing a chain/API boundary are integer strings, never JS floats. */
export type Atomic = string;
export type RheaNetwork = "mainnet" | "testnet";
export interface RheaConfig {
  enabled: boolean;
  networkId: RheaNetwork;
  maxInputYocto: Atomic;
  gasReserveYocto: Atomic;
  maxPriceImpactBps: number;
  route: RheaRouteManifest | null;
}
export interface RheaRouteLeg {
  venue: "dcl" | "classic";
  exchange: string;
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  feeBps: number;
  /** Group adjacent DCL pools only after reviewing their all-or-refund semantics. */
  atomicMultiPool: boolean;
}
export interface RheaRouteManifest {
  version: 1;
  id: string;
  networkId: RheaNetwork;
  evidenceId: string;
  fixture: boolean;
  wrapToken: string;
  mpooToken: string;
  decimals: Record<string, number>;
  codeHashes: Record<string, string>;
  legs: RheaRouteLeg[];
  /** A reviewed deployment-specific proof, not an inference from a quote. */
  netMinimumProof: null | {
    evidenceId: string;
    mode: "net-output" | "immutable-transfer-tax";
    buyBps: number;
    rounding: "floor-tax" | "floor-net";
  };
}
export interface ChainRead<T = unknown> {
  value: T;
  blockHash: string;
  blockHeight: number;
}
export interface RheaReadClient {
  view(
    accountId: string,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ChainRead>;
  codeHash(accountId: string, signal?: AbortSignal): Promise<ChainRead<string>>;
}
export interface RheaRouteEvidence {
  routeId: string;
  manifestEvidenceId: string;
  observedAtMs: number;
  blocks: { blockHash: string; blockHeight: number }[];
  buyBps: number;
  taxEvidenceId: string;
}
export interface RheaCheckpointQuote {
  legs: RheaRouteLeg[];
  inputAtomic: Atomic;
  grossOutputAtomic: Atomic;
  expectedNetAtomic: Atomic;
  minimumGrossAtomic: Atomic;
  minimumNetAtomic: Atomic;
}
export interface RheaBuyQuote {
  context: OperationContext;
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  inputNearYocto: Atomic;
  expectedNetMpooAtomic: Atomic;
  minNetMpooAtomic: Atomic;
  slippageBps: number;
  priceImpactBps: number;
  evidence: RheaRouteEvidence;
  route: RheaRouteManifest;
  checkpoints: RheaCheckpointQuote[];
  /** Reconciled intermediate amounts used only for an explicitly reviewed continuation. */
  settledInputs?: Record<number, Atomic>;
}
export interface RheaFunctionCall {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    deposit: Atomic;
  };
}
export interface RheaTransaction {
  receiverId: string;
  actions: RheaFunctionCall[];
}
export interface RheaStorageRead {
  tokenId: string;
  registered: boolean;
  minimumYocto: Atomic;
}
export interface RheaBudget {
  spendableNativeYocto: Atomic;
  maximumGasYocto: Atomic;
  reserveYocto: Atomic;
  registrationGas: string;
  wrapGas: string;
  swapGas: string;
  batchRegistrations?: boolean;
}
export interface RheaPlanCheckpoint {
  kind: "registration" | "swap";
  index: number;
  transactions: RheaTransaction[];
  quote: RheaCheckpointQuote | null;
  approvalCount: number;
}
export interface RheaExecutionPlan {
  quote: RheaBuyQuote;
  checkpoints: RheaPlanCheckpoint[];
  /** Cumulative native ceiling survives every checkpoint/re-quote. */
  maxNativeSpendYocto: Atomic;
  reserveYocto: Atomic;
  maximumGasYocto: Atomic;
  approvalCount: number;
}
export type RheaPhase =
  | "review"
  | "awaiting_approval"
  | "submitted"
  | "reconciling"
  | "next_checkpoint_review"
  | "complete"
  | "partial"
  | "refunded"
  | "failed"
  | "unresolved";
export interface RheaOperation {
  version: 1;
  operationId: string;
  context: OperationContext;
  phase: RheaPhase;
  plan: RheaExecutionPlan;
  checkpoint: number;
  consumedNativeYocto: Atomic;
  hashes: string[];
  completed: number;
  message: string;
  updatedAtMs: number;
  lastOutputAtomic: Atomic | null;
}
export interface RheaReconciliation {
  state: "received" | "refunded" | "failed" | "unknown";
  /** Supported by receipts, not an unattributed balance increase. */
  attributableOutputAtomic: Atomic;
  nativeOutlayYocto: Atomic;
  message: string;
}
export interface RheaControllerDependencies {
  now(): number;
  isCurrent(context: OperationContext): boolean;
  save(operation: RheaOperation): void;
  load(operationId: string): unknown;
  /** Refresh context, route/tax and reserve immediately before the wallet prompt. */
  preflight(
    plan: RheaExecutionPlan,
    checkpoint: RheaPlanCheckpoint,
  ): Promise<void>;
  /** The shared gateway owns capital locking and durable attempt markers. */
  approve(
    request: ApprovedTransactionRequest,
  ): Promise<ApprovedTransactionResult>;
  reconcile(operation: RheaOperation): Promise<RheaReconciliation>;
  onBalancesChanged(context: OperationContext): void;
}
