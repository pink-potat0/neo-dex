import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const cleanRouteMap = new Map([
  ["/portfolio", "/pages/portfolio.html"],
  ["/swap", "/pages/swap.html"],
  ["/send", "/pages/send.html"],
  ["/bridge", "/pages/bridge.html"],
  ["/reclaim", "/pages/reclaim.html"],
]);

function rewriteCleanPageRequest(req) {
  const rawUrl = String(req.url || "");
  const [pathname, search = ""] = rawUrl.split("?");
  const normalizedPath =
    pathname.endsWith("/") && pathname.length > 1
      ? pathname.slice(0, -1)
      : pathname;
  const mapped = cleanRouteMap.get(normalizedPath);
  if (!mapped) return;
  req.url = mapped + (search ? "?" + search : "");
}

function cleanPageRoutesPlugin() {
  return {
    name: "neo-dex-clean-page-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewriteCleanPageRequest(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewriteCleanPageRequest(req);
        next();
      });
    },
  };
}

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
  "/__privacycash_api": {
    target: "https://api3.privacycash.org",
    changeOrigin: true,
    secure: true,
    rewrite: (p) => p.replace(/^\/__privacycash_api/, ""),
  },
};

/** privacycash mainnet defaults; `define` injects NEXT_PUBLIC_* for the SDK bundle. */
const PRIVACY_DEFAULTS = {
  PROGRAM_ID: "9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD",
  ALT_ADDRESS: "HEN49U2ySJ85Vc78qprSW9y6mFDhs1NczRxyppNHjofe",
  RELAYER_API_URL: "https://api3.privacycash.org",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT_MINT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ZEC_MINT: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
  ORE_MINT: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",
  STORE_MINT: "sTorERYB6xAZ1SSbwpK3zoK2EEwbBrc7TZAzg1uCGiH",
  JLUSDC_MINT: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
  JLW_SOL_MINT: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU",
};

function privacyEnvDefines(env) {
  const pick = (k, def) =>
    String(env[k] ?? def ?? "")
      .trim()
      .replace(/\/+$/, "");
  /** Empty env would bake "" into the SDK and break fetch URLs — fall back to default. */
  const relayerUrl =
    String(env.VITE_PRIVACY_RELAYER_API_URL ?? "")
      .trim()
      .replace(/\/+$/, "") || PRIVACY_DEFAULTS.RELAYER_API_URL;
  const mappings = {
    NEXT_PUBLIC_PROGRAM_ID: pick("VITE_PRIVACY_PROGRAM_ID", PRIVACY_DEFAULTS.PROGRAM_ID),
    NEXT_PUBLIC_ALT_ADDRESS: pick("VITE_PRIVACY_ALT_ADDRESS", PRIVACY_DEFAULTS.ALT_ADDRESS),
    NEXT_PUBLIC_RELAYER_API_URL: relayerUrl,
    NEXT_PUBLIC_USDC_MINT: pick("VITE_PRIVACY_USDC_MINT", PRIVACY_DEFAULTS.USDC_MINT),
    NEXT_PUBLIC_USDT_MINT: pick("VITE_PRIVACY_USDT_MINT", PRIVACY_DEFAULTS.USDT_MINT),
    NEXT_PUBLIC_ZEC_MINT: pick("VITE_PRIVACY_ZEC_MINT", PRIVACY_DEFAULTS.ZEC_MINT),
    NEXT_PUBLIC_ORE_MINT: pick("VITE_PRIVACY_ORE_MINT", PRIVACY_DEFAULTS.ORE_MINT),
    NEXT_PUBLIC_STORE_MINT: pick("VITE_PRIVACY_STORE_MINT", PRIVACY_DEFAULTS.STORE_MINT),
    NEXT_PUBLIC_JLUSDC_MINT: pick("VITE_PRIVACY_JLUSDC_MINT", PRIVACY_DEFAULTS.JLUSDC_MINT),
    NEXT_PUBLIC_JLW_SOL_MINT: pick("VITE_PRIVACY_JLW_SOL_MINT", PRIVACY_DEFAULTS.JLW_SOL_MINT),
  };

  return Object.fromEntries(
    Object.entries(mappings).map(([key, value]) => [
      `process.env.${key}`,
      JSON.stringify(value),
    ])
  );
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const privacyDefines = privacyEnvDefines(env);

  return {
    root: ".",
    /** Relative asset URLs so the app works from subpaths, static hosts, and file:// opens. */
    base: "./",
    publicDir: false,
    /** Browser -> same-origin paths -> Jupiter (avoids CORS in dev). */
    server: { proxy: devProxy },
    preview: { proxy: devProxy },
    plugins: [
      cleanPageRoutesPlugin(),
      nodePolyfills({
        include: ["crypto", "buffer", "stream", "events", "util", "vm"],
        globals: { Buffer: true, global: true, process: true },
      }),
      viteStaticCopy({
        targets: [
          { src: "assets/**/*", dest: "assets" },
          {
            src: "node_modules/privacycash/circuit2/*",
            dest: "assets/privacycash",
          },
        ],
      }),
    ],
    resolve: {
      alias: {
        buffer: "buffer",
      },
    },
    define: {
      global: "globalThis",
      ...privacyDefines,
    },
    optimizeDeps: {
      exclude: ["@lightprotocol/hasher.rs", "privacycash"],
      esbuildOptions: {
        define: {
          global: "globalThis",
          ...privacyDefines,
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
          reclaim: resolve(__dirname, "pages/reclaim.html"),
        },
      },
    },
  };
});
