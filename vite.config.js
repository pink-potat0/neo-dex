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

function privacyEnvDefines(env) {
  const mappings = {
    NEXT_PUBLIC_PROGRAM_ID: env.VITE_PRIVACY_PROGRAM_ID || "",
    NEXT_PUBLIC_ALT_ADDRESS: env.VITE_PRIVACY_ALT_ADDRESS || "",
    NEXT_PUBLIC_RELAYER_API_URL: env.VITE_PRIVACY_RELAYER_API_URL || "",
    NEXT_PUBLIC_USDC_MINT: env.VITE_PRIVACY_USDC_MINT || "",
    NEXT_PUBLIC_USDT_MINT: env.VITE_PRIVACY_USDT_MINT || "",
    NEXT_PUBLIC_ZEC_MINT: env.VITE_PRIVACY_ZEC_MINT || "",
    NEXT_PUBLIC_ORE_MINT: env.VITE_PRIVACY_ORE_MINT || "",
    NEXT_PUBLIC_STORE_MINT: env.VITE_PRIVACY_STORE_MINT || "",
    NEXT_PUBLIC_JLUSDC_MINT: env.VITE_PRIVACY_JLUSDC_MINT || "",
    NEXT_PUBLIC_JLW_SOL_MINT: env.VITE_PRIVACY_JLW_SOL_MINT || "",
  };

  return Object.fromEntries(
    Object.entries(mappings)
      .filter(([, value]) => String(value).trim())
      .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])
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
