import type { RheaConfig, RheaRouteManifest } from "./types";

export const MPOO_TOKEN = "mpoo.nearlytrade.near";
export const RHEA_DCL = "dclv2.ref-labs.near";
export const RHEA_CLASSIC = "v2.ref-finance.near";
export const NEARLY_FALLBACK = "https://nearly.trade/mpoo.nearlytrade.near";
export const HISTORICAL_MPOO_POOL =
  "diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000";

export function atomic(value: string, positive = false): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 78)
    throw new Error("Invalid atomic amount");
  const amount = BigInt(value);
  if (positive && amount === 0n) throw new Error("Amount must be positive");
  return amount;
}

/** Accept ordinary decimal input without rounding away money. */
export function parseDisplayAmount(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 38 ||
    value.length > 100 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  ) {
    throw new Error("Enter an ordinary positive decimal amount");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Too many decimal places");
  return atomic(
    (whole + fraction.padEnd(decimals, "0")).replace(/^0+(?=\d)/, ""),
    true,
  ).toString();
}

export function validateManifest(
  route: RheaRouteManifest,
  networkId: string,
): void {
  if (
    route.version !== 1 ||
    route.networkId !== networkId ||
    !route.id ||
    !route.evidenceId
  )
    throw new Error("Route evidence unavailable");
  if (route.legs.length < 1 || route.legs.length > 4)
    throw new Error("Route must have one to four hops");
  if (
    networkId === "mainnet" &&
    (route.fixture ||
      route.wrapToken !== "wrap.near" ||
      route.mpooToken !== MPOO_TOKEN)
  )
    throw new Error("Unexpected mainnet route");
  if (
    networkId !== "mainnet" &&
    (!route.fixture ||
      route.mpooToken === MPOO_TOKEN ||
      route.wrapToken === "wrap.near")
  )
    throw new Error("Mainnet mPOO cannot be traded on this network");
  let token = route.wrapToken;
  for (const leg of route.legs) {
    if (!["dcl", "classic"].includes(leg.venue))
      throw new Error("Unknown exchange venue");
    if (leg.tokenIn !== token || leg.tokenIn === leg.tokenOut || !leg.poolId)
      throw new Error("Route is disconnected");
    if (!Number.isInteger(leg.feeBps) || leg.feeBps < 0 || leg.feeBps > 1000)
      throw new Error("Invalid pool fee");
    if (
      networkId === "mainnet" &&
      leg.exchange !== (leg.venue === "dcl" ? RHEA_DCL : RHEA_CLASSIC)
    )
      throw new Error("Exchange is not allowlisted");
    if (
      !route.codeHashes[leg.exchange] ||
      !route.codeHashes[leg.tokenIn] ||
      !route.codeHashes[leg.tokenOut]
    )
      throw new Error("Missing reviewed code hash");
    if (
      leg.venue === "classic" &&
      (!/^(0|[1-9]\d*)$/.test(leg.poolId) ||
        !Number.isSafeInteger(Number(leg.poolId)))
    )
      throw new Error("Invalid classic pool id");
    if (leg.venue === "dcl") {
      const [x, y, fee, extra] = leg.poolId.split("|");
      if (
        extra !== undefined ||
        !/^\d+$/.test(fee ?? "") ||
        ![x, y].includes(leg.tokenIn) ||
        ![x, y].includes(leg.tokenOut) ||
        x === y
      )
        throw new Error("Invalid DCL pool id");
    }
    for (const id of [leg.tokenIn, leg.tokenOut]) {
      const decimals = route.decimals[id];
      if (
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 38 ||
        !/^[a-z0-9._-]{2,64}$/.test(id)
      )
        throw new Error("Invalid token metadata");
    }
    token = leg.tokenOut;
  }
  if (
    token !== route.mpooToken ||
    (networkId === "mainnet" && route.decimals[MPOO_TOKEN] !== 18)
  )
    throw new Error("Route does not end in mPOO");
}

export function validateRheaConfig(config: RheaConfig): void {
  if (!config.enabled) throw new Error("Embedded mPOO swaps are not enabled");
  atomic(config.maxInputYocto, true);
  atomic(config.gasReserveYocto, true);
  if (
    !Number.isInteger(config.maxPriceImpactBps) ||
    config.maxPriceImpactBps < 1 ||
    config.maxPriceImpactBps > 1000
  )
    throw new Error("Price impact limit is not configured");
  if (!config.route) throw new Error("A verified RHEA route is not configured");
  validateManifest(config.route, config.networkId);
  const proof = config.route.netMinimumProof;
  if (
    !proof ||
    !proof.evidenceId ||
    !["net-output", "immutable-transfer-tax"].includes(proof.mode) ||
    !["floor-tax", "floor-net"].includes(proof.rounding) ||
    !Number.isInteger(proof.buyBps) ||
    proof.buyBps < 0 ||
    proof.buyBps >= 10000
  )
    throw new Error("Net mPOO minimum protection has not been verified");
}

/** Private keys and provider credentials never belong in this configuration. */
export function createRheaConfig(
  env: Record<string, unknown>,
  networkId: "mainnet" | "testnet",
  route: RheaRouteManifest | null = null,
): RheaConfig {
  return {
    enabled: env.VITE_RHEA_MPOO_SWAP_ENABLED === "true",
    networkId,
    maxInputYocto:
      typeof env.VITE_RHEA_MAX_INPUT_YOCTO === "string"
        ? env.VITE_RHEA_MAX_INPUT_YOCTO
        : "0",
    gasReserveYocto:
      typeof env.VITE_RHEA_GAS_RESERVE_YOCTO === "string"
        ? env.VITE_RHEA_GAS_RESERVE_YOCTO
        : "0",
    maxPriceImpactBps:
      typeof env.VITE_RHEA_MAX_PRICE_IMPACT_BPS === "string" &&
      /^\d+$/.test(env.VITE_RHEA_MAX_PRICE_IMPACT_BPS)
        ? Number(env.VITE_RHEA_MAX_PRICE_IMPACT_BPS)
        : 0,
    route,
  };
}
