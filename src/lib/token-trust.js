/**
 * Heuristic trust hints for the token picker (not a honeypot guarantee).
 * Prefer Jupiter strict-list + verified / organic signals, then on-chain liquidity.
 */

function liquidityToScore(usd) {
  if (usd >= 10_000_000) return 95;
  if (usd >= 1_000_000) return 88;
  if (usd >= 500_000) return 80;
  if (usd >= 100_000) return 68;
  if (usd >= 10_000) return 52;
  if (usd >= 1_000) return 38;
  if (usd > 0) return 28;
  return 15;
}

/**
 * @param {object} t normalized token row
 * @param {Set<string>} strictMintSet mints from Jupiter strict list (curated)
 * @returns {{ verified: boolean, score: number }}
 */
export function trustDisplayForToken(t, strictMintSet) {
  const mint = t?.mint;
  if (!mint) return { verified: false, score: 20 };

  if (strictMintSet.has(mint)) {
    return { verified: true, score: 100 };
  }

  const tags = t.jupiterTags || t.tags;
  const tagArr = Array.isArray(tags) ? tags : [];
  const tagLc = tagArr.map((x) => String(x).toLowerCase());
  const hasStrictTag = tagLc.some(
    (x) => x === "strict" || x.endsWith("-strict") || x.includes("strict")
  );
  const hasVerifiedTag = tagLc.some((x) => x.includes("verified"));

  let score = 32;
  let verified = false;

  const org = t.organicScore;
  if (typeof org === "number" && isFinite(org)) {
    score = Math.max(score, Math.round(Math.min(100, Math.max(0, org))));
  }

  if (t.jupiterLiquidityUsd != null && isFinite(t.jupiterLiquidityUsd)) {
    score = Math.max(score, liquidityToScore(t.jupiterLiquidityUsd));
  }

  if (t.dexscreenerLiquidityUsd != null && isFinite(t.dexscreenerLiquidityUsd)) {
    score = Math.max(score, liquidityToScore(t.dexscreenerLiquidityUsd));
  }

  if (t.isVerified === true) {
    verified = true;
    if (score < 78) score = 78;
  }
  if (hasStrictTag || (hasVerifiedTag && t.isVerified === true)) {
    verified = true;
    if (score < 85) score = 85;
  }

  if (t.isOnChainOnly) {
    verified = false;
    score = Math.min(score, 28);
  }

  score = Math.max(12, Math.min(100, Math.round(score)));
  return { verified, score };
}

export function trustScoreColorClass(score) {
  if (score >= 72) return "text-green-700 dark:text-green-400";
  if (score >= 45) return "text-amber-800 dark:text-amber-300";
  return "text-error-container dark:text-red-400";
}
