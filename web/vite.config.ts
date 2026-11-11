import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Stamp the build into the bundle. Without it a tester's "it broke" cannot be tied to
 * a commit, and a stale bundle in a browser tab looks exactly like a live bug.
 */
const buildId = (() => {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: here, encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
})();

// The board description lives above this folder so the Rust contract can read it too.
export default defineConfig(({ command, mode }) => {
  // The share tags in index.html are written with `%VITE_SITE_URL%`. That has to be an
  // absolute origin, because a crawler cannot resolve a relative og:image — and a site
  // that moves domain must not have its old host baked into a build. Fail loudly rather
  // than ship the literal placeholder, which is what an unset variable would leave.
  const env = loadEnv(mode, here, "VITE_");
  const siteUrl = (env.VITE_SITE_URL ?? "").replace(/\/+$/, "");
  if (command === "build" && !/^https?:\/\/[^/]+$/.test(siteUrl)) {
    throw new Error(
      "VITE_SITE_URL must be an absolute origin without a path, e.g. " +
        "https://metapoo-testnet.vercel.app — set it in web/.env.production (or the " +
        "Vercel environment) and rebuild. The Open Graph and Twitter tags are built from it.",
    );
  }

  return {
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    build: {
      rollupOptions: {
        input: { app: path.resolve(here, "index.html"), privy: path.resolve(here, "privy-sign.html") },
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(here, "../shared"),
        // Privy's connector pulls in generate-function; its util.format must run in browsers.
        util: path.resolve(here, "node_modules/util/util.js"),
      },
    },
    server: {
      fs: {
        allow: [path.resolve(here, "..")],
      },
    },
    // Deep links (/wall, /bounties/:id, …) fall back to index.html in preview too.
    preview: {
      // Vite preview already serves SPA fallback for non-file routes.
    },
    test: {
      environment: "node",
    },
  };
});
