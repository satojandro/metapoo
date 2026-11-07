/**
 * Browser cache for the board server: the region blob and owner-id → account names.
 *
 * IndexedDB, as Berry Fast's `lib/region-cache.ts`, but every call is wrapped: a private
 * window, blocked site data, or a browser without IndexedDB returns "nothing cached" and
 * the wall loads from the server instead. Nothing here is ever the only copy of anything.
 */

export interface CachedRegion {
  /** 98,304-byte blob. */
  bytes: Uint8Array;
  /** 131,072-byte per-tile `written_at_ns`, or null when it was not fetched. */
  writtenAt: Uint8Array | null;
  /** Block timestamp (ms) of the last write this copy includes. */
  lastUpdatedMs: number;
  /** Block height of the last write this copy includes, when known. */
  lastBlock: number | null;
}

export interface RegionStore {
  getRegion(key: string): Promise<CachedRegion | null>;
  putRegion(key: string, region: CachedRegion): Promise<void>;
  getAccount(key: string): Promise<string | null>;
  putAccount(key: string, accountId: string): Promise<void>;
}

/** A store that remembers nothing past the page (tests, and the no-IndexedDB case). */
export function memoryRegionStore(): RegionStore {
  const regions = new Map<string, CachedRegion>();
  const accounts = new Map<string, string>();
  return {
    getRegion: async (key) => regions.get(key) ?? null,
    putRegion: async (key, region) => { regions.set(key, region); },
    getAccount: async (key) => accounts.get(key) ?? null,
    putAccount: async (key, accountId) => { accounts.set(key, accountId); },
  };
}

const DB_NAME = "metapoo-board-server";
const DB_VERSION = 1;
const REGIONS = "regions";
const ACCOUNTS = "accounts";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed store. Every failure reads as "not cached" and writes are best effort. */
export function indexedDbRegionStore(): RegionStore {
  let opening: Promise<IDBDatabase | null> | null = null;

  function open(): Promise<IDBDatabase | null> {
    if (opening) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(REGIONS)) db.createObjectStore(REGIONS);
          if (!db.objectStoreNames.contains(ACCOUNTS)) db.createObjectStore(ACCOUNTS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return opening;
  }

  async function get<T>(storeName: string, key: string): Promise<T | null> {
    try {
      const db = await open();
      if (!db) return null;
      const value = await request(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
      return (value as T | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async function put(storeName: string, key: string, value: unknown): Promise<void> {
    try {
      const db = await open();
      if (!db) return;
      await request(db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key));
    } catch {
      // Best effort: a full or blocked store only costs the next load a download.
    }
  }

  return {
    async getRegion(key) {
      const raw = await get<{ bytes?: unknown; writtenAt?: unknown; lastUpdatedMs?: unknown; lastBlock?: unknown }>(REGIONS, key);
      if (!raw || !(raw.bytes instanceof Uint8Array) || typeof raw.lastUpdatedMs !== "number") return null;
      return {
        bytes: raw.bytes,
        writtenAt: raw.writtenAt instanceof Uint8Array ? raw.writtenAt : null,
        lastUpdatedMs: raw.lastUpdatedMs,
        lastBlock: typeof raw.lastBlock === "number" ? raw.lastBlock : null,
      };
    },
    putRegion: (key, region) => put(REGIONS, key, {
      bytes: region.bytes.slice(),
      writtenAt: region.writtenAt ? region.writtenAt.slice() : null,
      lastUpdatedMs: region.lastUpdatedMs,
      lastBlock: region.lastBlock,
    }),
    async getAccount(key) {
      const value = await get<unknown>(ACCOUNTS, key);
      return typeof value === "string" ? value : null;
    },
    putAccount: (key, accountId) => put(ACCOUNTS, key, accountId),
  };
}
