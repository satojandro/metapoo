import { classifySend, decodeSendArgs, type SendPolicy } from "../send/plan";
import { reviewContractIntent, type ApprovalFacts } from "./intents";
import { reviewSelfCustodyKey, privyPublicKey, type PendingSelfCustodyKey } from "./self-custody";
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
  confirm?: {suffix: string; acknowledgement: string};
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

/** Review exactly the payload which the pinned connector will sign; never execute from its labels. */
export function reviewPrivyRequest(
  session: SigningSession,
  config: PrivyConfig,
  wallet: PrivyNearWallet,
  host: HostIdentity | null,
  boardContractId: string,
  drawingPublicKey?: string,
  pendingDrawing?: PendingDrawingAuthorization | null,
  checks?: {
    sendPolicy?: SendPolicy;
    pendingCustody?: PendingSelfCustodyKey | null;
    keyPermission?: unknown;
    alreadyRegistered?: boolean;
    /** Chain facts the approved approval copy reads; every one is optional and never guessed. */
    facts?: Omit<ApprovalFacts, "walletAddress" | "boardContractId">;
  },
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
  // Even a forged drawing-key record must never turn Privy's key into a revocable key.
  if (/^[0-9a-f]{64}$/.test(wallet.address)) {
    const own = privyPublicKey(wallet.address);
    if (transactions.some(value => {
      const actions = record(value).actions;
      return Array.isArray(actions) && actions.some(item => {
        const action = record(item);
        return action.type === "DeleteKey" && record(action.params).publicKey === own;
      });
    })) throw new Error("Privy's sign-in key cannot be removed through this window.");
  }
  const send = classifySend(transactions, wallet.address, checks?.sendPolicy ?? {
    enabled: config.sendEnabled === true, tokens: config.sendTokens ?? [],
    blockedRecipients: [boardContractId, ...(config.sendBlockedRecipients ?? [])], storageMinimums: {},
  });
  if (send) {
    const symbol = send.token?.symbol ?? "NEAR";
    const amount = `${formatUnits(send.amount, send.token?.decimals ?? 24)} ${symbol}`;
    return {
      eyebrow: `Send ${symbol}`, title: `Send ${amount}`,
      lede: `This moves ${symbol} out of your Meta Poo account. Transfers can't be undone, so check the recipient.`,
      rows: [{label: "To", value: send.recipient, mono: true}, {label: "Amount", value: amount},
        ...(send.token ? [{label: "Token contract", value: send.token.contractId, mono: true}] : []),
        ...(send.registrationDeposit !== "0" ? [{label: "Recipient registration", value: `${formatUnits(send.registrationDeposit, 24)} NEAR${checks?.alreadyRegistered ? " (already registered; refunded by the token)" : ""}`}] : []),
        {label: "From", value: wallet.address, mono: true}],
      notes: ["Double-check the recipient. If it's wrong, Meta Poo can't get it back.",
        "Network fees come out of your NEAR.",
        ...(send.registrationDeposit !== "0" ? ["Registration and transfer happen together: if the transfer fails, the registration is undone too and only the network fee is spent."] : [])],
      details: [`Amount in smallest units: ${send.amount}`, `Network: ${config.network}`,
        ...(record(transactions[0]).actions as unknown[]).map(value => {
          const action = record(value), params = record(action.params);
          return action.type === "Transfer" ? `Transfer: ${params.deposit} yoctoNEAR` : `${params.methodName}: ${JSON.stringify(decodeSendArgs(params.args))}; deposit: ${params.deposit} yoctoNEAR; gas: ${params.gas}`;
        })],
      approveLabel: `Send ${amount}`, requiresFunds: true, requiresHost: true,
    };
  }
  // The approved captions (owner, 11 Nov): every action the game sends is mapped here from the
  // transaction itself, and anything unpapped is refused rather than captioned generically.
  const intent = reviewContractIntent(transactions, {
    walletAddress: wallet.address,
    boardContractId,
    stakingContractId: checks?.facts?.stakingContractId ?? null,
    toiletTokenId: checks?.facts?.toiletTokenId ?? "",
    mpooTokenId: checks?.facts?.mpooTokenId ?? "",
    pricePerCreditYocto: checks?.facts?.pricePerCreditYocto ?? null,
    mpooPerCredit: checks?.facts?.mpooPerCredit ?? null,
    unstakeBurnBps: checks?.facts?.unstakeBurnBps ?? null,
  });
  if (intent) return intent;
  if (config.selfCustodyEnabled && host) {
    const custody = reviewSelfCustodyKey(transactions, host, checks?.pendingCustody ?? null, checks?.keyPermission, drawingPublicKey);
    if (custody) return custody;
  }
  const details = [`Account: ${wallet.address}`, `Network: ${config.network}`];
  const rows: PrivyReviewRow[] = [];
  let revokesKey = false;
  let addsKey = false;
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
        rows.push({ label: "Remove", value: "This browser's painting key" });
        details.push(`Revoke drawing key: ${drawingPublicKey}`);
      } else if (action.type === "AddKey") {
        // The drawing session adds its key with a plain AddKey transaction, so this screen
        // has to review one. Nothing broader may pass: same account, board contract, draw
        // methods, capped allowance — and the exact key the game recorded before opening
        // this page, or a compromised game page could ask for a key we cannot describe.
        if (receiver !== wallet.address)
          throw new Error("A drawing key can only be added to your own account.");
        const accessKey = record(params.accessKey),
          permission = accessKey.permission;
        if (permission === "FullAccess" || typeof permission !== "object" || permission === null)
          throw new Error("Only a limited drawing key can be added here.");
        const fn = record(permission),
          methods = fn.methodNames,
          allowance = fn.allowance;
        if (
          !boardContractId ||
          fn.receiverId !== boardContractId ||
          !Array.isArray(methods) ||
          methods.length !== DRAWING_SESSION_METHODS.length ||
          !DRAWING_SESSION_METHODS.every((m) => (methods as unknown[]).includes(m)) ||
          typeof allowance !== "string" ||
          !/^\d+$/.test(allowance) ||
          BigInt(allowance) > BigInt(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO) ||
          typeof params.publicKey !== "string" ||
          !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(params.publicKey)
        )
          throw new Error(
            "A drawing key must use the board contract, the draw methods and the configured allowance.",
          );
        if (
          !pendingDrawing ||
          pendingDrawing.accountId !== wallet.address ||
          pendingDrawing.networkId !== config.network ||
          pendingDrawing.sessionEpoch !== host?.sessionEpoch ||
          pendingDrawing.publicKey !== params.publicKey ||
          pendingDrawing.contractId !== boardContractId ||
          pendingDrawing.allowance !== DRAWING_SESSION_GAS_ALLOWANCE_YOCTO ||
          pendingDrawing.methods.length !== DRAWING_SESSION_METHODS.length ||
          !DRAWING_SESSION_METHODS.every((m) => pendingDrawing.methods.includes(m))
        )
          throw new Error(
            "Drawing authorization does not match the request pending in the game.",
          );
        addsKey = true;
        rows.push(
          { label: "Adds", value: "A drawing key for this browser" },
          { label: "Can do", value: "Paint on the Meta Poo wall, nothing else" },
          {
            label: "Fees it can spend",
            value: `Up to ${formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO)}, then it stops`,
          },
          { label: "Can't do", value: "Move your NEAR, buy credits or swap tokens" },
        );
        details.push(
          `Add drawing key: ${params.publicKey}`,
          `Methods: ${DRAWING_SESSION_METHODS.join(", ")}`,
          `Gas allowance: ${allowance} yoctoNEAR`,
        );
      } else if (action.type === "FunctionCall") {
        // Every contract call is captioned by ./intents.ts or refused there. Reaching this
        // branch means the batch mixed a key action with an unmapped call: refuse, do not
        // invent a "Calls X on Y" line (owner sign-off, 11 Nov).
        throw new Error("This action is not supported in the approval window.");
      } else
        throw new Error("This wallet request contains an unsupported action.");
    }
  }
  const notes = [
    "Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit.",
  ];
  if (transactions.length > 1)
    notes.push(
      `This sends ${transactions.length} transactions at once. If one fails, the others can still happen.`,
    );
  rows.push({ label: "From", value: wallet.address, mono: true });
  return {
    eyebrow: addsKey ? "Authorize drawing" : "Approve transaction",
    title: addsKey
      ? "Let this browser paint for you"
      : revokesKey && rows.length === 2
        ? "Remove the drawing key"
        : "Check and approve",
    lede: addsKey
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
