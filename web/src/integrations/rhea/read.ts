import type { OperationContext } from "../types";
import {
  atomic,
  HISTORICAL_MPOO_POOL,
  MPOO_TOKEN,
  RHEA_DCL,
  validateManifest,
  validateRheaConfig,
} from "./config";
import type {
  ChainRead,
  RheaConfig,
  RheaReadClient,
  RheaRouteEvidence,
  RheaRouteManifest,
  RheaStorageRead,
} from "./types";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid chain response");
  return value as Record<string, unknown>;
}
export function integer(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Chain amount is not an integer string");
  return atomic(value).toString();
}

/** Public read-only RPC. A timeout is unavailable, never a made-up zero balance. */
export function createRheaReadClient(
  url: string,
  fetcher: typeof fetch = fetch,
): RheaReadClient {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  )
    throw new Error("RPC must use HTTPS");
  async function query(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ChainRead> {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mpoo-acquisition-read",
        method: "query",
        params: { ...params, finality: "final" },
      }),
    });
    if (!response.ok) throw new Error("RHEA chain read unavailable");
    const envelope = object(await response.json());
    if (envelope.error) throw new Error("RHEA chain read failed");
    const result = object(envelope.result);
    if (
      typeof result.block_hash !== "string" ||
      !Number.isSafeInteger(result.block_height)
    )
      throw new Error("Missing chain evidence block");
    return {
      value: result,
      blockHash: result.block_hash,
      blockHeight: result.block_height as number,
    };
  }
  return {
    async view(accountId, method, args, signal) {
      const result = await query(
        {
          request_type: "call_function",
          account_id: accountId,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
        signal,
      );
      const bytes = object(result.value).result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 1_000_000 ||
        !bytes.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
      )
        throw new Error("Invalid chain view bytes");
      return {
        ...result,
        value: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))),
      };
    },
    async codeHash(accountId, signal) {
      const result = await query(
        { request_type: "view_account", account_id: accountId },
        signal,
      );
      const hash = object(result.value).code_hash;
      if (typeof hash !== "string" || !hash)
        throw new Error("Missing code hash");
      return { ...result, value: hash };
    },
  };
}

export async function readRouteEvidence(
  route: RheaRouteManifest,
  client: RheaReadClient,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<RheaRouteEvidence> {
  validateManifest(route, route.networkId);
  const startedAt = now();
  const blocks: RheaRouteEvidence["blocks"] = [];
  const record = <T>(result: ChainRead<T>): T => {
    blocks.push({
      blockHash: result.blockHash,
      blockHeight: result.blockHeight,
    });
    return result.value;
  };
  await Promise.all(
    Object.entries(route.decimals).map(async ([id, decimals]) => {
      const meta = object(
        record(await client.view(id, "ft_metadata", {}, signal)),
      );
      if (meta.decimals !== decimals)
        throw new Error("Token decimals changed; route review required");
    }),
  );
  await Promise.all(
    Object.entries(route.codeHashes).map(async ([id, expected]) => {
      if (record(await client.codeHash(id, signal)) !== expected)
        throw new Error("Contract code changed; route review required");
    }),
  );
  await Promise.all(
    route.legs.map(async (leg) => {
      const pool = object(
        record(
          await client.view(
            leg.exchange,
            "get_pool",
            {
              pool_id:
                leg.venue === "classic" ? Number(leg.poolId) : leg.poolId,
            },
            signal,
          ),
        ),
      );
      if (leg.venue === "dcl") {
        if (
          ![pool.token_x, pool.token_y].includes(leg.tokenIn) ||
          ![pool.token_x, pool.token_y].includes(leg.tokenOut) ||
          atomic(integer(pool.liquidity)) === 0n
        )
          throw new Error("DCL pool mismatch or unavailable liquidity");
        if (typeof pool.fee !== "number" || pool.fee / 100 !== leg.feeBps)
          throw new Error("DCL pool fee changed");
        if (
          typeof pool.state === "string" &&
          !["Running", "running"].includes(pool.state)
        )
          throw new Error("DCL pool is not running");
      } else {
        const ids = pool.token_account_ids;
        const amounts = pool.amounts;
        if (
          pool.pool_kind !== "SIMPLE_POOL" ||
          !Array.isArray(ids) ||
          ids.length !== 2 ||
          !ids.includes(leg.tokenIn) ||
          !ids.includes(leg.tokenOut) ||
          !Array.isArray(amounts) ||
          amounts.length !== 2 ||
          amounts.some((x) => atomic(integer(x)) === 0n)
        )
          throw new Error("Classic pool mismatch or unavailable liquidity");
        if (pool.total_fee !== leg.feeBps)
          throw new Error("Classic pool fee changed");
      }
    }),
  );
  for (const token of Object.keys(route.decimals).filter(
    (id) => id.endsWith(".nearlytrade.near") && id !== route.mpooToken,
  )) {
    const intermediateTax = object(
      object(record(await client.view(token, "get_tax", {}, signal))).tax,
    );
    if (intermediateTax.buy_bps !== 0 || intermediateTax.sell_bps !== 0)
      throw new Error(
        "Intermediate-token trading tax requires a separately verified net-output model",
      );
  }
  const taxResult = await client.view(route.mpooToken, "get_tax", {}, signal);
  const tax = object(object(record(taxResult)).tax);
  if (
    !Number.isInteger(tax.buy_bps) ||
    (tax.buy_bps as number) < 0 ||
    (tax.buy_bps as number) >= 10000
  )
    throw new Error("Unknown trading tax");
  const pairs = tax.pairs;
  if (
    !Array.isArray(pairs) ||
    !pairs.includes(route.legs[route.legs.length - 1].exchange)
  )
    throw new Error("Trading tax venue mismatch");
  if (!route.netMinimumProof || route.netMinimumProof.buyBps !== tax.buy_bps)
    throw new Error("Net minimum tax proof is missing or stale");
  return {
    routeId: route.id,
    manifestEvidenceId: route.evidenceId,
    observedAtMs: startedAt,
    blocks,
    buyBps: tax.buy_bps as number,
    taxEvidenceId: `${taxResult.blockHash}:${route.mpooToken}`,
  };
}

export async function loadRheaReadiness(
  context: OperationContext,
  config: RheaConfig,
  client: RheaReadClient,
  signal?: AbortSignal,
): Promise<
  | { state: "ready"; evidence: RheaRouteEvidence }
  | { state: "unavailable"; reason: string }
> {
  try {
    validateRheaConfig(config);
    if (context.networkId !== config.networkId)
      throw new Error("Wallet and RHEA networks do not match");
    const evidence = await readRouteEvidence(
      config.route!,
      client,
      Date.now,
      signal,
    );
    return { state: "ready", evidence };
  } catch (error) {
    return {
      state: "unavailable",
      reason: error instanceof Error ? error.message : "Route unavailable",
    };
  }
}

export async function readRequiredStorage(
  route: RheaRouteManifest,
  accountId: string,
  client: RheaReadClient,
  signal?: AbortSignal,
): Promise<RheaStorageRead[]> {
  return Promise.all(
    Object.keys(route.decimals).map(async (tokenId) => {
      const balance = (
        await client.view(
          tokenId,
          "storage_balance_of",
          { account_id: accountId },
          signal,
        )
      ).value;
      if (balance !== null) {
        const total = integer(object(balance).total);
        if (atomic(total) === 0n)
          throw new Error("Invalid token registration balance");
        return { tokenId, registered: true, minimumYocto: "0" };
      }
      const bounds = object(
        (await client.view(tokenId, "storage_balance_bounds", {}, signal))
          .value,
      );
      const minimumYocto = integer(bounds.min);
      if (atomic(minimumYocto) === 0n)
        throw new Error("Unknown storage minimum");
      return { tokenId, registered: false, minimumYocto };
    }),
  );
}

/** Discovery does not authorize a route: it deliberately returns observations, not a manifest. */
export async function inspectMpooCandidate(
  client: RheaReadClient,
  signal?: AbortSignal,
): Promise<Record<string, ChainRead>> {
  const [metadata, tax, launch, pool, code] = await Promise.all([
    client.view(MPOO_TOKEN, "ft_metadata", {}, signal),
    client.view(MPOO_TOKEN, "get_tax", {}, signal),
    client.view(
      "nearlytrade.near",
      "get_launch_by_token",
      { token: MPOO_TOKEN },
      signal,
    ),
    client.view(
      RHEA_DCL,
      "get_pool",
      { pool_id: HISTORICAL_MPOO_POOL },
      signal,
    ),
    client.codeHash(MPOO_TOKEN, signal),
  ]);
  return { metadata, tax, launch, pool, code };
}
