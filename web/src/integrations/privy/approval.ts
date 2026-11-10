import {
  DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
  DRAWING_SESSION_METHODS,
  formatAllowanceNear,
} from "../../drawing-session";
import { formatUnits } from "../../paint-wallet";
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
export interface PrivyReviewRow {
  label: string;
  value: string;
  /** Account ids, contract ids and keys: monospace, wrapped anywhere. */
  mono?: boolean;
}
export interface PrivyReview {
  /** Short uppercase label above the heading. */
  eyebrow: string;
  title: string;
  /** One or two sentences telling the player what is happening and why. */
  lede: string;
  /** Plain-language facts the player approves, built from the exact payload. */
  rows: PrivyReviewRow[];
  /** Consequences worth reading before approving. */
  notes: string[];
  /** Exact values from the payload (yocto, gas units, raw arguments), shown collapsed. */
  details: string[];
  approveLabel: string;
  requiresFunds: boolean;
  requiresHost: boolean;
}
const TGAS = 1_000_000_000_000n;
const formatGas = (gas: string): string => {
  const whole = BigInt(gas) / TGAS;
  return whole > 0n ? `${whole} TGas` : "under 1 TGas";
};
const formatDeposit = (yocto: string): string =>
  BigInt(yocto) === 0n ? "None" : `${formatUnits(yocto, 24)} NEAR`;
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

/** The AddKey that `authorizeDrawingSession` (web/src/wallet.ts) builds, and nothing wider. */
function assertDrawingKeyAddition(
  receiver: string,
  accountId: string,
  boardContractId: string,
  params: Record<string, unknown>,
): void {
  const refuse = () => {
    throw new Error("Only a draw-only key for this board can be added here.");
  };
  if (receiver !== accountId || !boardContractId) refuse();
  if (
    typeof params.publicKey !== "string" ||
    !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(params.publicKey)
  )
    refuse();
  const accessKey = record(params.accessKey);
  if (accessKey.nonce !== undefined && accessKey.nonce !== 0) refuse();
  // "FullAccess" is a string; record() rejects it along with anything else non-object.
  const permission = record(accessKey.permission);
  const methods = permission.methodNames;
  const allowance = permission.allowance;
  if (
    permission.receiverId !== boardContractId ||
    !(typeof allowance === "string" || typeof allowance === "bigint") ||
    String(allowance) !== DRAWING_SESSION_GAS_ALLOWANCE_YOCTO ||
    !Array.isArray(methods) ||
    methods.length !== DRAWING_SESSION_METHODS.length ||
    !DRAWING_SESSION_METHODS.every((m) => methods.includes(m))
  )
    refuse();
}

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
        eyebrow: "Your NEAR account",
        title: "You're signed in",
        lede: "Signing in gave you a NEAR account of your own. Connect it to Meta Poo to see your balance and start painting.",
        rows: [
          { label: "Account", value: wallet.address, mono: true },
          { label: "Network", value: `NEAR ${config.network}` },
        ],
        notes: [
          "Connecting is free. It doesn't send a transaction, spend NEAR, buy credits or paint.",
        ],
        // Nothing is signed beyond these two facts, so there is nothing more technical to show.
        details: [],
        approveLabel: "Connect to Meta Poo",
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
      eyebrow: "Authorize drawing",
      title: "Let this browser paint for you",
      lede: "This adds a drawing key to your account, so you can paint tile by tile without a window like this one each time.",
      rows: [
        { label: "Can do", value: "Paint on the Meta Poo wall, nothing else" },
        { label: "Fees it can spend", value: `Up to ${formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO)}, then it stops` },
        { label: "Can't do", value: "Move your NEAR, buy credits or swap tokens" },
        { label: "Account", value: wallet.address, mono: true },
      ],
      notes: [
        "Adding the key is one small transaction; you pay its network fee from your NEAR. You can revoke the key from the game at any time.",
      ],
      details: [
        `Board contract: ${boardContractId}`,
        `Methods: ${DRAWING_SESSION_METHODS.join(", ")}`,
        `Gas allowance: ${DRAWING_SESSION_GAS_ALLOWANCE_YOCTO} yoctoNEAR`,
        `Public key: ${String(key.publicKey)}`,
        `Network: ${config.network}`,
      ],
      approveLabel: "Approve",
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
  const rows: PrivyReviewRow[] = [];
  let revokesKey = false,
    addsDrawingKey = false;
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
        revokesKey = true;
        rows.push({ label: "Remove", value: "This browser's drawing key" });
        details.push(`Revoke drawing key: ${drawingPublicKey}`);
      } else if (action.type === "AddKey") {
        // Only the game's own drawing key: on this account, for this board, draw methods
        // only, with the bounded allowance. Full-access or unlimited keys never pass.
        assertDrawingKeyAddition(receiver, wallet.address, boardContractId, params);
        addsDrawingKey = true;
        rows.push(
          { label: "Adds", value: "A drawing key for this browser" },
          { label: "Can do", value: "Paint on the Meta Poo wall, nothing else" },
          { label: "Fees it can spend", value: `Up to ${formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO)}, then it stops` },
          { label: "Can't do", value: "Move your NEAR, buy credits or swap tokens" },
        );
        details.push(
          `Add drawing key: ${String(params.publicKey)}`,
          `Board contract: ${boardContractId}`,
          `Methods: ${DRAWING_SESSION_METHODS.join(", ")}`,
          `Gas allowance: ${DRAWING_SESSION_GAS_ALLOWANCE_YOCTO} yoctoNEAR`,
        );
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
        rows.push(
          { label: "Calls", value: `${params.methodName} on ${receiver}`, mono: true },
          { label: "Sends", value: formatDeposit(deposit) },
          { label: "Gas limit", value: formatGas(gas) },
        );
        details.push(
          `${receiver} → ${params.methodName}`,
          `Attached deposit: ${deposit} yoctoNEAR; gas limit: ${gas}`,
          `Arguments: ${args instanceof Uint8Array ? new TextDecoder().decode(args) : JSON.stringify(args)}`,
        );
      } else
        throw new Error("This wallet request contains an unsupported action.");
    }
  }
  const notes = addsDrawingKey
    ? [
        "Adding the key is one small transaction; you pay its network fee from your NEAR. You can revoke the key from the game at any time.",
      ]
    : [
        "Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit.",
      ];
  if (transactions.length > 1)
    notes.push(
      `This sends ${transactions.length} transactions in order. If a later one fails, the earlier ones still happen.`,
    );
  rows.push({ label: "From", value: wallet.address, mono: true });
  return {
    eyebrow: addsDrawingKey ? "Authorize drawing" : "Approve transaction",
    title: addsDrawingKey
      ? "Let this browser paint for you"
      : revokesKey && rows.length === 2
        ? "Remove the drawing key"
        : "Check and approve",
    lede: addsDrawingKey
      ? "This adds a drawing key to your account, so you can paint tile by tile without a window like this one each time."
      : "The game asked your account to send this. Nothing happens until you approve it here.",
    rows,
    notes,
    details,
    approveLabel: "Approve",
    requiresFunds: true,
    requiresHost: true,
  };
}
