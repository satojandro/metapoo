/**
 * Page settings that are not the shared board description.
 *
 * Prefer environment variables (see `.env.example`) so you can point at a
 * local or testnet contract without editing source. Values here are the
 * safe defaults when no `.env` file exists.
 *
 * The wallet network default is testnet. That is not a mainnet deployment.
 */

import { setBoardSide, type NetworkId } from "@shared/types.ts";
import { isFastNearUrl, rpcAuthHeaders } from "./rpc-auth";

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
 * TOILET token account. The board mints into it on `claim_toilet` but does not
 * store its address, so the page has to be told. Empty hides claim and balances.
 *
 * Set `VITE_TOILET_ID` in `web/.env` (see `.env.example`).
 */
export const TOILET_ID = envString("VITE_TOILET_ID");

/** Public JSON-RPC endpoint for free view calls (reads). */
export const RPC_URL =
  envString("VITE_NEAR_RPC_URL") || defaultRpcUrl(PAGE_NETWORK);

/**
 * Optional bearer token for `RPC_URL` (FastNEAR, for one, meters requests by key).
 *
 * Empty by default: the public endpoint needs no credential. Vite inlines this
 * value into the shipped bundle, so a key set here is readable by every visitor
 * and can be spent against our quota — use a domain-restricted browser key when
 * the page is deployed, and never a server key.
 */
export const RPC_API_KEY = envString("VITE_NEAR_RPC_API_KEY");

/**
 * JSON-RPC headers for `url`. The bearer token is added only when `url` belongs to
 * the configured endpoint, so a fallback host never receives our credential.
 */
export function rpcHeaders(url: string = RPC_URL): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...rpcAuthHeaders(url, RPC_URL, RPC_API_KEY),
  };
}

/**
 * Connection info for `@near-js` providers (`JsonRpcProvider`). Same credential
 * rule as `rpcHeaders`.
 */
export function rpcConnection(url: string = RPC_URL): {
  url: string;
  headers?: Record<string, string>;
} {
  const headers = rpcAuthHeaders(url, RPC_URL, RPC_API_KEY);
  return Object.keys(headers).length > 0 ? { url, headers } : { url };
}

/**
 * Headers for a FastNEAR service other than RPC (the transaction index, account API).
 *
 * Those hosts answer without a credential, which is why the /money ledger can use
 * them from the browser with no key at all. When a key *is* configured it is sent,
 * because the key is what raises the rate limit; one FastNEAR key covers every host.
 */
export function fastnearHeaders(url: string, withBody = true): Record<string, string> {
  // `Content-Type` on a GET turns a simple request into a CORS preflight; send it only
  // when there is a body to describe.
  const headers: Record<string, string> = withBody ? { "Content-Type": "application/json" } : {};
  if (RPC_API_KEY && isFastNearUrl(url)) headers.Authorization = `Bearer ${RPC_API_KEY}`;
  return headers;
}

/**
 * Board server (`ops/board-server/`, a port of Berry Fast), no trailing slash.
 *
 * Empty (the default) keeps today's behaviour exactly: the wall polls the chain and
 * makes no request to any server. Set, the wall loads the board from it and takes live
 * draws over its WebSocket, and stops polling the chain while that socket is open and
 * the server keeps up. Prices, credits, quotes and claims are still chain reads.
 */
export const BOARD_SERVER_URL = envString("VITE_BOARD_SERVER_URL").replace(/\/+$/, "");

/**
 * Gas sponsorship stays off until custody, limits, and a kill switch exist.
 * When this flag is false, the UI must not claim a sponsored path exists.
 * When true but sponsorship is unavailable, the ordinary wallet path is used.
 */
export const SPONSORSHIP_ENABLED =
  envString("VITE_SPONSORSHIP_ENABLED") === "true";

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

/** Acquisition is opt-in and independent of whether mPOO credit sales are enabled. */
export const PRIVY_ENABLED = envString("VITE_PRIVY_ENABLED") === "true";
export const INTENTS_FUNDING_ENABLED = envString("VITE_INTENTS_FUNDING_ENABLED") === "true";
export const RHEA_MPOO_SWAP_ENABLED = envString("VITE_RHEA_MPOO_SWAP_ENABLED") === "true";
export const ACQUISITION_PLAY_RESERVE_YOCTO = envString("VITE_ACQUISITION_PLAY_RESERVE_YOCTO");

/**
 * Board side to draw before `get_board` answers (default 128). Set it to the
 * deployed board's size (64 for a fresh paid board) so the first frame is already
 * the right size; the contract's reported size always wins once it is read.
 */
const INITIAL_BOARD_SIDE = Number(envString("VITE_BOARD_SIDE") || "0");
if (INITIAL_BOARD_SIDE) setBoardSide(INITIAL_BOARD_SIDE);

/**
 * Beta-round notice at the top of every page (see `app/beta-banner.ts`).
 * On unless `VITE_BETA_BANNER=false`: forgetting the variable must keep the
 * warning up, never take it down. Turn it off for the launch board only.
 */
export const BETA_BANNER_ENABLED = envString("VITE_BETA_BANNER") !== "false";
/** Public tester guide (Notion). Empty hides the link. */
export const BETA_GUIDE_URL = envString("VITE_BETA_GUIDE_URL");
/** Public issue-report form (Notion). Empty hides the link. */
export const BETA_REPORT_URL = envString("VITE_BETA_REPORT_URL");
