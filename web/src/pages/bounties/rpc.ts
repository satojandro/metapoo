/**
 * Free view calls against the bounty escrow contract (not the game board).
 * Uses `VITE_BOUNTY_CONTRACT_ID` + shared RPC URL from config.
 */

import { BOUNTY_CONTRACT_ID, RPC_URL } from "../../config";

const RPC_TIMEOUT_MS = 20_000;

export class BountyContractUnsetError extends Error {
  readonly code = "CONTRACT_UNSET" as const;

  constructor(
    message = "Bounty escrow contract is not configured. Set VITE_BOUNTY_CONTRACT_ID in web/.env.",
  ) {
    super(message);
    this.name = "BountyContractUnsetError";
  }
}

export function isBountyContractConfigured(
  contractId: string = BOUNTY_CONTRACT_ID,
): boolean {
  return contractId.trim().length > 0;
}

/**
 * Call a view method on the bounty escrow contract.
 * Injectable `fetchImpl` / `contractId` / `rpcUrl` keep unit tests offline.
 */
export async function bountyViewFunction<T>(
  methodName: string,
  args: Record<string, unknown> = {},
  options: {
    contractId?: string;
    rpcUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<T> {
  const contractId = (options.contractId ?? BOUNTY_CONTRACT_ID).trim();
  if (!contractId) {
    throw new BountyContractUnsetError();
  }

  const rpcUrl = options.rpcUrl ?? RPC_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const argsBase64 = bytesToBase64(
    new TextEncoder().encode(JSON.stringify(args)),
  );

  const response = await fetchWithTimeout(
    fetchImpl,
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "metapoo-bounty-view",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "optimistic",
          account_id: contractId,
          method_name: methodName,
          args_base64: argsBase64,
        },
      }),
    },
    RPC_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} while calling ${methodName}.`);
  }

  const body = (await response.json()) as {
    result?: {
      result?: number[];
      error?: string;
    };
    error?: { message?: string };
  };

  if (body.error?.message) {
    throw new Error(body.error.message);
  }
  if (body.result?.error) {
    throw new Error(String(body.result.error));
  }
  if (!body.result?.result) {
    throw new Error(`Empty RPC result for ${methodName}.`);
  }

  const text = new TextDecoder().decode(Uint8Array.from(body.result.result));
  return JSON.parse(text) as T;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
