import { PublicKey } from "@near-js/crypto";
import { assertAtomic } from "./types";

export type AccountNetwork = "mainnet" | "testnet";
interface ReadinessBase {
  accountId: string;
  networkId: AccountNetwork;
  observedAtMs: number;
  kind: "named" | "implicit";
  expectedKeyMatches: boolean;
}
export type AccountReadiness = ReadinessBase &
  (
    | { state: "absent" | "initializing" | "unavailable"; reason?: string }
    | {
        state: "ready";
        nativeAmountYocto: string;
        lockedYocto: string;
        storageRequiredYocto: string;
        spendableBeforeGasYocto: string;
        blockHash: string;
      }
  );
export type ReadinessRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid RPC response");
  return value as Record<string, unknown>;
}
/** A plain native transfer can initialize an Ed25519 implicit account only for this exact key. */
export function implicitKeyMatches(
  accountId: string,
  expectedPublicKey?: string,
): boolean {
  if (
    !/^[0-9a-f]{64}$/.test(accountId) ||
    !expectedPublicKey?.startsWith("ed25519:")
  )
    return false;
  try {
    const key = PublicKey.fromString(expectedPublicKey);
    return (
      Array.from(key.data)
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("") === accountId
    );
  } catch {
    return false;
  }
}
function unknownAccount(error: unknown): boolean {
  const e = error as {
    cause?: { name?: string };
    name?: string;
    message?: string;
  };
  return e?.cause?.name === "UNKNOWN_ACCOUNT" || e?.name === "UNKNOWN_ACCOUNT";
}
export async function resolveAccountReadiness(
  accountId: string,
  networkId: AccountNetwork,
  rpc: ReadinessRpc,
  expectedPublicKey?: string,
): Promise<AccountReadiness> {
  const base: ReadinessBase = {
    accountId,
    networkId,
    observedAtMs: Date.now(),
    kind: /^[0-9a-f]{64}$/.test(accountId) ? "implicit" : "named",
    expectedKeyMatches: implicitKeyMatches(accountId, expectedPublicKey),
  };
  try {
    const account = record(
      await rpc("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      }),
    );
    const amount = assertAtomic(String(account.amount)),
      locked = assertAtomic(String(account.locked));
    if (
      !Number.isSafeInteger(account.storage_usage) ||
      (account.storage_usage as number) < 0 ||
      typeof account.block_hash !== "string"
    )
      throw new Error("Invalid account state");
    const config = record(
      await rpc("EXPERIMENTAL_protocol_config", {
        block_id: account.block_hash,
      }),
    );
    const runtime = record(config.runtime_config);
    const storage =
      BigInt(account.storage_usage as number) *
      assertAtomic(String(runtime.storage_amount_per_byte));
    // NEAR amount excludes locked staking balance; storage backing may overlap it.
    const total = amount + locked,
      reserved = storage > locked ? storage : locked;
    if (expectedPublicKey) {
      const key = record(
        await rpc("query", {
          request_type: "view_access_key",
          block_id: account.block_hash,
          account_id: accountId,
          public_key: expectedPublicKey,
        }),
      );
      if (key.permission !== "FullAccess")
        throw new Error("Expected provider key is not full access");
      base.expectedKeyMatches =
        base.kind === "named" ||
        implicitKeyMatches(accountId, expectedPublicKey);
      if (!base.expectedKeyMatches)
        throw new Error("Provider key/address mismatch");
    }
    return {
      ...base,
      state: "ready",
      nativeAmountYocto: amount.toString(),
      lockedYocto: locked.toString(),
      storageRequiredYocto: storage.toString(),
      spendableBeforeGasYocto: (total > reserved
        ? total - reserved
        : 0n
      ).toString(),
      blockHash: account.block_hash,
    };
  } catch (error) {
    // Only a structured account-not-found result is absence. Network failures stay unavailable.
    return {
      ...base,
      state: unknownAccount(error) ? "absent" : "unavailable",
      reason: "Account readiness could not be verified",
    };
  }
}
