import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// The board description lives above this folder so the Rust contract can read it too.
export default defineConfig({
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
