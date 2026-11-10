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
export const INTENTS_REVIEWED_SOURCES: FundingPolicy["sourceAllowlist"] = [
  {
    // USDC on Base. Verified on chain 2026-11-10: eth_call symbol() -> "USDC", 1852 bytes of code
    // at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, and /v0/tokens reports decimals 6 for it.
    assetId:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    blockchain: "base",
  },
];
// Public discovery evidence exists; a complete route and net-output proof do not yet exist.
export const RHEA_REVIEWED_ROUTE: RheaRouteManifest | null = null;

export const RHEA_REVIEWED_GAS: {
  registrationGas: string;
  wrapGas: string;
  swapGas: string;
} | null = null;
