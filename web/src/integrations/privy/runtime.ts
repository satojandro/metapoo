import Privy, {
  LocalStorage,
  create as createWallet,
} from "@privy-io/js-sdk-core";
import { initSigningPage } from "@peerfolio/privy-near-connect/sign-page";
import { encodeBase58 } from "../../drawing-session";
import { resolveAccountReadiness } from "../account-readiness";
import type { PrivyConfig } from "./config";
import type { SigningSession } from "./approval";
import type { PrivyNearWallet, PrivySessionClient } from "./session";
import { checkedSdkWallet } from "./sdk-wallet";
import { PRIVY_UNSUBMITTED_REJECTION } from "./session";

export interface PrivyPageRuntime extends PrivySessionClient {
  initialize(): Promise<void>;
  handshake(wallet?: PrivyNearWallet): Promise<SigningSession>;
  sendEmailCode(email: string): Promise<void>;
  loginEmail(email: string, code: string): Promise<void>;
  googleUrl(): Promise<string>;
  completeOAuth(code: string, state: string): Promise<void>;
  assertReady(wallet: PrivyNearWallet): Promise<void>;
  rejectBeforeBroadcast(targetOrigin: string): void;
  dispose(): void;
}

/** Real SDK adapter. Tests replace this boundary, never the application's wallet authority. */
export function createPrivyRuntime(config: PrivyConfig): PrivyPageRuntime {
  const client = new Privy({
    appId: config.appId,
    clientId: config.clientId,
    storage: new LocalStorage(),
    logger: { level: "NONE", info() {}, warn() {}, error() {}, debug() {} },
  });
  const abort = new AbortController();
  return {
    initialize: () => client.initialize().then(() => undefined),
    user: { get: () => client.user.get() },
    async createNearWallet() {
      await createWallet(
        {
          fetchPrivyRoute: client.fetchPrivyRoute.bind(client),
          getCompiledPath: client.getCompiledPath.bind(client),
          app: { appId: client.app.appId },
        },
        { request: { chain_type: "near" } },
      );
    },
    logout: () => client.auth.logout(),
    async handshake(wallet) {
      return initSigningPage(client, {
        allowedOrigins: [config.origin],
        debug: false,
        signal: abort.signal,
        wallet: wallet ? checkedSdkWallet(wallet) : undefined,
        rpcOptions: { url: config.rpcUrl },
      });
    },
    sendEmailCode: (email) =>
      client.auth.email.sendCode(email).then(() => undefined),
    loginEmail: (email, code) =>
      client.auth.email.loginWithCode(email, code).then(() => undefined),
    async googleUrl() {
      const { url } = await client.auth.oauth.generateURL(
        "google",
        config.signPageUrl,
      );
      const target = new URL(url);
      if (target.protocol !== "https:")
        throw new Error("The login provider returned an invalid URL.");
      return target.href;
    },
    completeOAuth: (code, state) =>
      client.auth.oauth.loginWithCode(code, state).then(() => undefined),
    async assertReady(wallet) {
      const expectedKey = `ed25519:${encodeBase58(Uint8Array.from(wallet.address.match(/../g)!, (s) => parseInt(s, 16)))}`;
      const result = await resolveAccountReadiness(
        wallet.address,
        config.network,
        async (method, params) => {
          const response = await fetch(config.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "privy-readiness",
              method,
              params,
            }),
            signal: abort.signal,
          });
          if (!response.ok)
            throw new Error("NEAR account checks are unavailable.");
          const body = await response.json();
          if (body.error) throw body.error;
          return body.result;
        },
        expectedKey,
      );
      if (result.state !== "ready" || !result.expectedKeyMatches)
        throw new Error(
          "First receive native NEAR into this account; its account and signing key must be verified.",
        );
      if (BigInt(result.spendableBeforeGasYocto) <= 0n)
        throw new Error("Add native NEAR to pay your network fees.");
    },
    rejectBeforeBroadcast(targetOrigin) {
      if (
        targetOrigin !== config.origin ||
        typeof window === "undefined" ||
        !window.opener
      )
        throw new Error("The signing request origin could not be verified.");
      // initSigningPage exposes sign(), but no rejection callback. Use the pinned
      // adapter's ERROR envelope, which it converts into an Error with name/type.
      window.opener.postMessage(
        {
          source: "privy-near-connect",
          type: "ERROR",
          error: {
            type: PRIVY_UNSUBMITTED_REJECTION,
            message: "Cancelled before signing.",
          },
        },
        targetOrigin,
      );
    },
    dispose: () => abort.abort(),
  };
}
