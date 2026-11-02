import {
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  DRAWING_SESSION_METHODS,
} from "../../drawing-session";
import type { PrivyConfig } from "./config";
import type {
  HostIdentity,
  PrivyNearWallet,
  PendingDrawingAuthorization,
} from "./session";

export interface SigningSession {
  payload: unknown;
  targetOrigin: string;
  sign(): Promise<void>;
}
export interface PrivyReview {
  title: string;
  details: string[];
  requiresFunds: boolean;
  requiresHost: boolean;
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid wallet request.");
  return v as Record<string, unknown>;
};
const account = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v) ||
    v.length < 2 ||
    v.length > 64
  )
    throw new Error("Invalid receiver account.");
  return v;
};
const atomic = (v: unknown): string => {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v) || v.length > 40)
    throw new Error("Invalid transaction amount.");
  return v;
};

/** Review exactly the payload which the pinned connector will sign; never execute from its labels. */
export function reviewPrivyRequest(
  session: SigningSession,
  config: PrivyConfig,
  wallet: PrivyNearWallet,
  host: HostIdentity | null,
  boardContractId: string,
  drawingPublicKey?: string,
  pendingDrawing?: PendingDrawingAuthorization | null,
): PrivyReview {
  if (session.targetOrigin !== config.origin)
    throw new Error("This application is not allowed to request signatures.");
  const payload = record(session.payload);
  if (payload.network !== config.network)
    throw new Error("The wallet request has a missing or different network.");
  if (payload.signerId !== undefined && payload.signerId !== wallet.address)
    throw new Error("The requested signing account changed.");
  const hostMatches =
    !!host &&
    host.accountId === wallet.address &&
    host.networkId === config.network;
  if (payload.kind === "signIn") {
    if (!payload.addFunctionCallKey)
      return {
        title: "Connect your account",
        details: [
          `Account: ${wallet.address}`,
          `Network: ${config.network}`,
          "Connecting does not buy credits or paint.",
        ],
        requiresFunds: false,
        requiresHost: false,
      };
    if (!hostMatches)
      throw new Error(
        "Return to the game and reconnect this account before authorizing drawing.",
      );
    const key = record(payload.addFunctionCallKey);
    if (
      !pendingDrawing ||
      pendingDrawing.accountId !== wallet.address ||
      pendingDrawing.networkId !== config.network ||
      pendingDrawing.sessionEpoch !== host?.sessionEpoch ||
      pendingDrawing.publicKey !== key.publicKey ||
      pendingDrawing.contractId !== boardContractId ||
      pendingDrawing.allowance !== DRAWING_SESSION_GAS_ALLOWANCE_YOCTO ||
      pendingDrawing.methods.length !== DRAWING_SESSION_METHODS.length ||
      !DRAWING_SESSION_METHODS.every((m) => pendingDrawing.methods.includes(m))
    ) {
      throw new Error(
        "Drawing authorization does not match the request pending in the game.",
      );
    }
    const methods = record(key.allowMethods),
      allowance = record(key.gasAllowance);
    if (
      !boardContractId ||
      key.contractId !== boardContractId ||
      typeof key.publicKey !== "string" ||
      !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key.publicKey) ||
      methods.anyMethod !== false ||
      !Array.isArray(methods.methodNames) ||
      methods.methodNames.length !== DRAWING_SESSION_METHODS.length ||
      !DRAWING_SESSION_METHODS.every((m) =>
        (methods.methodNames as unknown[]).includes(m),
      ) ||
      allowance.kind !== "limited" ||
      allowance.amount !== DRAWING_SESSION_GAS_ALLOWANCE_YOCTO
    ) {
      throw new Error(
        "Drawing authorization must use the existing board, methods, and limited allowance.",
      );
    }
    return {
      title: "Authorize drawing",
      details: [
        `Board: ${boardContractId}`,
        `Methods: ${DRAWING_SESSION_METHODS.join(", ")}`,
        `Gas allowance: ${DRAWING_SESSION_GAS_ALLOWANCE_YOCTO} yoctoNEAR`,
        "You pay network gas from your account. This key cannot buy credits or swap tokens.",
      ],
      requiresFunds: true,
      requiresHost: true,
    };
  }
  if (!hostMatches)
    throw new Error(
      "The connected game account changed. Return to the game and retry.",
    );
  if (
    !["signAndSendTransaction", "signAndSendTransactions"].includes(
      String(payload.kind),
    )
  ) {
    throw new Error(
      "This signing request is not supported. Sponsored transactions are disabled.",
    );
  }
  const transactions =
    payload.kind === "signAndSendTransaction"
      ? [payload]
      : payload.transactions;
  if (
    !Array.isArray(transactions) ||
    transactions.length === 0 ||
    transactions.length > 16
  )
    throw new Error("Invalid transaction batch.");
  const details = [`Account: ${wallet.address}`, `Network: ${config.network}`];
  for (const value of transactions) {
    const tx = record(value),
      receiver = account(tx.receiverId);
    if (
      !Array.isArray(tx.actions) ||
      !tx.actions.length ||
      tx.actions.length > 16
    )
      throw new Error("Invalid transaction actions.");
    for (const item of tx.actions) {
      const action = record(item),
        params = record(action.params);
      if (action.type === "DeleteKey") {
        if (
          receiver !== wallet.address ||
          !drawingPublicKey ||
          params.publicKey !== drawingPublicKey
        )
          throw new Error("Only the current drawing key can be revoked here.");
        details.push(`Revoke drawing key: ${drawingPublicKey}`);
      } else if (action.type === "FunctionCall") {
        if (
          typeof params.methodName !== "string" ||
          !/^[A-Za-z0-9_]{1,64}$/.test(params.methodName)
        )
          throw new Error("Invalid contract method.");
        const gas = atomic(params.gas),
          deposit = atomic(params.deposit);
        if (BigInt(gas) <= 0n || BigInt(gas) > 300_000_000_000_000n)
          throw new Error("Invalid gas limit.");
        const args = params.args;
        if (!(args instanceof Uint8Array)) record(args);
        details.push(
          `${receiver} → ${params.methodName}`,
          `Attached deposit: ${deposit} yoctoNEAR; gas limit: ${gas}`,
          `Arguments: ${args instanceof Uint8Array ? new TextDecoder().decode(args) : JSON.stringify(args)}`,
        );
      } else
        throw new Error("This wallet request contains an unsupported action.");
    }
  }
  details.push(
    "You pay network gas. A failed later transaction does not undo earlier transactions.",
  );
  return {
    title: "Approve transaction",
    details,
    requiresFunds: true,
    requiresHost: true,
  };
}
