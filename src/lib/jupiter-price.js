import { SOL_MINT } from "./jupiter-tokens.js";

/**
 * USD reference prices: Jupiter public APIs, optional DexScreener (Solana pairs only),
 * then CoinGecko overwrites wrapped SOL so cross-chain DexScreener noise cannot win.
 */
const PRICE_LEGACY = "https://price.jup.ag/v6/price";
const PRICE_V2 = "https://api.jup.ag/price/v2";

function jupiterHeaders() {
  const apiKey = import.meta.env.VITE_JUPITER_API_KEY?.trim();
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

/** Major Solana USD stables — APIs sometimes return junk `price` fields (~$3+ for USDC). */
export const USD_PEG_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
]);

function parsePriceEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === "number" && isFinite(entry)) return entry;
  if (typeof entry === "string") {
    const n = parseFloat(entry);
    return isFinite(n) ? n : null;
  }
  if (typeof entry === "object") {
    const raw =
      entry.usdPrice ??
      entry.priceUsd ??
      entry.price ??
      entry.value;
    if (typeof raw === "number" && isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const n = parseFloat(raw);
      return isFinite(n) ? n : null;
    }
  }
  return null;
}

function mergeJupiterPayload(json, chunk, out) {
  const data =
    json?.data && typeof json.data === "object"
      ? json.data
      : typeof json === "object" && json && !Array.isArray(json)
        ? json
        : null;
  if (!data) return false;
  let hit = false;
  for (const mint of chunk) {
    if (out.has(mint)) continue;
    let entry = data[mint];
    if (entry == null) {
      const keys = Object.keys(data);
      const k = keys.find((x) => x === mint || x.toLowerCase() === mint.toLowerCase());
      if (k) entry = data[k];
    }
    const p = parsePriceEntry(entry);
    if (p != null) {
      out.set(mint, p);
      hit = true;
    }
  }
  return hit;
}

async function fetchCoinGeckoSolUsd() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    if (!res.ok) return null;
    const j = await res.json();
    const p = j?.solana?.usd;
    return typeof p === "number" && isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

function dexscreenerMetaFromPair(pair, mint) {
  const m = String(mint);
  const base = pair?.baseToken;
  const quote = pair?.quoteToken;
  let tok = null;
  if (base?.address === m) tok = base;
  else if (quote?.address === m) tok = quote;
  else tok = base;
  if (!tok) return null;
  const sym = String(tok.symbol || "").trim();
  const name = String(tok.name || tok.symbol || "").trim();
  const logo =
    (typeof pair.info?.imageUrl === "string" && pair.info.imageUrl) ||
    (typeof tok.image === "string" && tok.image) ||
    "";
  if (!sym && !name) return null;
  return {
    symbol: sym.slice(0, 14),
    name: name.slice(0, 48),
    logoURI: logo,
  };
}

/**
 * One DexScreener request: USD price (when available) + base/quote token name, symbol, icon.
 * @param {string} mint
 * @returns {Promise<{ priceUsd: number | null, symbol?: string, name?: string, logoURI?: string } | null>}
 */
export async function fetchDexscreenerSolanaMintProfile(mint) {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint)
    );
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = j?.pairs;
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const sol = pairs.filter((p) => p?.chainId === "solana");
    if (!sol.length) return null;
    sol.sort(
      (a, b) =>
        (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0)
    );
    const pick =
      sol.find((p) => p?.priceUsd != null && p.priceUsd !== "") || sol[0];
    if (!pick) return null;
    const raw = pick?.priceUsd;
    const n = typeof raw === "string" ? parseFloat(raw) : raw;
    const priceUsd =
      typeof n === "number" && isFinite(n) && n > 0 ? n : null;
    const meta = dexscreenerMetaFromPair(pick, mint);
    return {
      priceUsd,
      ...(meta || {}),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string[]} mints
 * @param {{
 *   skipDexscreener?: boolean,
 *   dexscreenerMax?: number,
 *   outDexscreenerMeta?: Map<string, { symbol?: string, name?: string, logoURI?: string }>,
 * }} [opts]
 */
export async function fetchUsdPricesForMints(mints, opts = {}) {
  const uniq = [...new Set(mints)].filter(Boolean);
  const out = new Map();
  if (!uniq.length) return out;

  const chunkSize = 80;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const qs = chunk.map(encodeURIComponent).join(",");

    for (const base of [PRICE_LEGACY, PRICE_V2]) {
      try {
        const useHeaders = base === PRICE_V2 ? jupiterHeaders() : undefined;
        const res = await fetch(
          `${base}?ids=${qs}`,
          useHeaders ? { headers: useHeaders } : undefined
        );
        if (!res.ok) continue;
        const json = await res.json();
        if (mergeJupiterPayload(json, chunk, out)) break;
      } catch {
        /* next base */
      }
    }
  }

  const metaOut = opts.outDexscreenerMeta;
  const wantSolCg = uniq.includes(SOL_MINT);

  if (opts.skipDexscreener !== true) {
    const missing = uniq.filter((m) => !out.has(m));
    const cap =
      typeof opts.dexscreenerMax === "number" && opts.dexscreenerMax >= 0
        ? opts.dexscreenerMax
        : 24;
    const toFetch = missing.slice(0, cap);
    const [, cgSol] = await Promise.all([
      Promise.all(
        toFetch.map(async (mint) => {
          const profile = await fetchDexscreenerSolanaMintProfile(mint);
          if (profile?.priceUsd != null) out.set(mint, profile.priceUsd);
          if (
            metaOut &&
            profile &&
            (profile.symbol || profile.name || profile.logoURI)
          ) {
            const skipDsLogo =
              USD_PEG_MINTS.has(mint) || mint === SOL_MINT;
            metaOut.set(mint, {
              symbol: profile.symbol,
              name: profile.name,
              ...(skipDsLogo
                ? {}
                : { logoURI: profile.logoURI || "" }),
            });
          }
        })
      ),
      wantSolCg ? fetchCoinGeckoSolUsd() : Promise.resolve(null),
    ]);
    if (cgSol != null) out.set(SOL_MINT, cgSol);
  } else if (wantSolCg) {
    const p = await fetchCoinGeckoSolUsd();
    if (p != null) out.set(SOL_MINT, p);
  }

  for (const m of uniq) {
    if (!USD_PEG_MINTS.has(m)) continue;
    const cur = out.get(m);
    if (cur == null || !isFinite(cur) || cur < 0.92 || cur > 1.08) {
      out.set(m, 1);
    }
  }

  return out;
}

export function formatUsd(value) {
  if (value == null || !isFinite(value)) return "—";
  if (value >= 1)
    return (
      "$" +
      value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  if (value >= 0.01) return "$" + value.toFixed(4);
  if (value > 0) return "$" + value.toFixed(6);
  return "$0.00";
}

export function formatUsdCompact(value) {
  if (value == null || !isFinite(value)) return "";
  return " (~" + formatUsd(value) + ")";
}
