import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const devProxy = {
  "/__jupiter_quote": {
    target: "https://quote-api.jup.ag",
    changeOrigin: true,
    secure: true,
    rewrite: (p) => p.replace(/^\/__jupiter_quote/, ""),
  },
  "/__jupiter_api": {
    target: "https://api.jup.ag",
    changeOrigin: true,
    secure: true,
    rewrite: (p) => p.replace(/^\/__jupiter_api/, ""),
  },
};

export default defineConfig({
  root: ".",
  /** Relative asset URLs so the app works from subpaths, static hosts, and file:// opens. */
  base: "./",
  publicDir: false,
  /** Browser → same-origin paths → Jupiter (avoids CORS in dev). */
  server: { proxy: devProxy },
  preview: { proxy: devProxy },
  plugins: [
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "events", "util", "vm"],
      globals: { Buffer: true, global: true, process: true },
    }),
    viteStaticCopy({
      targets: [{ src: "assets/**/*", dest: "assets" }],
    }),
  ],
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    exclude: ["@lightprotocol/hasher.rs", "privacycash"],
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        portfolio: resolve(__dirname, "pages/portfolio.html"),
        swap: resolve(__dirname, "pages/swap.html"),
        bridge: resolve(__dirname, "pages/bridge.html"),
        send: resolve(__dirname, "pages/send.html"),
        cleanup: resolve(__dirname, "pages/cleanup.html"),
      },
    },
  },
});
