import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
export default defineConfig({
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
});
