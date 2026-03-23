import { Connection } from "@solana/web3.js";

const SKIP_ENV_RPC_KEY = "neo-dex-skip-rpc-url";

function rpcCandidates() {
  const env = import.meta.env.VITE_RPC_URL?.trim();
  const defaults = [
    "https://solana.publicnode.com",
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
  ];
  let useEnv = Boolean(env);
  try {
    if (env && typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem(SKIP_ENV_RPC_KEY) === env) useEnv = false;
    }
  } catch {
    /* private mode */
  }
  const list = useEnv && env ? [env, ...defaults] : defaults;
  return [...new Set(list)];
}

function errorText(err) {
  if (!err) return "";
  const parts = [err.message, err.toString?.()];
  if (typeof err.code === "number") parts.push(String(err.code));
  const data = err.data;
  if (data != null) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      parts.push(String(data));
    }
  }
  let c = err.cause;
  let depth = 0;
  while (c && depth++ < 5) {
    parts.push(c.message, c.toString?.());
    if (typeof c.code === "number") parts.push(String(c.code));
    c = c.cause;
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * HTTP/RPC denial, rate limits, or provider key restrictions — try next endpoint.
 */
export function isRpcAccessError(err) {
  const s = errorText(err);
  return (
    /403|401|429|forbidden|access denied|access forbidden|unauthorized|rate ?limit|too many requests|exceeded|api key|not allowed to access blockchain|-32052/i.test(
      s
    ) || (typeof err?.code === "number" && err.code === -32052)
  );
}

function rememberSkipEnvRpc(url) {
  const env = import.meta.env.VITE_RPC_URL?.trim();
  if (!env || url !== env) return;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(SKIP_ENV_RPC_KEY, env);
    }
  } catch {
    /* */
  }
}

/**
 * Try each RPC until the operation succeeds. Use for reads (balance, send, confirm).
 */
export async function withRpcRetry(operation) {
  const urls = rpcCandidates();
  let lastErr;
  for (const url of urls) {
    const conn = new Connection(url, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 90_000,
    });
    try {
      return await operation(conn);
    } catch (e) {
      lastErr = e;
      if (isRpcAccessError(e)) {
        rememberSkipEnvRpc(url);
      }
      /** Try every candidate — transient timeouts / 5xx / rate limits are common on public RPCs. */
      continue;
    }
  }
  throw (
    lastErr ||
    new Error(
      "All RPC endpoints failed. If VITE_RPC_URL uses an API key, enable blockchain / JSON-RPC access for that key in your provider dashboard, or remove VITE_RPC_URL to use public fallbacks."
    )
  );
}

let cachedConn = null;

/** First working RPC (cached). Call invalidateRpcCache() if requests start failing. */
export async function ensureRpc() {
  if (cachedConn) return cachedConn;
  cachedConn = await withRpcRetry(async (conn) => {
    await conn.getLatestBlockhash("confirmed");
    return conn;
  });
  return cachedConn;
}

export function invalidateRpcCache() {
  cachedConn = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Robust signature confirmation across rotating RPC endpoints.
 * Avoids single-endpoint confirm stalls while preserving a single send flow.
 */
export async function waitForSignatureConfirmation(
  signature,
  opts = {}
) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 75_000;
  const pollMs =
    typeof opts.pollMs === "number" && opts.pollMs > 0 ? opts.pollMs : 1_200;
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const st = await withRpcRetry(async (conn) => {
        const resp = await conn.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        return resp?.value?.[0] || null;
      });
      if (st) {
        if (st.err) {
          throw new Error("Transaction failed on-chain");
        }
        if (
          st.confirmationStatus === "confirmed" ||
          st.confirmationStatus === "finalized"
        ) {
          return;
        }
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(pollMs);
  }
  throw (
    lastErr ||
    new Error("Timed out while waiting for transaction confirmation")
  );
}
