import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getPublicKey } from "./wallet-session.js";
import { SOL_MINT, isSolMint } from "./jupiter-tokens.js";

/** Short-lived cache so swap / send UIs reuse one wallet poll per ~15s. */
const WALLET_UI_BAL_CACHE_MS = 15_000;
let walletUiByMintCache = null;
let walletUiDetailsCache = null;
let walletUiByMintCacheKey = "";
let walletUiByMintCacheAt = 0;
let walletBalInFlight = null;
let walletBalInFlightKey = "";

function jupiterHeaders() {
  const apiKey = import.meta.env.VITE_JUPITER_API_KEY?.trim();
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

function cacheWalletSnapshot(key, balances, detailsByMint) {
  walletUiByMintCache = balances;
  walletUiDetailsCache = detailsByMint;
  walletUiByMintCacheKey = key;
  walletUiByMintCacheAt = Date.now();
}

function parseUiAmountish(value, fallbackRaw, decimals) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    if (isFinite(n)) return n;
  }
  if (fallbackRaw != null && Number.isFinite(decimals)) {
    const raw = String(fallbackRaw).trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw) / Math.pow(10, decimals);
      if (isFinite(n)) return n;
    }
  }
  return NaN;
}

async function fetchWalletBalancesViaJupiter(ownerPk58) {
  const headers = jupiterHeaders();
  if (!headers) return null;
  const res = await fetch(
    "https://api.jup.ag/ultra/v1/holdings/" + encodeURIComponent(ownerPk58),
    { headers }
  );
  if (!res.ok) {
    throw new Error("Jupiter holdings request failed (" + res.status + ")");
  }
  const payload = await res.json();
  const byMint = new Map();
  const detailsByMint = new Map();

  const solUi = parseUiAmountish(payload?.uiAmount, payload?.amount, 9);
  if (isFinite(solUi) && solUi >= 0) {
    byMint.set(SOL_MINT, solUi);
    detailsByMint.set(SOL_MINT, {
      mint: SOL_MINT,
      decimals: 9,
      tokenProgram: "spl",
    });
  }

  const tokens = payload?.tokens;
  if (tokens && typeof tokens === "object") {
    for (const [mint, accounts] of Object.entries(tokens)) {
      if (!Array.isArray(accounts) || !accounts.length) continue;
      let total = 0;
      let decimals = null;
      let tokenProgram = undefined;
      for (const acct of accounts) {
        const dec = Number(acct?.decimals);
        if (Number.isFinite(dec) && decimals == null) decimals = dec;
        const ui = parseUiAmountish(acct?.uiAmount, acct?.amount, dec);
        if (isFinite(ui) && ui > 0) total += ui;
        const programId = String(acct?.programId || "");
        try {
          const pk = new PublicKey(programId);
          if (pk.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = "token2022";
          else if (pk.equals(TOKEN_PROGRAM_ID) && !tokenProgram) tokenProgram = "spl";
        } catch {
          /* ignore */
        }
      }
      if (!(isFinite(total) && total > 0)) continue;
      byMint.set(mint, total);
      detailsByMint.set(mint, {
        mint,
        decimals: Number.isFinite(decimals) ? decimals : 0,
        ...(tokenProgram ? { tokenProgram } : {}),
      });
    }
  }

  return { byMint, detailsByMint };
}

/** Snapshot map for this wallet if cache is still fresh (swap “Available” optimistic line). */
export function readWalletUiBalanceCache(ownerPk58) {
  const now = Date.now();
  if (
    walletUiByMintCache &&
    walletUiByMintCacheKey === ownerPk58 &&
    now - walletUiByMintCacheAt < WALLET_UI_BAL_CACHE_MS
  ) {
    return walletUiByMintCache;
  }
  return null;
}

export function readWalletUiBalanceDetailsCache(ownerPk58) {
  const now = Date.now();
  if (
    walletUiDetailsCache &&
    walletUiByMintCacheKey === ownerPk58 &&
    now - walletUiByMintCacheAt < WALLET_UI_BAL_CACHE_MS
  ) {
    return walletUiDetailsCache;
  }
  return null;
}

export function invalidateWalletBalSnapshot() {
  walletUiByMintCache = null;
  walletUiDetailsCache = null;
  walletUiByMintCacheKey = "";
  walletUiByMintCacheAt = 0;
  walletBalInFlight = null;
  walletBalInFlightKey = "";
}

/**
 * One round-trip batch: native SOL + all SPL + Token-2022 accounts (sums per mint).
 */
async function buildWalletBalancesSnapshot(conn, ownerPk) {
  const byMint = new Map();
  const detailsByMint = new Map();
  const [lamportsRes, parsedSplRes, parsed2022Res] = await Promise.allSettled([
    conn.getBalance(ownerPk, "confirmed"),
    conn.getParsedTokenAccountsByOwner(ownerPk, {
      programId: TOKEN_PROGRAM_ID,
    }),
    conn.getParsedTokenAccountsByOwner(ownerPk, {
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ]);
  if (lamportsRes.status !== "fulfilled") {
    throw lamportsRes.reason || new Error("Could not fetch SOL balance");
  }
  const lamports = lamportsRes.value;
  const parsedSpl =
    parsedSplRes.status === "fulfilled" ? parsedSplRes.value : { value: [] };
  const parsed2022 =
    parsed2022Res.status === "fulfilled" ? parsed2022Res.value : { value: [] };

  function ingest(parsed) {
    for (const { account } of parsed.value) {
      const p = account?.data?.parsed;
      if (p?.type !== "account" || !p.info) continue;
      const info = p.info;
      const mint = info.mint;
      const ta = info.tokenAmount;
      if (!ta) continue;
      let rawAmt;
      const raw = ta.amount;
      if (typeof raw === "bigint") rawAmt = raw;
      else if (typeof raw === "number" && Number.isFinite(raw))
        rawAmt = BigInt(Math.trunc(raw));
      else {
        const str = String(raw ?? "0").trim();
        if (!/^\d+$/.test(str)) continue;
        rawAmt = BigInt(str);
      }
      if (rawAmt <= 0n) continue;
      const ui =
        ta.uiAmount != null
          ? ta.uiAmount
          : Number(rawAmt) / Math.pow(10, ta.decimals || 0);
      if (!isFinite(ui) || ui <= 0) continue;
      byMint.set(mint, (byMint.get(mint) || 0) + ui);
      if (!detailsByMint.has(mint)) {
        detailsByMint.set(mint, {
          mint,
          decimals: Number(ta.decimals) || 0,
          tokenProgram:
            parsed === parsed2022
              ? "token2022"
              : "spl",
        });
      }
    }
  }
  ingest(parsedSpl);
  ingest(parsed2022);

  let solUi = lamports / LAMPORTS_PER_SOL;
  solUi += byMint.get(SOL_MINT) || 0;
  byMint.set(SOL_MINT, solUi);
  detailsByMint.set(SOL_MINT, {
    mint: SOL_MINT,
    decimals: 9,
    tokenProgram: "spl",
  });
  return { byMint, detailsByMint };
}

export async function getWalletBalanceSnapshot(conn, ownerPk) {
  const key = ownerPk.toBase58();
  const now = Date.now();
  if (
    walletUiByMintCache &&
    walletUiByMintCacheKey === key &&
    now - walletUiByMintCacheAt < WALLET_UI_BAL_CACHE_MS
  ) {
    return {
      byMint: walletUiByMintCache,
      detailsByMint: walletUiDetailsCache || new Map(),
    };
  }
  if (walletBalInFlight && walletBalInFlightKey === key) {
    return walletBalInFlight;
  }

  walletBalInFlightKey = key;
  walletBalInFlight = (async () => {
    try {
      let snapshot = null;
      try {
        snapshot = await fetchWalletBalancesViaJupiter(key);
      } catch {
        snapshot = null;
      }
      if (!snapshot?.byMint) {
        snapshot = await buildWalletBalancesSnapshot(conn, ownerPk);
      }
      if (getPublicKey()?.toBase58() === key) {
        cacheWalletSnapshot(key, snapshot.byMint, snapshot.detailsByMint);
      }
      return snapshot;
    } finally {
      walletBalInFlight = null;
      walletBalInFlightKey = "";
    }
  })();
  return walletBalInFlight;
}

export async function getWalletUiBalanceMap(conn, ownerPk) {
  const snapshot = await getWalletBalanceSnapshot(conn, ownerPk);
  return snapshot.byMint;
}

/**
 * ATA-focused read for one mint (fast); native SOL includes wrapped SOL in total.
 */
export async function fetchUiBalanceSingleMint(conn, ownerPk, mintStr) {
  const owner =
    ownerPk instanceof PublicKey ? ownerPk : new PublicKey(ownerPk);
  const owner58 = owner.toBase58();
  const cached = readWalletUiBalanceCache(owner58);
  if (cached && cached.has(mintStr)) {
    return cached.get(mintStr) ?? 0;
  }
  try {
    const snapshot = await getWalletBalanceSnapshot(conn, owner);
    if (snapshot?.byMint?.has(mintStr)) {
      return snapshot.byMint.get(mintStr) ?? 0;
    }
  } catch {
    /* fall through to direct RPC */
  }
  if (isSolMint(mintStr)) {
    const lamports = await conn.getBalance(owner, "confirmed");
    let wrapped = 0;
    const mintPk = new PublicKey(SOL_MINT);
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const ata = getAssociatedTokenAddressSync(
          mintPk,
          owner,
          false,
          programId
        );
        const { value } = await conn.getTokenAccountBalance(ata, "confirmed");
        wrapped += Number(value.uiAmount) || 0;
      } catch {
        /* no ATA */
      }
    }
    return lamports / LAMPORTS_PER_SOL + wrapped;
  }
  const mintPk = new PublicKey(mintStr);
  let total = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(
        mintPk,
        owner,
        false,
        programId
      );
      const { value } = await conn.getTokenAccountBalance(ata, "confirmed");
      total += Number(value.uiAmount) || 0;
    } catch {
      /* no ATA */
    }
  }
  return total;
}
