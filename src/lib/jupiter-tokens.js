import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

/** Wrapped SOL mint (native swaps use this mint in Jupiter). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

const FALLBACK = [
  { mint: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9, logoURI: "" },
  { mint: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6, logoURI: "" },
  {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    symbol: "JUP",
    name: "Jupiter",
    decimals: 6,
    logoURI: "",
  },
  {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    logoURI: "",
  },
  {
    mint: PUMP_MINT,
    symbol: "PUMP",
    name: "Pump.fun",
    decimals: 6,
    logoURI: "",
  },
];

let cached = null;
let cachedPromise = null;

function jupiterHeaders() {
  const apiKey = import.meta.env.VITE_JUPITER_API_KEY?.trim();
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

function fallbackTokenList() {
  return FALLBACK.map((t) => ({ ...t }));
}

function tokenProgramFromJupiterMeta(t) {
  if (t.token2022 === true || t.isToken2022 === true) return "token2022";
  const tags = t.tags;
  if (Array.isArray(tags)) {
    const hit = tags.some((x) => {
      const s = String(x).toLowerCase();
      return s.includes("token-2022") || s.includes("token2022");
    });
    if (hit) return "token2022";
  }
  return undefined;
}

function tokenProgramFromTokenProgramField(t) {
  const raw = t.tokenProgram;
  if (typeof raw !== "string") return undefined;
  try {
    const pk = new PublicKey(raw);
    if (pk.equals(TOKEN_2022_PROGRAM_ID)) return "token2022";
    if (pk.equals(TOKEN_PROGRAM_ID)) return "spl";
  } catch {
    /* ignore */
  }
  return undefined;
}

function normalizeEntry(t) {
  const mint = t.address || t.mint || t.id;
  if (!mint) return null;
  const decimals = Number(t.decimals);
  const tokenProgram =
    tokenProgramFromJupiterMeta(t) || tokenProgramFromTokenProgramField(t);
  const tags = t.tags;
  const tagCopy = Array.isArray(tags) && tags.length ? [...tags] : null;
  const org = t.organicScore;
  const organicScore =
    org != null && Number.isFinite(Number(org)) ? Number(org) : undefined;
  const liq = t.liquidity;
  const jupiterLiquidityUsd =
    typeof liq === "number" && isFinite(liq) ? liq : undefined;
  return {
    mint,
    symbol: String(t.symbol || "?").slice(0, 14),
    name: String(t.name || t.symbol || "Unknown").slice(0, 48),
    decimals: Number.isFinite(decimals) ? decimals : 0,
    logoURI:
      typeof t.logoURI === "string"
        ? t.logoURI
        : typeof t.icon === "string"
          ? t.icon
          : "",
    ...(tokenProgram ? { tokenProgram } : {}),
    ...(tagCopy ? { jupiterTags: tagCopy } : {}),
    ...(organicScore != null ? { organicScore } : {}),
    ...(t.isVerified === true ? { isVerified: true } : {}),
    ...(jupiterLiquidityUsd != null ? { jupiterLiquidityUsd } : {}),
  };
}

function normalizeList(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : raw?.tokens || raw?.data || [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const n = normalizeEntry(t);
    if (!n || seen.has(n.mint)) continue;
    seen.add(n.mint);
    out.push(n);
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" }));
  return out;
}

/**
 * Jupiter strict / verified-style list for mainnet (real symbols, decimals, names).
 */
export async function fetchJupiterTokenList() {
  if (cached) return cached;
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    const headers = jupiterHeaders();
    const endpoints = [
      {
        url: "https://api.jup.ag/tokens/v2/tag?query=verified",
        init: headers ? { headers } : undefined,
      },
      {
        url: "https://lite-api.jup.ag/tokens/v2/tag?query=verified",
      },
      {
        url: "https://tokens.jup.ag/tokens?tags=strict",
      },
      {
        url: "https://lite-api.jup.ag/tokens/v1/tagged/strict",
      },
      {
        url: "https://token.jup.ag/strict",
      },
    ];

    for (const endpoint of endpoints) {
      const { url, init } = endpoint;
      try {
        const res = await fetch(url, init);
        // #region agent log
        fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H1',location:'jupiter-tokens.js:token-list:response',message:'token list endpoint response',data:{url,status:res.status,ok:res.ok},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!res.ok) continue;
        const data = await res.json();
        const list = normalizeList(data);
        // #region agent log
        fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H1',location:'jupiter-tokens.js:token-list:normalized',message:'token list normalized',data:{url,count:list.length},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (list.length > 0) {
          cached = list;
          return cached;
        }
      } catch (_) {
        // #region agent log
        fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H1',location:'jupiter-tokens.js:token-list:throw',message:'token list endpoint threw',data:{url},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'00c163'},body:JSON.stringify({sessionId:'00c163',runId:'pre-fix',hypothesisId:'H1',location:'jupiter-tokens.js:token-list:fallback',message:'token list fallback used',data:{fallbackCount:FALLBACK.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    cached = fallbackTokenList();
    return cached;
  })();

  try {
    return await cachedPromise;
  } finally {
    cachedPromise = null;
  }
}

export function tokenMapByMint(list) {
  return new Map(list.map((t) => [t.mint, t]));
}

export function isSolMint(mint) {
  return mint === SOL_MINT;
}

/** True if Jupiter / normalized metadata marks the mint as Token-2022. */
export function isToken2022FromJupiterMeta(t) {
  if (!t) return false;
  if (t.tokenProgram === "token2022") return true;
  const tags = t.jupiterTags;
  if (Array.isArray(tags)) {
    return tags.some((x) => {
      const s = String(x).toLowerCase();
      return s.includes("token-2022") || s.includes("token2022");
    });
  }
  return false;
}

export function defaultFromTo(list) {
  const from = list.find((t) => t.mint === SOL_MINT) || list[0];
  const to =
    list.find((t) => t.mint === USDC_MINT && t.mint !== from?.mint) ||
    list.find((t) => t.mint !== from?.mint) ||
    list[1] ||
    from;
  return { from, to };
}

/** True if string parses as a Solana public key (mint / account). */
export function isValidMintString(s) {
  const t = String(s || "").trim();
  if (t.length < 32 || t.length > 44) return false;
  try {
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-token metadata from Jupiter (works for many mints not in the strict list).
 */
export async function fetchTokenMetaByMint(mint) {
  const m = String(mint || "").trim();
  if (!m) return null;
  const headers = jupiterHeaders();
  const urls = [
    {
      url: `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(m)}`,
      init: headers ? { headers } : undefined,
    },
    {
      url: `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(m)}`,
    },
    {
      url: `https://tokens.jup.ag/token/${encodeURIComponent(m)}`,
    },
  ];
  for (const { url, init } of urls) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) continue;
      const data = await res.json();
      const list = normalizeSearchResults(data);
      const exact = list.find((t) => t.mint === m) || list[0];
      if (exact) return exact;
      const single = normalizeEntry(data);
      if (single) return single;
    } catch {
      /* try next */
    }
  }
  return null;
}

function normalizeSearchResults(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : raw?.results || raw?.tokens || raw?.data || [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const n = normalizeEntry(t);
    if (!n || seen.has(n.mint)) continue;
    seen.add(n.mint);
    out.push(n);
  }
  return out;
}

/**
 * Search Jupiter’s token index by name, symbol, or mint substring.
 * DexScreener is not called from here — the swap UI triggers it only when this
 * returns very few rows so normal typing stays fast.
 */
export async function searchJupiterTokensByQuery(query) {
  const q = String(query || "").trim();
  if (q.length < 1) return [];
  const headers = jupiterHeaders();
  const urls = [
    {
      url: `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`,
      init: headers ? { headers } : undefined,
    },
    {
      url: `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`,
    },
    {
      url: `https://api.jup.ag/ultra/v1/search?query=${encodeURIComponent(q)}`,
      init: headers ? { headers } : undefined,
    },
    {
      url: `https://tokens.jup.ag/v1/search?q=${encodeURIComponent(q)}`,
    },
  ];
  const settled = await Promise.all(
    urls.map(async ({ url, init }) => {
      try {
        const res = await fetch(url, init);
        if (!res.ok) return [];
        const data = await res.json();
        return normalizeSearchResults(data);
      } catch {
        return [];
      }
    })
  );
  const seen = new Set();
  const out = [];
  for (const list of settled) {
    for (const t of list) {
      if (!t?.mint || seen.has(t.mint)) continue;
      seen.add(t.mint);
      out.push(t);
      if (out.length >= 100) return out;
    }
  }
  return out;
}

export function getFallbackTokenList() {
  return fallbackTokenList();
}

/**
 * Minimal SPL mint info when Jupiter has no metadata (any swappable mint).
 */
export async function resolveSplMintOnChain(connection, mintStr) {
  const m = String(mintStr || "").trim();
  if (!isValidMintString(m)) return null;
  try {
    const pk = new PublicKey(m);
    const { value } = await connection.getParsedAccountInfo(pk);
    if (!value?.data || typeof value.data !== "object") return null;
    const parsed = value.data.parsed;
    if (parsed?.type !== "mint" || parsed.info == null) return null;
    const dec = Number(parsed.info.decimals);
    const rawOwner = value.owner;
    const ownerPk =
      rawOwner instanceof PublicKey ? rawOwner : new PublicKey(rawOwner);
    let tokenProgram;
    if (ownerPk.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = "token2022";
    else if (ownerPk.equals(TOKEN_PROGRAM_ID)) tokenProgram = "spl";
    const base = {
      mint: m,
      symbol: m.slice(0, 4) + "…" + m.slice(-4),
      name:
        tokenProgram === "token2022"
          ? "Token-2022 mint · verify"
          : "SPL token · verify mint",
      decimals: Number.isFinite(dec) ? dec : 0,
      logoURI: "",
      isOnChainOnly: true,
    };
    if (tokenProgram) base.tokenProgram = tokenProgram;
    return base;
  } catch {
    return null;
  }
}
