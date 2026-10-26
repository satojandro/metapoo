/**
 * Page settings that are not the shared board description.
 *
 * Prefer environment variables (see `.env.example`) so you can point at a
 * local or testnet contract without editing source. Values here are the
 * safe defaults when no `.env` file exists.
 *
 * The wallet network default is testnet. That is not a mainnet deployment.
 */

import type { NetworkId } from "@shared/types.ts";

function envString(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function envNetwork(): NetworkId {
  const raw = envString("VITE_NEAR_NETWORK");
  if (
    raw === "mock" ||
    raw === "localnet" ||
    raw === "testnet" ||
    raw === "mainnet"
  ) {
    return raw;
  }
  return "testnet";
}

/** Network this page believes it is using (messaging, draw policy, explorer). */
export const PAGE_NETWORK: NetworkId = envNetwork();

/**
 * Network passed to `@hot-labs/near-connect`.
 * That library only accepts `mainnet` | `testnet`, so mock/localnet fall back
 * to testnet for the connector while `PAGE_NETWORK` still describes intent.
 */
export const WALLET_NETWORK: "mainnet" | "testnet" =
  PAGE_NETWORK === "mainnet" ? "mainnet" : "testnet";

/**
 * Game contract account. Empty on purpose until you deploy or configure one.
 * Do not fill this with the MPOO token account. That account is a supplied
 * token reference, not this game, and it has not been verified in this repo.
 *
 * Set `VITE_CONTRACT_ID` in `web/.env` (see `.env.example`).
 */
export const CONTRACT_ID = envString("VITE_CONTRACT_ID");

/**
 * Art bounty escrow contract account (separate from the game board).
 * Empty → bounty pages stay on the fixture adapter (demo data).
 * Set `VITE_BOUNTY_CONTRACT_ID` for live view calls. Do not put the MPOO
 * token account here.
 */
export const BOUNTY_CONTRACT_ID = envString("VITE_BOUNTY_CONTRACT_ID");

/**
 * Live bounty funding CTA. Off by default until the payout path is ready.
 * When false, create/fund UI stays disabled or gated with explicit copy.
 * When true, the CTA may unlock after confirmation — still MPOO escrow
 * liability, never paint revenue. Does not claim live-verified funding.
 */
export const BOUNTY_FUNDING_ENABLED =
  envString("VITE_BOUNTY_FUNDING_ENABLED") === "true";

/** Public JSON-RPC endpoint for free view calls (reads). */
export const RPC_URL =
  envString("VITE_NEAR_RPC_URL") || defaultRpcUrl(PAGE_NETWORK);

/**
 * Gas sponsorship stays off until custody, limits, and a kill switch exist.
 * When this flag is false, the UI must not claim a sponsored path exists.
 * When true but sponsorship is unavailable, the ordinary wallet path is used.
 */
export const SPONSORSHIP_ENABLED =
  envString("VITE_SPONSORSHIP_ENABLED") === "true";

/**
 * Paid-paint / pressure UI (Journey C). Off by default so free-board play is unchanged.
 * When true (or when the contract reports paid pressure metadata), the wall shows
 * quotes, max-cost checks, and the paint-cost overlay. Mock quotes are labelled
 * as demo until live get_quote RPC is wired; Place still builds paid FunctionCalls.
 */
export const PAID_PAINT_FLAG = envString("VITE_PAID_PAINT") === "true";

/** Prepaid gas for one `draw` or up to 64-cell `draw_many` call (30 Tgas), as a decimal string in gas units. */
export const DRAW_GAS = "30000000000000";

/** Attached deposit for `draw`. The game adds no fee; only network gas may apply. */
export const DRAW_DEPOSIT = "0";

function defaultRpcUrl(network: NetworkId): string {
  if (network === "mainnet") {
    return "https://rpc.mainnet.near.org";
  }
  if (network === "localnet") {
    return "http://127.0.0.1:3030";
  }
  // mock and testnet both use the public testnet RPC when a contract id is set
  return "https://rpc.testnet.near.org";
}
