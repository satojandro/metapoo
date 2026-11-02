import type { OperationContext } from "./types";
export interface AcquisitionRecord {
  version: 1;
  context: OperationContext;
  feature: "intents" | "rhea";
  createdAtMs: number;
  updatedAtMs: number;
  phase: string;
  providerRecordId: string;
  transactionHashes: string[];
}
export interface DurableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const PREFIX = "metapoo:acquisition:v1:";
export function createAcquisitionStore(storage: DurableStorage) {
  return {
    save(record: AcquisitionRecord) {
      if (!valid(record)) throw new Error("Invalid acquisition record");
      storage.setItem(
        PREFIX + record.context.operationId,
        JSON.stringify(record),
      );
    },
    load(id: string): AcquisitionRecord | null {
      const raw = storage.getItem(PREFIX + id);
      if (!raw) return null;
      if (raw.length > 65536) throw new Error("Recovery record exceeds limit");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("Recovery record is corrupt; do not retry payment");
      }
      if (!valid(value) || value.context.operationId !== id)
        throw new Error("Recovery record is invalid; do not retry payment");
      return value;
    },
  };
}
function valid(value: unknown): value is AcquisitionRecord {
  const r = value as AcquisitionRecord;
  return (
    !!r &&
    r.version === 1 &&
    !!r.context &&
    typeof r.context.operationId === "string" &&
    r.context.operationId.length <= 160 &&
    typeof r.context.accountId === "string" &&
    ["mainnet", "testnet"].includes(r.context.networkId) &&
    Number.isSafeInteger(r.context.sessionEpoch) &&
    ["intents", "rhea"].includes(r.feature) &&
    Number.isFinite(r.createdAtMs) &&
    Number.isFinite(r.updatedAtMs) &&
    typeof r.phase === "string" &&
    typeof r.providerRecordId === "string" &&
    Array.isArray(r.transactionHashes) &&
    r.transactionHashes.every((h) => typeof h === "string")
  );
}
/** Serialize capital prompts across tabs; an uncertain lease is never silently stolen. */
export async function withCapitalLock<T>(
  storage: DurableStorage,
  run: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks)
    return locks.request("metapoo:capital", { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("Another tab is approving a payment");
      return run();
    });
  // A localStorage read/set lease cannot provide mutual exclusion: a suspended tab
  // can overwrite a newer claim. Keep new capital approvals disabled on old browsers.
  // Read-only recovery does not call this function and remains available.
  void storage;
  throw new Error(
    "This browser cannot coordinate safe payment approvals. Use a browser with Web Locks support.",
  );
}
