import type { FundingPolicy } from "./intents/types";
import type { RheaRouteManifest } from "./rhea/types";

/** Release evidence is reviewed source, never a query parameter or an environment bypass. */
export const INTENTS_NATIVE_EVIDENCE: FundingPolicy["nativeDeliveryEvidence"] =
  {
    reference: "",
    initializedNamed: false,
    initializedImplicit: false,
    uninitializedImplicit: false,
  };
/**
 * Direct transport checked 2026-11-10 from a Chromium tab on https://metapoo-testnet.vercel.app:
 * /v0/tokens 200, /v0/quote (dry) 201, /v0/status 404 body readable; ACAO `*`, preflight
 * allows accept,content-type; site CSP connect-src lists the host.
 * Record: docs/payments/intents-transport-check-2026-11-10.md
 */
export const INTENTS_BROWSER_TRANSPORT_VERIFIED = true;
/**
 * Source routes a player may pay from. Each token contract was read on its own chain on
 * 2026-11-10 (symbol + decimals for EVM via eth_call, SPL mint account for Solana, getcontract +
 * decimals() for Tron), and its decimals match /v0/tokens. Native ETH/SOL have no contract; their
 * asset ids and decimals (18 / 9) come from /v0/tokens. Record:
 * docs/payments/intents-source-allowlist-2026-11-10.md
 *
 * A route is listed only if quote.ts has a refund-address validator for its chain.
 *
 * Every listed route returned a live dry quote for ~$5 on 2026-11-10. Verified but held back,
 * because the provider's minimum makes them fail for a normal top-up: BSC USDC/USDT ($1,000
 * minimum) and Tron USDT ($100 minimum). Re-run the dry quote before listing them.
 */
const evm = (chain: string, address: string) => ({
  assetId: `nep141:${chain}-${address}.omft.near`,
  blockchain: chain,
});
const hot = (chain: string, id: string) => ({
  assetId: `nep245:v2_1.omni.hot.tg:${id}`,
  blockchain: chain,
});
export const INTENTS_REVIEWED_SOURCES: FundingPolicy["sourceAllowlist"] = [
  // USDC
  evm("eth", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  evm("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  evm("arb", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  hot("op", "10_A2ewyUyDp6qsue1jqZsGypkCxRJ"), // 0x0b2c639c533813f4aa9d7837caf62653d097ff85
  hot("pol", "137_qiStmoQJDQPTebaPjgx5VBxZv6L"), // 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359
  hot("avax", "43114_3atVJH3r5c4GqiSYmg9fECvjc47o"), // 0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", blockchain: "sol" }, // EPjFWdd5…Dt1v
  // USDT
  evm("eth", "0xdac17f958d2ee523a2206206994597c13d831ec7"),
  evm("arb", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"), // USDT0, the canonical USDT on Arbitrum
  hot("op", "10_359RPSJVdTxwTJT9TyGssr2rFoWo"), // 0x94b008aa00579c1307b0ef2c499ad98a8ce58e58
  hot("pol", "137_3hpYoaLtt8MP1Z2GH1U473DMRKgr"), // 0xc2132d05d31c914a87c6611c10748aeb04b58e8f
  hot("avax", "43114_372BeH7ENZieCaabwkbWkBiTTgXp"), // 0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7
  { assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", blockchain: "sol" }, // Es9vMFrz…nwNYB
  // Native ETH
  { assetId: "nep141:eth.omft.near", blockchain: "eth" },
  { assetId: "nep141:base.omft.near", blockchain: "base" },
  { assetId: "nep141:arb.omft.near", blockchain: "arb" },
  hot("op", "10_11111111111111111111"),
  // Native SOL
  { assetId: "nep141:sol.omft.near", blockchain: "sol" },
];
// Public discovery evidence exists; a complete route and net-output proof do not yet exist.
export const RHEA_REVIEWED_ROUTE: RheaRouteManifest | null = null;

export const RHEA_REVIEWED_GAS: {
  registrationGas: string;
  wrapGas: string;
  swapGas: string;
} | null = null;
