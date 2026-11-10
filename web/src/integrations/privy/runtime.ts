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

const PRIVY_SIGNED_OUT_CODE = "missing_or_invalid_token";
function isSignedOutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PRIVY_SIGNED_OUT_CODE
  );
}

export const PRIVY_SIGNED_OUT_DIAGNOSTIC_KEY = "privy-sign:lastSignedOut";

/** Which Privy session keys exist. Presence only: token values never leave the SDK's storage. */
function privyTokenPresence(): { accessToken: boolean; refreshToken: boolean } {
  try {
    const keys = Object.keys(globalThis.localStorage ?? {});
    return {
      accessToken: keys.some((k) => /^privy:(.+:)?token$/.test(k)),
      refreshToken: keys.some((k) => /^privy:(.+:)?refresh_token$/.test(k)),
    };
  } catch {
    return { accessToken: false, refreshToken: false };
  }
}

/**
 * Why the sign page fell back to the login screen. Tokens missing beforehand means they were
 * never kept or were cleared elsewhere; tokens present means Privy rejected the refresh token.
 */
function recordSignedOut(
  before: { accessToken: boolean; refreshToken: boolean },
  error: unknown,
): void {
  const cause =
    before.accessToken && before.refreshToken
      ? "refresh_rejected"
      : "tokens_missing";
  const detail = {
    at: new Date().toISOString(),
    cause,
    hadAccessToken: before.accessToken,
    hadRefreshToken: before.refreshToken,
    message: error instanceof Error ? error.message : String(error),
  };
  console.warn("[privy-sign] signed out:", detail);
  try {
    globalThis.localStorage?.setItem(
      PRIVY_SIGNED_OUT_DIAGNOSTIC_KEY,
      JSON.stringify(detail),
    );
  } catch {
    // Diagnostics must never be the thing that breaks the page.
  }
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
    user: {
      // js-sdk-core@0.72.0 does not return `{ user: null }` for a signed-out visitor: it
      // throws PrivyApiError `missing_or_invalid_token` ("No tokens found in storage").
      // Treating that as fatal hid the login form from every first-time player. Only
      // that code means "signed out"; any other failure still propagates.
      async get() {
        // Snapshot before the call: on a rejected refresh token the SDK wipes these keys.
        const before = privyTokenPresence();
        try {
          return await client.user.get();
        } catch (error) {
          if (isSignedOutError(error)) {
            recordSignedOut(before, error);
            return { user: null };
          }
          throw error;
        }
      },
    },
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
