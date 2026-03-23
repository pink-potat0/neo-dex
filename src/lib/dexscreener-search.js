/**
 * DexScreener search (Solana only). Used as a second, slower step when Jupiter
 * returns very few matches so normal typing stays on the fast path.
 */
const DS_SEARCH = "https://api.dexscreener.com/latest/dex/search";

function numOr(x, d = 0) {
  if (typeof x === "number" && isFinite(x)) return x;
  if (typeof x === "string") {
    const n = parseFloat(x);
    return isFinite(n) ? n : d;
  }
  return d;
}

/**
 * @param {string} query
 * @returns {Promise<Array<{ mint: string, symbol: string, name: string, logoURI: string, dexscreenerLiquidityUsd: number, dexscreenerVolume24h: number }>>}
 */
export async function searchDexscreenerSolanaTokens(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    const res = await fetch(
      DS_SEARCH + "?q=" + encodeURIComponent(q)
    );
    if (!res.ok) return [];
    const j = await res.json();
    const pairs = j?.pairs;
    if (!Array.isArray(pairs)) return [];

    /** @type {Map<string, { mint: string, symbol: string, name: string, logoURI: string, dexscreenerLiquidityUsd: number, dexscreenerVolume24h: number }>} */
    const byMint = new Map();
    for (const p of pairs) {
      if (p?.chainId !== "solana") continue;
      const bt = p.baseToken;
      if (!bt?.address) continue;
      const mint = String(bt.address);
      const liq = numOr(p.liquidity?.usd);
      const vol = numOr(p.volume?.h24);
      const img =
        typeof p.info?.imageUrl === "string" ? p.info.imageUrl : "";
      const prev = byMint.get(mint);
      if (!prev || liq > prev.dexscreenerLiquidityUsd) {
        byMint.set(mint, {
          mint,
          symbol: String(bt.symbol || "?").slice(0, 14),
          name: String(bt.name || bt.symbol || "Token").slice(0, 48),
          logoURI: img,
          dexscreenerLiquidityUsd: liq,
          dexscreenerVolume24h: vol,
        });
      }
    }

    const out = [...byMint.values()].sort(
      (a, b) => b.dexscreenerLiquidityUsd - a.dexscreenerLiquidityUsd
    );
    return out.slice(0, 40);
  } catch {
    return [];
  }
}
