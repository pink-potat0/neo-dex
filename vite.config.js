import { resolve } from "node:path";
import { defineConfig } from "vite";
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
};

export default defineConfig(() => {
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
      exclude: ["@lightprotocol/hasher.rs"],
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
          reclaim: resolve(__dirname, "pages/reclaim.html"),
        },
      },
    },
  };
});
