import { Buffer } from "buffer";

window.Buffer = Buffer;

import "./analytics.js";

import {
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  withRpcRetry,
  isRpcAccessError,
  invalidateRpcCache,
  waitForSignatureConfirmation,
} from "./lib/solana-rpc.js";
import {
  invalidateWalletBalSnapshot,
  getWalletBalanceSnapshot,
  getWalletUiBalanceMap,
  fetchUiBalanceSingleMint,
  readWalletUiBalanceCache,
} from "./lib/wallet-balances.js";
import {
  getPublicKey,
  getProvider,
  wireWalletConnectButton,
  trySilentReconnect,
  openWalletPicker,
  refreshWalletConnectButtonLabel,
} from "./lib/wallet-session.js";
import {
  fetchJupiterTokenList,
  defaultFromTo,
  getFallbackTokenList,
  isSolMint,
  isValidMintString,
  fetchTokenMetaByMint,
  searchJupiterTokensByQuery,
  resolveSplMintOnChain,
  SOL_MINT,
  USDC_MINT,
  PUMP_MINT,
  isToken2022FromJupiterMeta,
  tokenMapByMint,
} from "./lib/jupiter-tokens.js";
import { bindDecimalInput } from "./lib/input-decimal.js";
import {
  fetchDexscreenerSolanaMintProfile,
  fetchUsdPricesForMints,
  formatUsd,
  USD_PEG_MINTS,
} from "./lib/jupiter-price.js";
import { recordSiteSwap } from "./lib/site-activity.js";
import {
  fetchSwapQuote,
  buildSwapRequestBody,
} from "./lib/jupiter-swap.js";
import { searchDexscreenerSolanaTokens } from "./lib/dexscreener-search.js";
import {
  trustDisplayForToken,
  trustScoreColorClass,
} from "./lib/token-trust.js";
import { openPopup, closePopup } from "./lib/popup-motion.js";

const SLIPPAGE_BPS = 50;

/** If Jupiter search returns fewer than this, run a second DexScreener search (slower). */
const JUPITER_FEW_REMOTE_HITS = 8;
/** Max extra tokens to resolve from DexScreener when Jupiter is sparse. */
const DS_NEWCOMER_CAP = 20;

/** Leave native SOL unspent for fees + rent when using Max (From only). */
const SOL_MAX_RESERVE = 0.01;

const MODAL_DEFAULT_CAP = 200;
/** Pinned row order when search is empty before wallet-held tokens are appended. */
const MODAL_PINNED_MINTS = [
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  PUMP_MINT,
];
/** Cap wallet-held mints to resolve when opening the modal (each can trigger HTTP + RPC). */
const MODAL_HELD_META_CAP = 16;
const MODAL_METRICS_CAP = 55;
const MODAL_NAME_VIEW_CAP = 100;
const MODAL_BAL_PREFETCH = 36;
/** Max tokens to fetch balance+USD for when ranking the modal by wallet value. */
const MODAL_USD_PREFETCH_CAP = 48;
/** Parallel metadata resolves per batch for held mints (avoids 30+ simultaneous requests). */
const MODAL_HELD_RESOLVE_CONCURRENCY = 6;
/** DexScreener enrich after first paint — max mint profiles (was 48). */
const MODAL_DS_ENRICH_CAP = 12;
const MODAL_DS_ENRICH_BATCH = 12;

/** Major Solana tokens first so USD ranking includes them in the prefetch window. */
const USD_SORT_PRIORITY_MINTS = [
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
];

let baseTokenList = [];
/** Precomputed `{ t, hay }` for local modal search (avoids 10k+ string builds per keystroke). */
let tokenModalSearchIndex = [];
const extraTokensByMint = new Map();

function rebuildTokenModalSearchIndex() {
  tokenModalSearchIndex = baseTokenList.map((t) => ({
    t,
    hay: (t.symbol + " " + t.name + " " + t.mint).toLowerCase(),
  }));
}

function ensureBaseTokenSeed() {
  if (baseTokenList.length) return;
  baseTokenList = getFallbackTokenList();
  rebuildTokenModalSearchIndex();
}

let fromToken = null;
let toToken = null;
let pendingSide = "from";
let lastQuote = null;
/** `{ provider:'jupiter', swapUrl, kind }` from the last quote. */
let lastQuoteMeta = null;
let quoteAbort = null;

let modalSearchGen = 0;
let modalCandidateTokens = [];
const modalBalCache = new Map();
const modalPriceCache = new Map();

function allKnownTokensArray() {
  const m = new Map(baseTokenList.map((x) => [x.mint, x]));
  extraTokensByMint.forEach((v, k) => m.set(k, v));
  return [...m.values()];
}

function fastModalPreviewTokens(query) {
  ensureBaseTokenSeed();
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    const pk58 = getPublicKey()?.toBase58?.();
    const cachedHeld = pk58 ? readWalletUiBalanceCache(pk58) : null;
    return buildDefaultModalTokenList(baseTokenList, cachedHeld);
  }
  const rows =
    tokenModalSearchIndex.length === baseTokenList.length
      ? tokenModalSearchIndex
      : baseTokenList.map((t) => ({
          t,
          hay: (t.symbol + " " + t.name + " " + t.mint).toLowerCase(),
        }));
  if (q.length >= 2) {
    return rows
      .filter((row) => row.hay.includes(q))
      .map((row) => row.t)
      .slice(0, MODAL_NAME_VIEW_CAP);
  }
  return rows
    .filter((row) => {
      const t = row.t;
      return (
        String(t.symbol || "").charAt(0).toLowerCase() === q ||
        String(t.name || "").charAt(0).toLowerCase() === q
      );
    })
    .map((row) => row.t)
    .slice(0, MODAL_NAME_VIEW_CAP);
}

function fallbackHeldTokenMeta(mint, detailsByMint) {
  const details =
    detailsByMint instanceof Map ? detailsByMint.get(mint) : null;
  if (!details) return null;
  const token = {
    mint,
    symbol: mint.slice(0, 4) + "..." + mint.slice(-4),
    name: "Wallet token",
    decimals: Number(details.decimals) || 0,
    logoURI: "",
    isOnChainOnly: true,
  };
  if (details.tokenProgram) token.tokenProgram = details.tokenProgram;
  return token;
}

function buildDefaultModalTokenList(seedList, balanceMap, detailsByMint) {
  const listMap = tokenMapByMint(seedList);
  const out = [];
  const seen = new Set();

  function pushToken(t) {
    if (!t?.mint || seen.has(t.mint)) return;
    seen.add(t.mint);
    out.push(t);
  }

  for (const mint of MODAL_PINNED_MINTS) {
    pushToken(listMap.get(mint) || extraTokensByMint.get(mint));
  }

  if (!(balanceMap instanceof Map)) return out;

  const held = [...balanceMap.entries()]
    .filter(([mint, bal]) => mint && isFinite(bal) && bal > 0)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, MODAL_HELD_META_CAP);

  for (const [mint] of held) {
    pushToken(
      listMap.get(mint) ||
        extraTokensByMint.get(mint) ||
        fallbackHeldTokenMeta(mint, detailsByMint)
    );
  }

  return out;
}

function firstTokenOtherThan(mint) {
  return allKnownTokensArray().find((t) => t.mint !== mint) || baseTokenList[0];
}

function mergeExtraToken(t) {
  if (t?.mint) extraTokensByMint.set(t.mint, t);
}

function toAtomic(amountStr, decimals) {
  const n = parseFloat(String(amountStr).replace(/,/g, "").trim());
  if (!isFinite(n) || n <= 0) return null;
  const f = Math.pow(10, decimals);
  const v = BigInt(Math.floor(n * f + 1e-8));
  return v > 0n ? v : null;
}

function fromAtomic(raw, decimals) {
  const n = Number(raw) / Math.pow(10, decimals);
  if (!isFinite(n)) return "0";
  const d = Math.min(decimals, 8);
  return n.toFixed(d).replace(/\.?0+$/, "") || "0";
}

function formatAmountForInput(n, decimals) {
  if (!isFinite(n) || n <= 0) return "";
  const maxFrac = Math.min(decimals, 8);
  if (n >= 1) {
    const s = n
      .toFixed(Math.min(6, maxFrac))
      .replace(/\.?0+$/, "");
    return s || "0";
  }
  return n.toFixed(maxFrac).replace(/\.?0+$/, "") || "0";
}

let swapToastTimer = null;

function clearSwapToastTimer() {
  if (swapToastTimer) {
    clearTimeout(swapToastTimer);
    swapToastTimer = null;
  }
}

/**
 * Small bottom-right notice for swap flow (obvious but compact).
 * @param {"info"|"success"|"error"} variant
 */
function hideSwapToastNow() {
  clearSwapToastTimer();
  const host = document.getElementById("swap-toast-host");
  if (host) host.innerHTML = "";
}

function formatSigForUi(sig) {
  const s = typeof sig === "string" ? sig : String(sig ?? "");
  if (s.length <= 12) return s;
  return s.slice(0, 4) + "…" + s.slice(-4);
}

function showSwapToast(message, variant = "info", opts = {}) {
  const host = document.getElementById("swap-toast-host");
  if (!host) return;
  clearSwapToastTimer();
  host.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className =
    "pointer-events-auto border-4 border-black px-5 py-4 text-sm font-extrabold uppercase leading-snug tracking-tight shadow-[6px_6px_0_0_#000] " +
    (variant === "success"
      ? "bg-primary-container text-black"
      : variant === "error"
        ? "bg-error-container text-white"
        : "bg-white text-black");

  if (opts.linkHref && opts.linkLabel) {
    const p = document.createElement("p");
    p.textContent = message;
    const a = document.createElement("a");
    a.href = opts.linkHref;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className =
      "mt-2 block text-xs font-extrabold uppercase underline decoration-2 underline-offset-4";
    a.textContent = opts.linkLabel;
    wrap.appendChild(p);
    wrap.appendChild(a);
  } else {
    wrap.textContent = message;
  }

  host.appendChild(wrap);
  if (opts.noAutoDismiss) {
    swapToastTimer = null;
    return;
  }
  const ms = opts.durationMs ?? (variant === "success" ? 6000 : 4500);
  swapToastTimer = setTimeout(function () {
    host.innerHTML = "";
    swapToastTimer = null;
  }, ms);
}

function updateHalfMaxFromButtons() {
  const half = document.getElementById("swap-from-half");
  const max = document.getElementById("swap-from-max");
  const ok = Boolean(getPublicKey() && fromToken);
  if (half) half.disabled = !ok;
  if (max) max.disabled = !ok;
}

async function applyHalfMaxFrom(mode) {
  const amountIn = document.getElementById("swap-amount-in");
  if (!amountIn || !fromToken) return;
  const pk = getPublicKey();
  if (!pk) {
    showSwapToast("Connect wallet to use Half / Max", "error", {
      durationMs: 3500,
    });
    return;
  }
  try {
    const bal = await withRpcRetry(async (conn) => {
      const exact = await fetchUiBalanceSingleMint(conn, pk, fromToken.mint);
      if (exact != null && isFinite(exact) && exact > 0) return exact;
      const map = await getWalletUiBalanceMap(conn, pk);
      return map.get(fromToken.mint) ?? 0;
    });
    if (!isFinite(bal) || bal <= 0) {
      showSwapToast("No balance for " + fromToken.symbol, "error", {
        durationMs: 3500,
      });
      return;
    }
    let use = mode === "half" ? bal / 2 : bal;
    if (mode === "max" && isSolMint(fromToken.mint)) {
      use = Math.max(0, use - SOL_MAX_RESERVE);
    }
    if (!isFinite(use) || use <= 0) {
      showSwapToast("Amount too small after fee reserve", "error", {
        durationMs: 3500,
      });
      return;
    }
    amountIn.value = formatAmountForInput(use, fromToken.decimals);
    amountIn.dispatchEvent(new Event("input", { bubbles: true }));
    amountIn.dispatchEvent(new Event("change", { bubbles: true }));
    scheduleQuote();
  } catch (e) {
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    showSwapToast(
      (e && e.message) || "Could not read balance",
      "error",
      { durationMs: 4000 }
    );
  }
}

/** Runs on every tap — mobile hover `rotate` only fires once. */
function runSwapFlipIconAnimation() {
  const icon = document.querySelector("#swap-flip .swap-flip-icon");
  if (!icon || typeof icon.animate !== "function") return;
  icon.getAnimations?.().forEach((a) => a.cancel());
  icon.animate(
    [{ transform: "rotate(0deg)" }, { transform: "rotate(180deg)" }],
    { duration: 500, easing: "ease-in-out", fill: "none" }
  );
}

/** Drop stale async `refreshBalanceLabel` results after the user changes the From token. */
let swapBalanceHintGen = 0;

function syncSwapWalletUi() {
  const hdr = document.getElementById("wallet-connect");
  refreshWalletConnectButtonLabel(hdr);
  const pk = getPublicKey();
  if (!pk) invalidateWalletBalSnapshot();
  updateHalfMaxFromButtons();
  if (pk) {
    void withRpcRetry(async (conn) => {
      await getWalletUiBalanceMap(conn, pk);
    }).catch(() => {
      /* Errors are shown when refreshBalanceLabel runs */
    });
  }
  refreshBalanceLabel();
  if (pk) fetchQuote().then(updateSubmitState);
  else {
    lastQuote = null;
    lastQuoteMeta = null;
    updateSubmitState();
  }
}

function formatBalanceHintAmount(bal) {
  if (!Number.isFinite(bal)) return "—";
  return bal >= 1
    ? bal.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : bal.toFixed(8).replace(/\.?0+$/, "");
}

async function refreshBalanceLabel() {
  const gen = ++swapBalanceHintGen;
  const el = document.getElementById("swap-balance-hint");
  if (!el) return;
  const pk = getPublicKey();
  if (!pk || !fromToken) {
    el.textContent = "Connect wallet to see balance";
    return;
  }
  const mint = fromToken.mint;
  const sym = fromToken.symbol;
  const pk58 = pk.toBase58();
  const cacheMap = readWalletUiBalanceCache(pk58);
  const cacheHit = cacheMap != null;

  void withRpcRetry((conn) => getWalletUiBalanceMap(conn, pk)).catch(() => {});

  const balPromise = withRpcRetry((conn) =>
    fetchUiBalanceSingleMint(conn, pk, mint)
  );
  const pricePromise = fetchUsdPricesForMints([mint], {
    skipDexscreener: true,
  });

  if (cacheHit) {
    const qb = cacheMap.get(mint) ?? 0;
    el.textContent =
      "Available: " + formatBalanceHintAmount(qb) + " " + sym + " · …";
  } else {
    el.textContent = "Available: …";
  }

  let bal;
  try {
    bal = await balPromise;
  } catch (e) {
    if (gen !== swapBalanceHintGen) return;
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    el.textContent = "Available: —";
    return;
  }
  if (gen !== swapBalanceHintGen) return;
  const s = formatBalanceHintAmount(bal);
  el.textContent = "Available: " + s + " " + sym;

  let prices;
  try {
    prices = await pricePromise;
  } catch {
    if (gen !== swapBalanceHintGen) return;
    return;
  }
  if (gen !== swapBalanceHintGen) return;
  const p = prices.get(mint);
  const usd =
    p != null && isFinite(p) && isFinite(bal) ? formatUsd(bal * p) : null;
  el.textContent =
    "Available: " + s + " " + sym + (usd ? " · " + usd : "");
}

function renderTokenButtons() {
  const fromBtn = document.querySelector("[data-token-side='from']");
  const toBtn = document.querySelector("[data-token-side='to']");
  if (fromBtn) {
    const sym = fromBtn.querySelector(".token-symbol");
    if (sym) sym.textContent = fromToken?.symbol || "—";
  }
  if (toBtn) {
    const sym = toBtn.querySelector(".token-symbol");
    if (sym) sym.textContent = toToken?.symbol || "—";
  }
}

function updateSubmitState() {
  const submitBtn = document.getElementById("swap-submit");
  if (!submitBtn) return;
  if (!getPublicKey()) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Connect wallet";
    return;
  }
  submitBtn.textContent = "Swap";
  submitBtn.disabled = !lastQuote;
}

async function fetchQuote() {
  const amountIn = document.getElementById("swap-amount-in");
  const amountOut = document.getElementById("swap-amount-out");
  const statusEl = document.getElementById("swap-status");
  if (statusEl) statusEl.textContent = "";

  if (!fromToken || !toToken) {
    lastQuote = null;
    lastQuoteMeta = null;
    updateSubmitState();
    return;
  }

  if (quoteAbort) quoteAbort.abort();
  quoteAbort = new AbortController();

  const atomic = toAtomic(amountIn?.value || "", fromToken.decimals);
  if (!atomic || fromToken.mint === toToken.mint) {
    lastQuote = null;
    lastQuoteMeta = null;
    if (amountOut) amountOut.value = "";
    updateSubmitState();
    return;
  }

  if (
    fromToken.mint === USDC_MINT &&
    isToken2022FromJupiterMeta(toToken)
  ) {
    lastQuote = null;
    lastQuoteMeta = null;
    if (amountOut) amountOut.value = "";
    if (statusEl) {
      statusEl.textContent =
        "Swapping USDC into Token-2022 mints is not supported in this app. " +
        "Use SOL or a standard SPL token as the input, or choose a non–Token-2022 output.";
    }
    updateSubmitState();
    return;
  }

  const params = new URLSearchParams({
    inputMint: fromToken.mint,
    outputMint: toToken.mint,
    amount: atomic.toString(),
    slippageBps: String(SLIPPAGE_BPS),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
  });

  try {
    const { quote: q, swapUrl, kind } = await fetchSwapQuote(
      params.toString(),
      quoteAbort.signal
    );
    lastQuote = q;
    lastQuoteMeta = { provider: "jupiter", swapUrl, kind };
    const out = fromAtomic(q.outAmount, toToken.decimals);
    if (amountOut) amountOut.value = out;
    updateSubmitState();
  } catch (e) {
    if (e.name === "AbortError") return;
    lastQuote = null;
    lastQuoteMeta = null;
    if (amountOut) amountOut.value = "";
    if (statusEl)
      statusEl.textContent =
        friendlyQuoteErrorMessage(e.message) ||
        "Could not fetch quote. Try another pair or amount.";
    updateSubmitState();
  }
}

let quoteTimer = null;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(fetchQuote, 450);
}

function friendlyQuoteErrorMessage(raw) {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();
  if (low.includes("not tradable")) {
    return (
      "Jupiter has no swap route for this token (common for very new pump.fun coins, " +
      "frozen mints, or tokens with no routed liquidity). Try USDC, SOL, or a major pair."
    );
  }
  if (low.includes("no route") || low.includes("could not find")) {
    return "No liquidity route for this pair. Try a different token or amount.";
  }
  return s.length > 220 ? s.slice(0, 217) + "…" : s;
}

async function ensureWalletForAction() {
  if (getPublicKey() && getProvider()) return true;
  const silent = await trySilentReconnect(syncSwapWalletUi);
  if (silent) return true;
  showSwapToast("Choose a wallet to continue", "info", { durationMs: 3500 });
  openWalletPicker(syncSwapWalletUi);
  return false;
}

async function executeSwap() {
  const statusEl = document.getElementById("swap-status");
  const ok = await ensureWalletForAction();
  if (!ok || !getPublicKey() || !getProvider()) return;

  if (
    fromToken?.mint === USDC_MINT &&
    toToken &&
    isToken2022FromJupiterMeta(toToken)
  ) {
    showSwapToast(
      "USDC → Token-2022 swaps are not supported here. Use SOL or SPL as input.",
      "error",
      { durationMs: 6000 }
    );
    if (statusEl) statusEl.textContent = "USDC → Token-2022 not supported.";
    return;
  }

  if (!lastQuote) {
    showSwapToast("Enter an amount and wait for a quote", "info", {
      durationMs: 4000,
    });
    return;
  }
  if (statusEl) statusEl.textContent = "";
  showSwapToast("Preparing transaction…", "info", { noAutoDismiss: true });
  const submitBtn = document.getElementById("swap-submit");
  if (submitBtn) submitBtn.disabled = true;

  const pk = getPublicKey();
  const provider = getProvider();

  try {
    let sig;

    const swapHeaders = { "Content-Type": "application/json" };
    const jupKey = import.meta.env.VITE_JUPITER_API_KEY;
    if (jupKey) swapHeaders["x-api-key"] = jupKey;
    const swapUrl =
      lastQuoteMeta?.swapUrl || "https://quote-api.jup.ag/v6/swap";
    const kind = lastQuoteMeta?.kind || "v6";
    const body = buildSwapRequestBody(lastQuote, pk.toBase58(), kind);
    const res = await fetch(swapUrl, {
      method: "POST",
      headers: swapHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || "Swap request failed");
    }
    const { swapTransaction } = await res.json();
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
    );
    const signed = await provider.signTransaction(tx);
    showSwapToast("Sending transaction…", "info", { noAutoDismiss: true });

    sig = await withRpcRetry((conn) =>
      conn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      })
    );
    showSwapToast(
      "Confirming " + formatSigForUi(sig) + "…",
      "info",
      { noAutoDismiss: true }
    );
    await waitForSignatureConfirmation(sig);

    try {
      const inRaw = lastQuote.inAmount;
      const outRaw = lastQuote.outAmount;
      recordSiteSwap({
        wallet: pk.toBase58(),
        signature: sig,
        inputMint: fromToken.mint,
        outputMint: toToken.mint,
        inputAmountHuman:
          Number(inRaw) / Math.pow(10, fromToken.decimals),
        outputAmountHuman:
          Number(outRaw) / Math.pow(10, toToken.decimals),
        inputSymbol: fromToken.symbol,
        outputSymbol: toToken.symbol,
      });
    } catch (_) {
      /* non-fatal */
    }

    invalidateWalletBalSnapshot();
    hideSwapToastNow();
    showSwapToast("Swap confirmed", "success", {
      linkHref: "https://solscan.io/tx/" + sig,
      linkLabel: "View on Solscan",
      durationMs: 6500,
    });
    if (statusEl) statusEl.textContent = "";
    try {
      await refreshBalanceLabel();
      scheduleQuote();
    } catch (_) {
      /* non-fatal — do not revert success toast */
    }
  } catch (e) {
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    hideSwapToastNow();
    const msg =
      e.message?.slice(0, 120) || "Transaction failed or was rejected.";
    showSwapToast(msg, "error", { durationMs: 5500 });
    if (statusEl) statusEl.textContent = "";
  } finally {
    updateSubmitState();
  }
}

function flipTokens() {
  invalidateWalletBalSnapshot();
  const tmp = fromToken;
  fromToken = toToken;
  toToken = tmp;
  if (fromToken?.mint === toToken?.mint) {
    toToken = firstTokenOtherThan(fromToken.mint);
  }
  renderTokenButtons();
  updateHalfMaxFromButtons();
  refreshBalanceLabel();
  scheduleQuote();
}

const TRUSTED_MODAL_LOGO = {
  [SOL_MINT]:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd/logo.png",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/logo.png",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/logo.png",
};

function modalTokenLogoUri(t) {
  const meta = t.logoURI && String(t.logoURI).trim();
  if (meta) return meta;
  return TRUSTED_MODAL_LOGO[t.mint] || "";
}

function iconForToken(t) {
  const src = modalTokenLogoUri(t);
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.className = "h-9 w-9 rounded-full object-cover";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      const sp = document.createElement("span");
      sp.className = "material-symbols-outlined text-xl";
      sp.textContent = "monetization_on";
      img.replaceWith(sp);
    };
    return img;
  }
  const sp = document.createElement("span");
  sp.className = "material-symbols-outlined text-xl";
  sp.textContent = "monetization_on";
  return sp;
}

function prioritizeForUsdPrefetch(tokens, cap) {
  const capN = Math.min(Math.max(1, cap), Math.max(1, tokens.length));
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  const out = [];
  const used = new Set();
  for (const m of USD_SORT_PRIORITY_MINTS) {
    const t = byMint.get(m);
    if (t && !used.has(t.mint)) {
      out.push(t);
      used.add(t.mint);
    }
  }
  const rest = tokens
    .filter((t) => !used.has(t.mint))
    .sort((a, b) =>
      a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" })
    );
  for (const t of rest) {
    if (out.length >= capN) break;
    out.push(t);
  }
  return out;
}

/**
 * When the user is searching (non-empty query), higher trust scores sort first;
 * then wallet USD value, balance, or name depending on `mode`.
 */
function sortModalTokens(work, queryTrim, mode, balMap, priceMap) {
  const arr = [...work];
  const strict = strictMintSetFromBase();
  const hasQuery = Boolean(String(queryTrim || "").trim());

  arr.sort((a, b) => {
    if (hasQuery) {
      const sa = trustDisplayForToken(a, strict).score;
      const sb = trustDisplayForToken(b, strict).score;
      if (sb !== sa) return sb - sa;
    }
    if (mode === "name-desc") {
      return b.symbol.localeCompare(a.symbol, undefined, {
        sensitivity: "base",
      });
    }
    if (mode === "bal-desc") {
      return (balMap.get(b.mint) || 0) - (balMap.get(a.mint) || 0);
    }
    if (mode === "usd-desc") {
      const pb = priceMap.get(b.mint);
      const pa = priceMap.get(a.mint);
      const bb = balMap.get(b.mint);
      const ba = balMap.get(a.mint);
      const vb =
        (bb != null && isFinite(bb) ? bb : 0) *
        (pb != null && isFinite(pb) ? pb : 0);
      const va =
        (ba != null && isFinite(ba) ? ba : 0) *
        (pa != null && isFinite(pa) ? pa : 0);
      const nb = Number.isFinite(vb) ? vb : 0;
      const na = Number.isFinite(va) ? va : 0;
      if (nb !== na) return nb - na;
      const balB = bb != null && isFinite(bb) ? bb : 0;
      const balA = ba != null && isFinite(ba) ? ba : 0;
      if (balB !== balA) return balB - balA;
    }
    return a.symbol.localeCompare(b.symbol, undefined, {
      sensitivity: "base",
    });
  });
  return arr;
}

function strictMintSetFromBase() {
  return new Set(baseTokenList.map((t) => t.mint));
}

async function augmentMapWithDexscreener(q, map, myGen) {
  const ds = await searchDexscreenerSolanaTokens(q);
  if (myGen !== modalSearchGen) return;

  for (const row of ds) {
    if (map.has(row.mint)) {
      const cur = map.get(row.mint);
      const liq = row.dexscreenerLiquidityUsd || 0;
      if (liq > (cur.dexscreenerLiquidityUsd || 0)) {
        cur.dexscreenerLiquidityUsd = liq;
        cur.dexscreenerVolume24h = row.dexscreenerVolume24h;
      }
      if (!cur.logoURI && row.logoURI) cur.logoURI = row.logoURI;
    }
  }

  const newcomers = ds
    .filter((row) => !map.has(row.mint))
    .slice(0, DS_NEWCOMER_CAP);
  if (!newcomers.length) return;

  await withRpcRetry(async (conn) => {
    const chunk = 5;
    for (let i = 0; i < newcomers.length; i += chunk) {
      if (myGen !== modalSearchGen) return;
      const slice = newcomers.slice(i, i + chunk);
      await Promise.all(
        slice.map(async (dsRow) => {
          let meta = await fetchTokenMetaByMint(dsRow.mint);
          if (!meta) meta = await resolveSplMintOnChain(conn, dsRow.mint);
          if (!meta) return;
          map.set(meta.mint, {
            ...meta,
            logoURI: meta.logoURI || dsRow.logoURI || "",
            dexscreenerLiquidityUsd: dsRow.dexscreenerLiquidityUsd,
            dexscreenerVolume24h: dsRow.dexscreenerVolume24h,
          });
        })
      );
    }
  });
}

async function buildModalCandidateTokens(query, myGen) {
  if (!baseTokenList.length) {
    ensureBaseTokenSeed();
  } else if (
    tokenModalSearchIndex.length !== baseTokenList.length
  ) {
    rebuildTokenModalSearchIndex();
  }

  const q = query.trim();
  const ql = q.toLowerCase();

  if (!q) {
    void fetchJupiterTokenList()
      .then((liveList) => {
        if (myGen !== modalSearchGen) return;
        if (Array.isArray(liveList) && liveList.length) {
          baseTokenList = liveList;
          rebuildTokenModalSearchIndex();
        }
      })
      .catch(() => {});
    const pk = getPublicKey();
    if (!pk) return buildDefaultModalTokenList(baseTokenList);
    try {
      const snapshot = await withRpcRetry((conn) =>
        getWalletBalanceSnapshot(conn, pk)
      );
      if (myGen !== modalSearchGen) return [];

      const baseByMint = tokenMapByMint(baseTokenList);
      const heldMints = [...(snapshot?.byMint?.entries?.() || [])]
        .filter(([mint, bal]) => mint && isFinite(bal) && bal > 0)
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .map(([mint]) => mint)
        .slice(0, MODAL_HELD_META_CAP);

      const unresolved = heldMints.filter(
        (mint) => !baseByMint.has(mint) && !extraTokensByMint.has(mint)
      );

      if (unresolved.length) {
        await withRpcRetry(async (conn) => {
          for (
            let i = 0;
            i < unresolved.length;
            i += MODAL_HELD_RESOLVE_CONCURRENCY
          ) {
            if (myGen !== modalSearchGen) return;
            const chunk = unresolved.slice(i, i + MODAL_HELD_RESOLVE_CONCURRENCY);
            const resolved = await Promise.all(
              chunk.map(async (mint) => {
                let meta = await fetchTokenMetaByMint(mint).catch(() => null);
                if (!meta) meta = await resolveSplMintOnChain(conn, mint);
                return meta;
              })
            );
            for (const meta of resolved) {
              if (meta?.mint) mergeExtraToken(meta);
            }
          }
        });
      }

      if (myGen !== modalSearchGen) return [];
      return buildDefaultModalTokenList(
        allKnownTokensArray(),
        snapshot?.byMint,
        snapshot?.detailsByMint
      );
    } catch (e) {
      if (isRpcAccessError(e)) {
        invalidateRpcCache();
        invalidateWalletBalSnapshot();
      }
      const cachedHeld = readWalletUiBalanceCache(pk.toBase58());
      return buildDefaultModalTokenList(baseTokenList, cachedHeld);
    }
  }

  try {
    const liveList = await fetchJupiterTokenList();
    if (myGen !== modalSearchGen) return [];
    if (Array.isArray(liveList) && liveList.length) {
      baseTokenList = liveList;
      rebuildTokenModalSearchIndex();
    }
  } catch {
    /* keep seeded list; caller already rendered a fast preview */
  }

  const map = new Map();
  const localRows =
    tokenModalSearchIndex.length === baseTokenList.length
      ? tokenModalSearchIndex
      : baseTokenList.map((t) => ({
          t,
          hay: (t.symbol + " " + t.name + " " + t.mint).toLowerCase(),
        }));
  if (q.length >= 2) {
    for (const row of localRows) {
      if (row.hay.includes(ql)) map.set(row.t.mint, row.t);
    }
  } else if (q.length === 1) {
    for (const row of localRows) {
      const t = row.t;
      const sym = String(t.symbol || "").charAt(0).toLowerCase();
      const name = String(t.name || "").charAt(0).toLowerCase();
      if (sym === ql || name === ql) map.set(t.mint, t);
    }
  }

  const doRemoteSearch = q.length >= 1 && myGen === modalSearchGen;

  if (isValidMintString(q)) {
    const [meta, remote] = await Promise.all([
      fetchTokenMetaByMint(q),
      doRemoteSearch ? searchJupiterTokensByQuery(q) : Promise.resolve([]),
    ]);
    if (myGen !== modalSearchGen) return [...map.values()];
    let resolved = meta;
    if (!resolved) {
      resolved = await withRpcRetry((conn) =>
        resolveSplMintOnChain(conn, q)
      );
    }
    if (myGen !== modalSearchGen) return [...map.values()];
    if (resolved) map.set(resolved.mint, resolved);
    for (const t of remote) map.set(t.mint, t);
    if (
      doRemoteSearch &&
      q.length >= 2 &&
      remote.length < JUPITER_FEW_REMOTE_HITS
    ) {
      await augmentMapWithDexscreener(q, map, myGen);
    }
  } else if (doRemoteSearch) {
    const remote = await searchJupiterTokensByQuery(q);
    if (myGen !== modalSearchGen) return [...map.values()];
    for (const t of remote) map.set(t.mint, t);
    if (
      q.length >= 2 &&
      remote.length < JUPITER_FEW_REMOTE_HITS
    ) {
      await augmentMapWithDexscreener(q, map, myGen);
    }
  }

  return [...map.values()];
}

function modalTokenMetadataLooksUnknown(t) {
  const sym = (t.symbol || "").trim();
  const name = (t.name || "").trim();
  const prefix = t.mint.slice(0, 4);
  if (!t.logoURI || !String(t.logoURI).trim()) return true;
  if (!sym || sym === "?") return true;
  if (sym === prefix + "…" || sym === prefix + "...") return true;
  if (sym.startsWith(prefix) && /…|\.\.\./.test(sym)) return true;
  if (/^spl token$/i.test(name) || /^token-2022$/i.test(name)) return true;
  return false;
}

function modalHeldBalancePositive(t) {
  const b = modalBalCache.get(t.mint);
  return b != null && isFinite(b) && b > 0;
}

/** DexScreener profile for long-tail names/icons and missing USD for sorting. */
async function enrichModalTokensWithDexscreener(tokens, myGen) {
  const seen = new Set();
  const candidates = [];
  function pushCandidate(t) {
    if (!t || seen.has(t.mint)) return;
    if (USD_PEG_MINTS.has(t.mint) || isSolMint(t.mint)) return;
    seen.add(t.mint);
    candidates.push(t);
  }
  for (const t of tokens) {
    if (
      modalTokenMetadataLooksUnknown(t) ||
      modalHeldBalancePositive(t)
    ) {
      pushCandidate(t);
    }
  }
  for (const m of MODAL_PINNED_MINTS) {
    const t = tokens.find((x) => x.mint === m);
    pushCandidate(t);
  }
  const cap = MODAL_DS_ENRICH_CAP;
  const list = candidates.slice(0, cap);
  for (let i = 0; i < list.length; i += MODAL_DS_ENRICH_BATCH) {
    if (myGen !== modalSearchGen) return;
    const chunk = list.slice(i, i + MODAL_DS_ENRICH_BATCH);
    await Promise.all(
      chunk.map(async (t) => {
        const p = await fetchDexscreenerSolanaMintProfile(t.mint);
        if (myGen !== modalSearchGen) return;
        if (!p) return;
        if (p.symbol && String(p.symbol).trim()) {
          t.symbol = String(p.symbol).trim().slice(0, 14);
        }
        if (p.name && String(p.name).trim()) {
          t.name = String(p.name).trim().slice(0, 48);
        }
        if (p.logoURI && String(p.logoURI).trim()) {
          t.logoURI = String(p.logoURI).trim();
        }
        if (
          p.priceUsd != null &&
          isFinite(p.priceUsd) &&
          p.priceUsd > 0
        ) {
          const cur = modalPriceCache.get(t.mint);
          if (cur == null || !isFinite(cur) || cur <= 0) {
            modalPriceCache.set(t.mint, p.priceUsd);
          }
        }
      })
    );
  }
}

async function prefetchModalMetrics(work, balanceFetchCount, myGen) {
  const mints = work.map((t) => t.mint);
  const pk = getPublicKey();
  const balSlice = work.slice(0, Math.max(0, balanceFetchCount));

  /* Jupiter price API + CoinGecko SOL only — DexScreener per-mint here was N parallel HTTP calls and dominated open/search latency. */
  const pricesPromise = fetchUsdPricesForMints(mints, {
    skipDexscreener: true,
  });
  const balancesPromise =
    pk && balSlice.length
      ? withRpcRetry(async (conn) => {
          const map = await getWalletUiBalanceMap(conn, pk);
          if (myGen !== modalSearchGen) return;
          for (const t of balSlice) {
            modalBalCache.set(t.mint, map.get(t.mint) ?? 0);
          }
        })
      : Promise.resolve();

  const prices = await pricesPromise;
  if (myGen !== modalSearchGen) return;
  for (const m of mints) {
    const p = prices.get(m);
    modalPriceCache.set(m, p != null && isFinite(p) ? p : NaN);
  }

  if (!pk) {
    for (const t of work) modalBalCache.set(t.mint, 0);
    return;
  }

  await balancesPromise;
  if (myGen !== modalSearchGen) return;
  for (const t of work) {
    if (!modalBalCache.has(t.mint)) modalBalCache.set(t.mint, NaN);
  }
}

function applyCachedBalancesToDom(container, tokens) {
  for (const t of tokens) {
    const bal = modalBalCache.get(t.mint);
    const bel = container.querySelector(`[data-bal-for="${t.mint}"]`);
    if (bel != null) {
      if (bal != null && isFinite(bal) && getPublicKey()) {
        bel.textContent =
          bal >= 1
            ? bal.toLocaleString(undefined, { maximumFractionDigits: 4 })
            : bal.toFixed(6).replace(/\.?0+$/, "") || "0";
      } else {
        bel.textContent = "—";
      }
    }
    const usdEl = container.querySelector(`[data-usd-row-for="${t.mint}"]`);
    if (usdEl != null) {
      const p = modalPriceCache.get(t.mint);
      const b = modalBalCache.get(t.mint);
      const pk = getPublicKey();
      if (
        pk &&
        p != null &&
        isFinite(p) &&
        b != null &&
        isFinite(b) &&
        b > 0
      ) {
        usdEl.textContent = formatUsd(b * p);
      } else if (pk && b != null && isFinite(b) && b <= 0) {
        usdEl.textContent = "";
      } else if (!pk && p != null && isFinite(p)) {
        usdEl.textContent = "~" + formatUsd(p);
      } else {
        usdEl.textContent = "—";
      }
    }
  }
}

function pickToken(t, close) {
  mergeExtraToken(t);
  const prevFromMint = fromToken?.mint;
  if (pendingSide === "from") {
    fromToken = t;
    if (fromToken.mint === toToken.mint) {
      toToken = firstTokenOtherThan(fromToken.mint);
    }
  } else {
    toToken = t;
    if (toToken.mint === fromToken.mint) {
      fromToken = firstTokenOtherThan(toToken.mint);
    }
  }
  if (fromToken?.mint !== prevFromMint) invalidateWalletBalSnapshot();
  renderTokenButtons();
  close();
  updateHalfMaxFromButtons();
  refreshBalanceLabel();
  scheduleQuote();
}

function renderTokenRows(tokens, close, container) {
  container.innerHTML = "";
  const strict = strictMintSetFromBase();

  tokens.forEach((t, idx) => {
    const wrap = document.createElement("div");
    wrap.className =
      "flex border-b-2 border-black " +
      (idx % 2 ? "bg-surface-container-low" : "bg-surface-container-lowest");

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className =
      "group flex min-w-0 flex-1 items-center gap-3 p-3 text-left transition-colors hover:bg-primary-container dark:hover:text-black";
    selectBtn.dataset.tokenMint = t.mint;
    selectBtn.dataset.searchHay = (
      t.symbol +
      " " +
      t.name +
      " " +
      t.mint
    ).toLowerCase();

    const iconWrap = document.createElement("div");
    iconWrap.className =
      "flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-black bg-white";
    iconWrap.appendChild(iconForToken(t));

    const labels = document.createElement("div");
    labels.className = "min-w-0 flex-1";
    const trust = trustDisplayForToken(t, strict);
    const scoreCls = trustScoreColorClass(trust.score);

    const topRow = document.createElement("div");
    topRow.className =
      "flex flex-wrap items-center gap-x-2 gap-y-0.5 leading-tight";
    const symBold = document.createElement("span");
    symBold.className =
      "text-sm font-extrabold uppercase tracking-tight text-on-surface group-hover:text-black dark:group-hover:text-black";
    symBold.textContent = t.symbol;
    topRow.appendChild(symBold);

    if (trust.verified) {
      const badge = document.createElement("span");
      badge.className =
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-black bg-primary-container text-black dark:border-white";
      badge.title =
        "Listed as verified / strict on Jupiter (still DYOR — not a honeypot guarantee).";
      badge.innerHTML =
        '<span class="material-symbols-outlined text-[14px] leading-none">verified</span>';
      topRow.appendChild(badge);
    }

    const trustEl = document.createElement("span");
    trustEl.className =
      "inline-flex items-center gap-0.5 text-[11px] font-extrabold group-hover:!text-black dark:group-hover:!text-black " +
      scoreCls;
    trustEl.title =
      "Heuristic trust score from curated lists + liquidity (not a honeypot check).";
    const leaf = document.createElement("span");
    leaf.className = "material-symbols-outlined text-[15px] leading-none";
    leaf.textContent = "eco";
    trustEl.appendChild(leaf);
    const scoreSpan = document.createElement("span");
    scoreSpan.textContent = String(trust.score);
    trustEl.appendChild(scoreSpan);
    topRow.appendChild(trustEl);

    if (t.isOnChainOnly) {
      const mintTag = document.createElement("span");
      mintTag.className =
        "border border-black px-1 text-[9px] font-bold uppercase text-black group-hover:border-black group-hover:text-black dark:border-white dark:text-white dark:group-hover:border-black dark:group-hover:text-black";
      mintTag.textContent = "Mint";
      topRow.appendChild(mintTag);
    }

    const subRow = document.createElement("div");
    subRow.className =
      "mt-0.5 truncate text-[10px] font-bold uppercase tracking-tight text-on-surface-variant group-hover:text-black dark:group-hover:text-black";
    const mintShort =
      t.mint.length > 14
        ? t.mint.slice(0, 4) + "…" + t.mint.slice(-4)
        : t.mint;
    subRow.textContent = t.name + " · " + mintShort;

    labels.appendChild(topRow);
    labels.appendChild(subRow);

    const metrics = document.createElement("div");
    metrics.className =
      "flex w-[4.7rem] shrink-0 flex-col items-end justify-center text-right sm:w-[5.5rem]";
    const balSpan = document.createElement("span");
    balSpan.className = "text-[12px] font-extrabold leading-tight text-on-surface group-hover:text-black dark:group-hover:text-black sm:text-sm";
    balSpan.dataset.balFor = t.mint;
    balSpan.textContent = "—";
    const usdSpan = document.createElement("span");
    usdSpan.className = "text-[9px] font-bold leading-tight text-outline group-hover:text-black dark:group-hover:text-black";
    usdSpan.dataset.usdRowFor = t.mint;
    usdSpan.textContent = "";
    metrics.appendChild(balSpan);
    metrics.appendChild(usdSpan);

    selectBtn.appendChild(iconWrap);
    selectBtn.appendChild(labels);
    selectBtn.appendChild(metrics);

    selectBtn.addEventListener("click", () => pickToken(t, close));

    const actions = document.createElement("div");
    actions.className = "flex shrink-0 border-l-2 border-black";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className =
      "flex h-full w-10 items-center justify-center hover:bg-black hover:text-white";
    copyBtn.title = "Copy mint";
    copyBtn.innerHTML =
      '<span class="material-symbols-outlined text-lg">content_copy</span>';
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(t.mint).catch(() => {});
    });

    actions.appendChild(copyBtn);

    wrap.appendChild(selectBtn);
    wrap.appendChild(actions);
    container.appendChild(wrap);
  });
}

async function refreshModalListAfterEnrich(work, query, close, myGen) {
  const modal = document.getElementById("token-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (myGen !== modalSearchGen) return;
  const sortMode = getPublicKey() ? "usd-desc" : "name-asc";
  const sorted = sortModalTokens(
    work,
    query,
    sortMode,
    modalBalCache,
    modalPriceCache
  );
  const container = document.getElementById("token-modal-list");
  if (!container) return;
  renderTokenRows(sorted, close, container);
  applyCachedBalancesToDom(container, sorted);
}

async function updateModalTokenDisplay(query, modal, close) {
  const myGen = ++modalSearchGen;
  modalBalCache.clear();
  modalPriceCache.clear();

  const loadingEl = document.getElementById("token-modal-loading");
  const container = document.getElementById("token-modal-list");
  const previewTokens = fastModalPreviewTokens(query);
  if (container) {
    container.innerHTML = "";
    if (previewTokens.length) {
      renderTokenRows(previewTokens, close, container);
      applyCachedBalancesToDom(container, previewTokens);
    }
  }
  if (loadingEl) loadingEl.classList.toggle("hidden", previewTokens.length > 0);

  let work = [];

  try {
    const candidates = await buildModalCandidateTokens(query, myGen);
    if (myGen !== modalSearchGen) return;

    modalCandidateTokens = candidates;

    const sortMode = getPublicKey() ? "usd-desc" : "name-asc";

    work = [...candidates];
    const valueSort = sortMode === "bal-desc" || sortMode === "usd-desc";
    if (valueSort) {
      work = prioritizeForUsdPrefetch(work, MODAL_USD_PREFETCH_CAP);
    } else if (work.length > MODAL_NAME_VIEW_CAP) {
      work.sort((a, b) =>
        a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" })
      );
      work = work.slice(0, MODAL_NAME_VIEW_CAP);
    }

    if (!container) return;

    // First paint immediately so modal opens/searches without waiting on RPC + pricing.
    const fastSorted = [...work].sort((a, b) =>
      a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" })
    );
    renderTokenRows(fastSorted, close, container);
    applyCachedBalancesToDom(container, fastSorted);

    const balanceFetchCount = valueSort ? work.length : MODAL_BAL_PREFETCH;
    if (work.length) {
      try {
        await prefetchModalMetrics(work, balanceFetchCount, myGen);
      } catch (e) {
        if (isRpcAccessError(e)) {
          invalidateRpcCache();
          invalidateWalletBalSnapshot();
        }
        /* Keep visible rows and skip metric-driven resort on error. */
      }
      if (myGen !== modalSearchGen) return;
      const sorted = sortModalTokens(
        work,
        query,
        sortMode,
        modalBalCache,
        modalPriceCache
      );
      renderTokenRows(sorted, close, container);
      applyCachedBalancesToDom(container, sorted);
    }
  } finally {
    if (myGen === modalSearchGen && loadingEl) loadingEl.classList.add("hidden");
  }

  if (work.length && myGen === modalSearchGen) {
    void (async () => {
      try {
        await enrichModalTokensWithDexscreener(work, myGen);
      } catch {
        /* ignore */
      }
      await refreshModalListAfterEnrich(work, query, close, myGen);
    })();
  }
}

function initModal() {
  const modal = document.getElementById("token-modal");
  if (!modal) return;
  const openers = document.querySelectorAll("[data-open-token-modal]");
  const backdrop = modal.querySelector("[data-popup-backdrop]");
  const panel = modal.querySelector("[data-popup-panel]");
  const search = document.getElementById("token-modal-search");
  if (search) {
    search.placeholder = "Search by name or paste address";
  }

  let searchDebounce = null;

  function close() {
    clearTimeout(searchDebounce);
    searchDebounce = null;
    closePopup(modal, { panel, backdrop });
  }

  function open() {
    modalBalCache.clear();
    modalPriceCache.clear();
    modalCandidateTokens = [];
    ensureBaseTokenSeed();
    const listEl = document.getElementById("token-modal-list");
    if (listEl) listEl.innerHTML = "";

    openPopup(modal, { panel, backdrop });
    if (search) search.value = "";
    /** Single gen bump lives in `updateModalTokenDisplay` so we don’t invalidate that run immediately. */
    void updateModalTokenDisplay("", modal, close);
  }

  openers.forEach(function (el) {
    el.addEventListener("click", function () {
      pendingSide = el.getAttribute("data-token-side") || "from";
      open();
    });
  });

  modal.querySelectorAll("[data-token-modal-close]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      close();
    });
  });

  if (search) {
    search.addEventListener("input", function () {
      clearTimeout(searchDebounce);
      const v = search.value;
      searchDebounce = setTimeout(() => {
        void updateModalTokenDisplay(v, modal, close);
      }, 120);
    });
  }

  if (backdrop) backdrop.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}

async function init() {
  const loading = document.getElementById("token-modal-loading");
  if (loading) loading.classList.remove("hidden");

  ensureBaseTokenSeed();
  const d = defaultFromTo(baseTokenList);
  fromToken = d.from;
  toToken = d.to;

  if (loading) loading.classList.add("hidden");

  renderTokenButtons();
  updateHalfMaxFromButtons();

  const amountIn = document.getElementById("swap-amount-in");
  if (amountIn) {
    bindDecimalInput(amountIn, { maxDecimals: 18 });
    amountIn.addEventListener("input", scheduleQuote);
    amountIn.addEventListener("change", scheduleQuote);
  }

  document.getElementById("swap-from-half")?.addEventListener("click", () => {
    void applyHalfMaxFrom("half");
  });
  document.getElementById("swap-from-max")?.addEventListener("click", () => {
    void applyHalfMaxFrom("max");
  });

  document.getElementById("swap-flip")?.addEventListener("click", () => {
    runSwapFlipIconAnimation();
    flipTokens();
  });

  document.getElementById("swap-refresh-balance")?.addEventListener(
    "click",
    function () {
      void refreshBalanceLabel();
    }
  );

  await wireWalletConnectButton(syncSwapWalletUi);

  const submitBtn = document.getElementById("swap-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", async function () {
      if (!getPublicKey()) {
        const ok = await ensureWalletForAction();
        if (!ok || !getPublicKey()) return;
      }
      await executeSwap();
    });
  }

  initModal();

  void (async () => {
    try {
      const liveList = await fetchJupiterTokenList();
      if (!Array.isArray(liveList) || !liveList.length) return;
      baseTokenList = liveList;
      rebuildTokenModalSearchIndex();
      fromToken = baseTokenList.find((t) => t.mint === fromToken?.mint) || fromToken;
      toToken = baseTokenList.find((t) => t.mint === toToken?.mint) || toToken;
      renderTokenButtons();
    } catch {
      /* seeded fallback stays active */
    }
  })();

  syncSwapWalletUi();
}

init().catch((err) => {
  console.error("swap page init failed", err);
  const statusEl = document.getElementById("swap-status");
  if (statusEl) statusEl.textContent = "Could not initialize swap page.";
  updateSubmitState();
});
