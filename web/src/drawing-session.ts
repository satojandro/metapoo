/**
 * Experimental NEAR drawing-session helpers.
 *
 * Goal: optionally request a function-call access key limited to the board's
 * `draw` method with a small gas allowance (via near-connect's
 * `addFunctionCallKey` on connect).
 *
 * This module does NOT prove no-popup local signing. Draw still goes through
 * `wallet.signAndSendTransaction` until a separate local-signer path is proven.
 *
 * Clearing browser storage is NOT the same as deleting the key on chain.
 */

/** localStorage key — labeled experimental so it is easy to find and wipe. */
export const DRAWING_SESSION_STORAGE_KEY =
  "metapoo.experimental.drawingSession.v1";

/**
 * Lifetime gas allowance for the experimental FC key, in yoctoNEAR.
 * 0.05 NEAR — small and explicit (connector default is 0.25 NEAR).
 * This is spent on network fees when the key is used, not an app fee.
 */
export const DRAWING_SESSION_GAS_ALLOWANCE_YOCTO =
  "50000000000000000000000";

/** Only the board paint method is allowed for this experiment. */
export const DRAWING_SESSION_METHOD = "draw";

const YOCTO_PER_NEAR = 10n ** 24n;

export type DrawingSessionPhase =
  | "inactive"
  | "active"
  | "forgotten_locally"
  | "contract_missing"
  | "account_mismatch";

/**
 * What we persist in the browser for the experiment.
 * The secret key never leaves localStorage in this scaffold.
 */
export interface DrawingSessionRecord {
  version: 1;
  experimental: true;
  accountId: string;
  networkId: string;
  contractId: string;
  /** NEAR public key string, e.g. "ed25519:…" */
  publicKey: string;
  /** 32-byte ed25519 seed as lowercase hex (experimental storage). */
  secretKeyHex: string;
  gasAllowanceYocto: string;
  /** When this browser marked the session authorized (ISO string). */
  authorizedAt: string;
  /**
   * True after the user forgot the session in this browser.
   * Does not mean the on-chain access key was deleted.
   */
  forgottenLocally: boolean;
}

export interface DrawingSessionStatus {
  phase: DrawingSessionPhase;
  /** Short label for a heading. */
  title: string;
  /** Plain-language body for the aside panel. */
  message: string;
  /** Configured lifetime allowance, human-readable (not live remaining). */
  allowanceLabel: string;
  record: DrawingSessionRecord | null;
}

export interface AddFunctionCallKeyScaffold {
  contractId: string;
  publicKey: string;
  allowMethods: { anyMethod: false; methodNames: string[] };
  gasAllowance: { kind: "limited"; amount: string };
}

/** Bitcoin / NEAR base58 alphabet (no 0, O, I, l). */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as base58 (NEAR public-key style).
 * Pure helper — safe to unit test without a wallet.
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  // Count leading zeros (encode as leading '1' characters).
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  // All zeros → only leading '1' characters (no extra digit from a seed 0).
  if (leadingZeros === bytes.length) {
    return "1".repeat(leadingZeros);
  }

  // Convert base-256 digits to base-58.
  const digits: number[] = [0];
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]!]!;
  }
  return out;
}

/**
 * Format a yoctoNEAR allowance string for beginners.
 * Example: "50000000000000000000000" → "0.05 NEAR".
 */
export function formatAllowanceNear(yocto: string): string {
  const trimmed = yocto.trim();
  if (!/^\d+$/.test(trimmed)) {
    return "(invalid allowance)";
  }
  const value = BigInt(trimmed);
  const whole = value / YOCTO_PER_NEAR;
  const frac = value % YOCTO_PER_NEAR;
  if (frac === 0n) {
    return `${whole.toString()} NEAR`;
  }
  // Keep up to 6 meaningful fractional digits without floating-point math.
  const fracPadded = frac.toString().padStart(24, "0").replace(/0+$/, "");
  const short =
    fracPadded.length > 6 ? fracPadded.slice(0, 6).replace(/0+$/, "") : fracPadded;
  return `${whole.toString()}.${short} NEAR`;
}

/**
 * Build the near-connect `addFunctionCallKey` payload for this experiment.
 */
export function buildAddFunctionCallKeyParams(
  contractId: string,
  publicKey: string,
  gasAllowanceYocto: string = DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
): AddFunctionCallKeyScaffold {
  return {
    contractId,
    publicKey,
    allowMethods: {
      anyMethod: false,
      methodNames: [DRAWING_SESSION_METHOD],
    },
    gasAllowance: {
      kind: "limited",
      amount: gasAllowanceYocto,
    },
  };
}

/**
 * Pure state machine for what the UI should say.
 * Does not touch the network or the wallet.
 */
export function describeDrawingSession(input: {
  contractId: string;
  accountId: string | null;
  networkId: string | null;
  record: DrawingSessionRecord | null;
}): DrawingSessionStatus {
  const allowanceLabel = formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO);

  if (!input.contractId) {
    return {
      phase: "contract_missing",
      title: "Drawing session: not available",
      message:
        "A game contract id is required before you can authorize a drawing session. Set VITE_CONTRACT_ID, then reconnect.",
      allowanceLabel,
      record: input.record,
    };
  }

  if (!input.accountId) {
    return {
      phase: "inactive",
      title: "Drawing session: not active",
      message:
        "Connect your wallet first. Optionally check “Authorize drawing session” to ask the wallet for a limited draw-only key. Ordinary wallet approval remains the default fallback. Draw still uses the wallet popup path until local signing is proven.",
      allowanceLabel,
      record: input.record,
    };
  }

  const record = input.record;
  if (!record) {
    return {
      phase: "inactive",
      title: "Drawing session: not active",
      message: `Connected as ${input.accountId}. No experimental drawing session is stored in this browser. You can authorize one (limited to method “draw”, allowance ${allowanceLabel}) or keep using ordinary wallet approval for each paint.`,
      allowanceLabel,
      record: null,
    };
  }

  if (record.forgottenLocally) {
    return {
      phase: "forgotten_locally",
      title: "Drawing session: forgotten in this browser",
      message:
        "This browser no longer keeps the experimental key material. That does not delete the access key on chain. Use your wallet or account tools if you need on-chain revocation. You can authorize again to create a new session key.",
      allowanceLabel: formatAllowanceNear(record.gasAllowanceYocto),
      record,
    };
  }

  if (
    record.accountId !== input.accountId ||
    (input.networkId && record.networkId !== input.networkId) ||
    record.contractId !== input.contractId
  ) {
    return {
      phase: "account_mismatch",
      title: "Drawing session: stored for another account",
      message: `This browser has an experimental session for ${record.accountId} on ${record.networkId} (contract ${record.contractId}). You are connected as ${input.accountId}. Forget the old session or reconnect with matching account/network/contract.`,
      allowanceLabel: formatAllowanceNear(record.gasAllowanceYocto),
      record,
    };
  }

  return {
    phase: "active",
    title: "Drawing session: active (experimental)",
    message: [
      `Authorized for ${record.accountId} on ${record.networkId}, contract ${record.contractId}, method “draw” only.`,
      `Configured lifetime allowance: ${formatAllowanceNear(record.gasAllowanceYocto)} (live remaining balance is not queried yet).`,
      "Draw still goes through the wallet’s signAndSendTransaction path — this scaffold does not claim no-popup local signing yet.",
      "Forgetting the session only clears this browser. It does not delete the on-chain key.",
    ].join(" "),
    allowanceLabel: formatAllowanceNear(record.gasAllowanceYocto),
    record,
  };
}

/** Read the experimental session from localStorage (or null). */
export function loadDrawingSessionRecord(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): DrawingSessionRecord | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(DRAWING_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRecord(parsed);
  } catch {
    return null;
  }
}

/** Persist an authorized experimental session. */
export function saveDrawingSessionRecord(
  record: DrawingSessionRecord,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }
  storage.setItem(DRAWING_SESSION_STORAGE_KEY, JSON.stringify(record));
}

/**
 * Mark the session forgotten in this browser (or remove it).
 * Does not contact the chain — on-chain key deletion is still unverified.
 */
export function forgetDrawingSessionLocally(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = defaultStorage(),
): DrawingSessionRecord | null {
  if (!storage) {
    return null;
  }
  const existing = loadDrawingSessionRecord(storage);
  if (!existing) {
    storage.removeItem(DRAWING_SESSION_STORAGE_KEY);
    return null;
  }
  const next: DrawingSessionRecord = {
    ...existing,
    forgottenLocally: true,
    // Drop the secret so a forgotten session cannot be reused from storage.
    secretKeyHex: "",
  };
  storage.setItem(DRAWING_SESSION_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Remove every experimental drawing-session field from this browser. */
export function wipeDrawingSessionStorage(
  storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
  storage?.removeItem(DRAWING_SESSION_STORAGE_KEY);
}

/**
 * Generate an ed25519 keypair for the FC key experiment (Web Crypto).
 * Returns a NEAR-style public key string and a hex seed for localStorage.
 */
export async function createDrawingSessionKeypair(
  subtle: SubtleCrypto = crypto.subtle,
): Promise<{ publicKey: string; secretKeyHex: string }> {
  const keyPair = await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey));
  // RFC 8410 PKCS#8 for Ed25519 ends with the 32-byte seed.
  if (pkcs8.length < 32) {
    throw new Error("Unexpected Ed25519 PKCS#8 length from Web Crypto.");
  }
  const seed = pkcs8.slice(pkcs8.length - 32);
  return {
    publicKey: `ed25519:${encodeBase58(publicRaw)}`,
    secretKeyHex: bytesToHex(seed),
  };
}

/**
 * Build a fresh record after the wallet accepted addFunctionCallKey sign-in.
 */
export function makeAuthorizedSessionRecord(input: {
  accountId: string;
  networkId: string;
  contractId: string;
  publicKey: string;
  secretKeyHex: string;
  gasAllowanceYocto?: string;
  authorizedAt?: string;
}): DrawingSessionRecord {
  return {
    version: 1,
    experimental: true,
    accountId: input.accountId,
    networkId: input.networkId,
    contractId: input.contractId,
    publicKey: input.publicKey,
    secretKeyHex: input.secretKeyHex,
    gasAllowanceYocto:
      input.gasAllowanceYocto ?? DRAWING_SESSION_GAS_ALLOWANCE_YOCTO,
    authorizedAt: input.authorizedAt ?? new Date().toISOString(),
    forgottenLocally: false,
  };
}

function normalizeRecord(value: unknown): DrawingSessionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.experimental !== true) {
    return null;
  }
  const accountId = asNonEmptyString(record.accountId);
  const networkId = asNonEmptyString(record.networkId);
  const contractId = asNonEmptyString(record.contractId);
  const publicKey = asNonEmptyString(record.publicKey);
  const secretKeyHex =
    typeof record.secretKeyHex === "string" ? record.secretKeyHex : "";
  const gasAllowanceYocto = asNonEmptyString(record.gasAllowanceYocto);
  const authorizedAt = asNonEmptyString(record.authorizedAt);
  if (
    !accountId ||
    !networkId ||
    !contractId ||
    !publicKey ||
    !gasAllowanceYocto ||
    !authorizedAt
  ) {
    return null;
  }
  return {
    version: 1,
    experimental: true,
    accountId,
    networkId,
    contractId,
    publicKey,
    secretKeyHex,
    gasAllowanceYocto,
    authorizedAt,
    forgottenLocally: record.forgottenLocally === true,
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function defaultStorage(): Storage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}
