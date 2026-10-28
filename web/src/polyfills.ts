/**
 * Browser globals the NEAR client libraries expect.
 *
 * `@near-js/transactions` builds a FunctionCall action with
 * `Buffer.from(JSON.stringify(args))` (action_creators.js). Node has `Buffer`
 * globally; browsers do not, so every in-page signing path — the drawing
 * session that paints without a wallet popup — threw
 * `ReferenceError: Buffer is not defined` before it could serialise anything.
 *
 * The wallet path was unaffected because the wallet builds and signs the
 * transaction in its own context. That is why the same page could paint one
 * pixel at a time with approvals but never submit a stroke.
 *
 * This module must be imported before any code that touches those libraries.
 */
import { Buffer } from "buffer";

const scope = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string> };
};

// `buffer` ships an ESM build; expose it the way the libraries expect.
if (typeof scope.Buffer === "undefined") {
  scope.Buffer = Buffer;
}

// Several bundled dependencies reference `global` (a Node convention). Vite
// externalises these lookups rather than failing the build, so they only break
// at runtime — which is exactly the class of bug this file exists to prevent.
if (typeof scope.global === "undefined") {
  scope.global = globalThis;
}

// `process.env` reads are guarded in most of these packages, but an unguarded
// one throws. An empty object keeps those reads undefined instead of fatal.
if (typeof scope.process === "undefined") {
  scope.process = { env: {} };
}

export {};
