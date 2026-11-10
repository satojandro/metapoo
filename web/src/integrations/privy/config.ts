import executorAsset from "./vendor-executor.js?url";
import type { WalletManifest } from "@hot-labs/near-connect";
import { MPOO_ACCOUNT } from "../../paint-wallet";

export const PRIVY_WALLET_ID = "metapoo-privy";
export const PRIVY_PACKAGE_VERSION = "0.0.8";
export const PRIVY_CORE_VERSION = "0.72.0";
export type PrivyNetwork = "mainnet" | "testnet";
export interface PrivyConfig {
  appId: string;
  clientId: string;
  network: PrivyNetwork;
  origin: string;
  signPageUrl: string;
  rpcUrl: string;
  sendEnabled?: boolean;
  selfCustodyEnabled?: boolean;
  sendTokens?: readonly import("../send/plan").SendToken[];
  sendBlockedRecipients?: readonly string[];
}
export type PrivyAvailability =
  | { state: "disabled" }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; config: PrivyConfig };

/**
 * Public IDs are configuration, never provider secrets. Fail closed on ambiguous networks.
 *
 * `clientId` is optional by SDK contract: js-sdk-core inlines it as an `appClientId`
 * that is only ever read behind a truthiness guard (a `privy-client-id` header and a
 * `client_id` query param on the embedded-wallet iframe). Without it, requests are
 * scoped to the app's default settings instead of an app-client profile, which costs
 * per-environment session duration and per-client origins — not login or wallet creation.
 * An empty value therefore stays `ready`, and a real app client can be dropped in later.
 */
export function readPrivyConfig(
  env: Record<string, unknown>,
  origin: string,
): PrivyAvailability {
  if (env.VITE_PRIVY_ENABLED !== "true") return { state: "disabled" };
  try {
    const appId = String(env.VITE_PRIVY_APP_ID ?? "").trim();
    const clientId = String(env.VITE_PRIVY_APP_CLIENT_ID ?? "").trim();
    const rawNetwork = String(env.VITE_NEAR_NETWORK ?? "").trim();
    // Mirror src/config.ts: an unset network means testnet. Requiring the variable here made
    // Privy vanish whenever it happened not to be in the loaded env files, which reads as
    // "social login is broken". An explicit mock/localnet is still refused, because those are
    // not networks a wallet can be provisioned on.
    const network = rawNetwork === "" ? "testnet" : rawNetwork;
    if (
      !appId ||
      !["mainnet", "testnet"].includes(network)
    )
      throw new Error();
    const appOrigin = new URL(origin);
    const sign = new URL(String(env.VITE_PRIVY_SIGN_PAGE_URL ?? ""), origin);
    // A real separate HTML asset is used; user-supplied return URLs are never accepted.
    if (
      !env.VITE_PRIVY_SIGN_PAGE_URL ||
      sign.origin !== appOrigin.origin ||
      sign.search ||
      sign.hash ||
      sign.username ||
      sign.password ||
      !sign.pathname.endsWith("/privy-sign.html")
    )
      throw new Error();
    const local =
      appOrigin.hostname === "localhost" || appOrigin.hostname === "127.0.0.1";
    if (
      appOrigin.protocol !== "https:" &&
      !(local && appOrigin.protocol === "http:")
    )
      throw new Error();
    const rpc = new URL(
      String(
        env.VITE_NEAR_RPC_URL ||
          (network === "mainnet"
            ? "https://rpc.mainnet.near.org"
            : "https://rpc.testnet.near.org"),
      ),
    );
    if (rpc.username || rpc.password) throw new Error();
    if (
      rpc.protocol !== "https:" &&
      !(local && ["localhost", "127.0.0.1"].includes(rpc.hostname))
    )
      throw new Error();
    return {
      state: "ready",
      config: {
        appId,
        clientId,
        network: network as PrivyNetwork,
        origin: appOrigin.origin,
        signPageUrl: sign.href,
        rpcUrl: rpc.href,
        sendEnabled: env.VITE_SEND_ENABLED === "true",
        selfCustodyEnabled: env.VITE_SELF_CUSTODY_ENABLED === "true",
        sendTokens: [
          {contractId: String(env.VITE_TOILET_ID ?? ""), symbol: "TOILET", decimals: 18},
          ...(env.VITE_SEND_MPOO_ENABLED === "true" ? [{contractId: network === "mainnet" ? MPOO_ACCOUNT : String(env.VITE_MPOO_ID ?? ""), symbol: network === "mainnet" ? "mPOO" : "Test mPOO", decimals: 18}] : []),
        ].filter(t => t.contractId),
        sendBlockedRecipients: [String(env.VITE_CONTRACT_ID ?? "")].filter(Boolean),
      },
    };
  } catch {
    return {
      state: "unavailable",
      reason:
        "Social login needs valid public Privy IDs, network, and same-origin signing-page configuration.",
    };
  }
}

/**
 * Picker icon: an envelope on the brand yellow, matching the game's tag colour (design/tokens.css).
 * Data URI because the selector renders it as a plain <img> outside our CSS.
 */
export const PRIVY_PICKER_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="14" fill="#f1dc5e"/>' +
      '<rect x="14" y="20" width="36" height="25" rx="4" fill="none" stroke="#17171a" stroke-width="4"/>' +
      '<path d="M16 23l16 12 16-12" fill="none" stroke="#17171a" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>' +
      "</svg>",
  );

/** Add this entry to the default connector manifest; never replace existing wallets. */
export function createPrivyManifest(
  config: PrivyConfig,
): WalletManifest & { metadata: { signPageURL: string; debug: boolean } } {
  return {
    id: PRIVY_WALLET_ID,
    name: "Google or email",
    version: PRIVY_PACKAGE_VERSION,
    description:
      "Sign in to a NEAR account with Google or email. You pay your own network fees.",
    // Inline so it can never 404 (there is no favicon.ico; the picker showed a broken image).
    icon: PRIVY_PICKER_ICON,
    // The picker prints this hostname under the name. "privy.io" tells the player who handles
    // the sign-in; the game's own origin there read as a second, unexplained site.
    website: "https://privy.io",
    executor: new URL(executorAsset, config.origin).href,
    type: "sandbox" as const,
    platform: ["web"],
    features: {
      signInWithoutAddKey: true,
      signInWithFunctionCallKey: true,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
      mainnet: true,
      testnet: true,
      signMessage: false,
      signTransaction: false,
      signInAndSignMessage: false,
      signDelegateActions: false,
    },
    permissions: { storage: true, allowsOpen: [config.signPageUrl] },
    metadata: { signPageURL: config.signPageUrl, debug: false },
  };
}
