/** Recent owner calls from the public NearBlocks indexer. Chain reads remain authoritative. */
export interface AdminHistoryEntry { hash: string; method: string; timestampNs: bigint; succeeded: boolean | null }
export const ADMIN_METHODS = ["set_tunables", "set_paused", "set_near_price", "set_mpoo_price", "set_team_account", "set_buyback_account", "set_staking_contract"] as const;

export async function loadAdminHistory(network: string, board: string): Promise<AdminHistoryEntry[]> {
  const base = network === "mainnet" ? "https://api.nearblocks.io" : network === "testnet" ? "https://api-testnet.nearblocks.io" : null;
  if (!base) throw new Error("No public change indexer for this network");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // One bounded request per method also finds admin calls on a busy painting board.
    const batches = await Promise.all(ADMIN_METHODS.map(async method => {
      const url = `${base}/v1/account/${encodeURIComponent(board)}/txns?method=${method}&page=1&per_page=5&order=desc`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`History HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.txns)) throw new Error("Invalid change history response");
      return body.txns.flatMap((tx: Record<string, unknown>) => {
        const aggregate = tx.actions_agg as { method?: unknown } | undefined;
        const actual = typeof aggregate?.method === "string" ? aggregate.method : null;
        const hash = tx.transaction_hash;
        const time = tx.block_timestamp;
        const outcome = tx.outcomes as { status?: unknown } | undefined;
        // Ignore unrelated calls if an indexer doesn't support the method filter.
        if (actual !== method || tx.receiver_account_id !== board || typeof hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash)
          || typeof time !== "string" || !/^\d+$/.test(time)) return [];
        return [{ hash, method, timestampNs: BigInt(time), succeeded: typeof outcome?.status === "boolean" ? outcome.status : null }];
      });
    }));
    return [...new Map(batches.flat().map(entry => [entry.hash, entry])).values()]
      .sort((a,b) => a.timestampNs > b.timestampNs ? -1 : a.timestampNs < b.timestampNs ? 1 : 0).slice(0,20);
  } finally { clearTimeout(timer); }
}
