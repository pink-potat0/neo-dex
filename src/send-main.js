import { Buffer } from "buffer";

window.Buffer = Buffer;

import {
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import {
  withRpcRetry,
  isRpcAccessError,
  invalidateRpcCache,
} from "./lib/solana-rpc.js";
import {
  invalidateWalletBalSnapshot,
  getWalletUiBalanceMap,
  fetchUiBalanceSingleMint,
  readWalletUiBalanceCache,
} from "./lib/wallet-balances.js";
import { fetchDexscreenerSolanaMintProfile } from "./lib/jupiter-price.js";
import {
  getPublicKey,
  getProvider,
  wireWalletConnectButton,
  refreshWalletConnectButtonLabel,
  trySilentReconnect,
  openWalletPicker,
} from "./lib/wallet-session.js";
import {
  fetchJupiterTokenList,
  isSolMint,
  tokenMapByMint,
  fetchTokenMetaByMint,
  SOL_MINT,
} from "./lib/jupiter-tokens.js";
import { bindDecimalInput } from "./lib/input-decimal.js";
import {
  parseUiAmountToAtomic,
  sendSplAmountBatchVariable,
  sendNativeSolBatchVariable,
} from "./lib/send-transfer.js";
import { recordSiteSend } from "./lib/site-activity.js";
import {
  openPopup,
  closePopup,
  openDropdown,
  closeDropdown,
} from "./lib/popup-motion.js";

const NATIVE_SOL_RESERVE_SOL = 0.01;
/** ~0.000005 SOL per signature; buffer for multi-send checks. */
const ESTIMATED_FEE_LAMPORTS_PER_TX = 5000n;
const MAX_RECIPIENTS = 5;
const PRIVACY_SIG_KEY_PREFIX = "neo-dex-privacy-sig-v1:";
const PRIVACY_BAL_KEY_PREFIX = "neo-dex-privacy-balance-v1:";
const PRIVACY_SIG_MESSAGE = "NEO DEX PrivacyCash session signature";
const PRIVACY_CIRCUIT_BASE = (() => {
  const override = String(import.meta.env.VITE_PRIVACY_CIRCUIT_BASE || "").trim();
  if (override) return override;
  // Use same-origin static circuit files in production so Vercel does not rely on
  // large cross-origin GitHub downloads during the privacy proof flow.
  return new URL("../assets/privacycash/transaction2", import.meta.url).href;
})();
const PRIVACY_ACTION_TIMEOUT_MS = 120000;
const PRIVACY_BALANCE_TIMEOUT_MS = 12000;

const TRUSTED_LOGO_BY_MINT = {
  [SOL_MINT]:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd/logo.png",
};

let jupiterByMint = new Map();
/** @type {Array<{ mint: string; balanceUi: number; decimals: number; symbol: string; name: string; logoURI: string }>} */
let walletHoldings = [];
/** @type {{ mint: string; symbol: string; name: string; decimals: number; logoURI?: string } | null} */
let selectedToken = null;

let sendBalanceHintGen = 0;
let holdingsRefreshGen = 0;
let toastTimer = null;
const SEND_HOLDINGS_SNAPSHOT_PREFIX = "neo-dex-send-holdings-v1:";
let privacySdkPromise = null;
let privacyLastKnownLamports = null;
let privacyAutoSignAttempted = false;
let privacyAutoSignWallet = "";

function sendSnapshotKey(walletBase58) {
  return SEND_HOLDINGS_SNAPSHOT_PREFIX + walletBase58;
}

function saveSendHoldingsSnapshot(walletBase58, rows) {
  if (!walletBase58 || !Array.isArray(rows)) return;
  try {
    sessionStorage.setItem(sendSnapshotKey(walletBase58), JSON.stringify(rows));
  } catch {
    /* ignore storage errors */
  }
}

function readSendHoldingsSnapshot(walletBase58) {
  if (!walletBase58) return null;
  try {
    const raw = sessionStorage.getItem(sendSnapshotKey(walletBase58));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function clearToastTimer() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function hideToast() {
  clearToastTimer();
  const host = document.getElementById("send-toast-host");
  if (host) host.innerHTML = "";
}

function showToast(message, variant = "info", opts = {}) {
  const host = document.getElementById("send-toast-host");
  if (!host) return;
  hideToast();
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
  if (opts.noAutoDismiss) return;
  const ms = opts.durationMs ?? 4500;
  toastTimer = setTimeout(() => {
    host.innerHTML = "";
    toastTimer = null;
  }, ms);
}

function formatAmountForInput(n, decimals) {
  if (!isFinite(n) || n <= 0) return "";
  const maxFrac = Math.min(decimals, 8);
  if (n >= 1) {
    const str = n
      .toFixed(Math.min(6, maxFrac))
      .replace(/\.?0+$/, "");
    return str || "0";
  }
  return n.toFixed(maxFrac).replace(/\.?0+$/, "") || "0";
}

function formatBalanceHintAmount(bal) {
  if (!Number.isFinite(bal)) return "—";
  return bal >= 1
    ? bal.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : bal.toFixed(8).replace(/\.?0+$/, "");
}

async function batchDexscreenerProfiles(mints) {
  const out = new Map();
  const batch = 8;
  for (let i = 0; i < mints.length; i += batch) {
    const slice = mints.slice(i, i + batch);
    const results = await Promise.all(
      slice.map((m) => fetchDexscreenerSolanaMintProfile(m).catch(() => null))
    );
    slice.forEach((m, j) => {
      if (results[j]) out.set(m, results[j]);
    });
  }
  return out;
}

function mergeLogoUri(mint, dsLogo, jupLogo) {
  const t = (s) => (typeof s === "string" && s.trim() ? s.trim() : "");
  const trusted = TRUSTED_LOGO_BY_MINT[mint];
  if (trusted) return trusted;
  if (t(dsLogo)) return t(dsLogo);
  if (t(jupLogo)) return t(jupLogo);
  return "";
}

function setBalancesHint(el, text) {
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function setSendStatus(message, isError = false) {
  const el = document.getElementById("send-status");
  if (!el) return;
  el.textContent = String(message || "");
  el.className =
    "min-h-[1.25rem] text-center text-[10px] font-bold uppercase " +
    (isError ? "text-error" : "text-on-surface-variant");
}

function normalizePrivacyError(err, actionLabel) {
  const raw = String(err?.message || err || "");
  if (/wallet.*sendtransaction|user rejected|rejected/i.test(raw)) {
    return "Wallet request was rejected.";
  }
  if (/wallet not connected/i.test(raw)) {
    return "Connect wallet first";
  }
  if (/timed out/i.test(raw)) {
    return (
      actionLabel +
      " timed out. Privacy relayer may be slow right now; retry in a moment."
    );
  }
  return raw || actionLabel + " failed";
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label + " timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function privacySigStorageKey(ownerBase58) {
  return PRIVACY_SIG_KEY_PREFIX + ownerBase58;
}

function privacyBalStorageKey(ownerBase58) {
  return PRIVACY_BAL_KEY_PREFIX + ownerBase58;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function getCachedPrivacySignature(owner) {
  const key = privacySigStorageKey(owner.toBase58());
  try {
    const cached = localStorage.getItem(key);
    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H1',location:'send-main.js:getCachedPrivacySignature',message:'privacy signature cache read',data:{wallet:owner.toBase58(),hasCached:!!cached,cachedLen:cached?cached.length:0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (cached) return base64ToBytes(cached);
  } catch {
    /* ignore */
  }
  return null;
}

function readCachedPrivacyBalanceLamports(owner) {
  try {
    const raw = localStorage.getItem(privacyBalStorageKey(owner.toBase58()));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeCachedPrivacyBalanceLamports(owner, lamports) {
  try {
    localStorage.setItem(privacyBalStorageKey(owner.toBase58()), String(lamports));
  } catch {
    /* ignore */
  }
}

function hasPrivacySessionSignature(owner = getPublicKey()) {
  return Boolean(owner && getCachedPrivacySignature(owner));
}

function syncPrivacySessionUi() {
  const topupLabel = document.getElementById("privacy-topup-label");
  const topupBtn = document.querySelector("[data-privacy-topup]");
  const hasSession = hasPrivacySessionSignature();
  if (topupLabel) topupLabel.textContent = hasSession ? "Top up" : "Enable";
  if (topupBtn) {
    topupBtn.setAttribute(
      "title",
      hasSession
        ? "Top up your private balance"
        : "Enable Privacy Cash by signing a one-time session message"
    );
  }
}

async function getPrivacySignedSignature(owner, provider) {
  const cachedSig = getCachedPrivacySignature(owner);
  if (cachedSig) return cachedSig;
  const key = privacySigStorageKey(owner.toBase58());
  if (typeof provider.signMessage !== "function") {
    throw new Error("Connected wallet does not support signMessage");
  }
  const msg = new TextEncoder().encode(PRIVACY_SIG_MESSAGE);
  const sig = await provider.signMessage(msg, "utf8");
  const sigBytes =
    sig instanceof Uint8Array
      ? sig
      : sig?.signature instanceof Uint8Array
        ? sig.signature
        : new Uint8Array(sig);
  if (!sigBytes?.length) {
    throw new Error("Wallet returned an empty signature");
  }
  // #region agent log
  fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H1',location:'send-main.js:getPrivacySignedSignature',message:'privacy signature obtained from wallet',data:{wallet:owner.toBase58(),sigByteLen:sigBytes.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    localStorage.setItem(key, bytesToBase64(sigBytes));
    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H1',location:'send-main.js:getPrivacySignedSignature',message:'privacy signature cached',data:{wallet:owner.toBase58(),storageKey:key},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch {
    /* ignore */
  }
  return sigBytes;
}

async function ensurePrivacySessionSignature({
  showIntroToast = true,
  successToast = "Privacy Cash enabled",
} = {}) {
  const owner = getPublicKey();
  const provider = getProvider();
  if (!owner || !provider) throw new Error("Connect wallet first");
  if (hasPrivacySessionSignature(owner)) {
    syncPrivacySessionUi();
    return true;
  }
  if (showIntroToast) {
    showToast("Enable Privacy Cash: confirm the one-time message signature", "info", {
      durationMs: 5000,
    });
  }
  await getPrivacySignedSignature(owner, provider);
  syncPrivacySessionUi();
  showToast(successToast, "success", { durationMs: 3000 });
  void refreshPrivacyPoolBalance({ timeoutMs: 45000 });
  return true;
}

async function loadPrivacySdk() {
  if (!privacySdkPromise) {
    privacySdkPromise = import("privacycash/utils");
  }
  return privacySdkPromise;
}

function getPrivacyStorage() {
  return {
    getItem(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    removeItem(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

async function buildPrivacyContext() {
  return buildPrivacyContextWithOptions({ allowPromptSignature: true });
}

async function buildPrivacyContextWithOptions({
  allowPromptSignature = true,
} = {}) {
  const owner = getPublicKey();
  const provider = getProvider();
  if (!owner || !provider) throw new Error("Connect wallet first");
  const sdk = await loadPrivacySdk();
  const lightWasm = await WasmFactory.getInstance();
  const encryptionService = new sdk.EncryptionService();
  const sig = allowPromptSignature
    ? await getPrivacySignedSignature(owner, provider)
    : getCachedPrivacySignature(owner);
  if (!sig) {
    throw new Error("Sign message once to enable Privacy Cash");
  }
  encryptionService.deriveEncryptionKeyFromSignature(sig);
  const connection = await withRpcRetry(async (conn) => {
    await conn.getLatestBlockhash("confirmed");
    return conn;
  });
  const storage = getPrivacyStorage();
  return {
    sdk,
    owner,
    lightWasm,
    encryptionService,
    connection,
    storage,
    keyBasePath: PRIVACY_CIRCUIT_BASE,
    transactionSigner: async (tx) => provider.signTransaction(tx),
  };
}

function setPrivacyBalanceDisplay(text) {
  const el = document.getElementById("privacy-balance-display");
  if (el) el.textContent = text;
}

function setPrivacyBalanceLamports(lamports) {
  const safe = Number.isFinite(lamports) ? Math.max(0, lamports) : 0;
  privacyLastKnownLamports = safe;
  const owner = getPublicKey();
  if (owner) writeCachedPrivacyBalanceLamports(owner, safe);
  setPrivacyBalanceDisplay((safe / LAMPORTS_PER_SOL).toFixed(9));
}

async function refreshPrivacyPoolBalance({
  allowPromptSignature = false,
  timeoutMs = PRIVACY_BALANCE_TIMEOUT_MS,
} = {}) {
  const owner = getPublicKey();
  // #region agent log
  fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H2',location:'send-main.js:refreshPrivacyPoolBalance',message:'refresh privacy balance start',data:{hasOwner:!!owner,allowPromptSignature,timeoutMs,lastKnownLamports:privacyLastKnownLamports},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!owner) {
    if (privacyLastKnownLamports == null) setPrivacyBalanceDisplay("0.000000000");
    return null;
  }
  if (privacyLastKnownLamports == null) {
    const cachedLamports = readCachedPrivacyBalanceLamports(owner);
    if (Number.isFinite(cachedLamports)) {
      privacyLastKnownLamports = cachedLamports;
      setPrivacyBalanceDisplay((cachedLamports / LAMPORTS_PER_SOL).toFixed(9));
    }
  }
  if (!getCachedPrivacySignature(owner)) {
    if (privacyLastKnownLamports == null) {
      setPrivacyBalanceDisplay("Sign to load");
    }
    syncPrivacySessionUi();
    return null;
  }
  syncPrivacySessionUi();
  if (privacyLastKnownLamports == null) {
    setPrivacyBalanceDisplay("...");
  }
  try {
    const isInitialFullScan = privacyLastKnownLamports == null;
    const ctx = await buildPrivacyContextWithOptions({
      allowPromptSignature,
    });
    const abort = new AbortController();
    const effectiveTimeoutMs = isInitialFullScan ? Math.max(timeoutMs, 45000) : timeoutMs;
    const cancel = setTimeout(() => abort.abort(), effectiveTimeoutMs);
    const utxos = await ctx.sdk.getUtxos({
      publicKey: ctx.owner,
      connection: ctx.connection,
      encryptionService: ctx.encryptionService,
      storage: ctx.storage,
      abortSignal: abort.signal,
      offset: isInitialFullScan ? 0 : undefined,
    });
    clearTimeout(cancel);
    const bal = ctx.sdk.getBalanceFromUtxos(utxos);
    const lamports = Number(bal?.lamports || 0);
    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H2',location:'send-main.js:refreshPrivacyPoolBalance',message:'refresh privacy balance success',data:{wallet:owner.toBase58(),isInitialFullScan,utxoCount:Array.isArray(utxos)?utxos.length:-1,lamports},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    setPrivacyBalanceLamports(lamports);
    return lamports;
  } catch {
    // #region agent log
    fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H2',location:'send-main.js:refreshPrivacyPoolBalance',message:'refresh privacy balance failed',data:{wallet:owner?owner.toBase58():'',hadLastKnown:Number.isFinite(privacyLastKnownLamports)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (privacyLastKnownLamports == null) {
      setPrivacyBalanceDisplay("0.000000000");
    }
    return null;
  }
}

async function fetchNativeWalletBalanceSol() {
  const owner = getPublicKey();
  if (!owner) return NaN;
  const lamports = await withRpcRetry((conn) => conn.getBalance(owner, "confirmed"));
  return lamports / LAMPORTS_PER_SOL;
}

async function autoSignPrivacyOnLoad() {
  const owner = getPublicKey();
  const provider = getProvider();
  if (!owner || !provider) {
    syncPrivacySessionUi();
    return;
  }
  const owner58 = owner.toBase58();
  if (privacyAutoSignWallet !== owner58) {
    privacyAutoSignWallet = owner58;
    privacyAutoSignAttempted = false;
  }
  if (privacyAutoSignAttempted) return;
  privacyAutoSignAttempted = true;
  if (getCachedPrivacySignature(owner)) {
    void refreshPrivacyPoolBalance({ timeoutMs: 45000 });
    return;
  }
  try {
    await ensurePrivacySessionSignature({
      showIntroToast: true,
      successToast: "Privacy Cash enabled",
    });
  } catch {
    syncPrivacySessionUi();
    // User may reject or the wallet may require a user gesture; keep passive state.
  }
}

async function pollPrivacyBalanceAfterDeposit(addedLamports) {
  const delays = [2500, 5000, 9000, 14000];
  for (const ms of delays) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const fresh = await refreshPrivacyPoolBalance({ timeoutMs: 20000 });
    if (typeof fresh === "number" && fresh >= addedLamports) return;
  }
}

function closeTokenDropdown() {
  const d = document.getElementById("send-token-dropdown");
  const t = document.getElementById("send-token-trigger");
  closeDropdown(d, { trigger: t });
}

function openTokenDropdown() {
  const d = document.getElementById("send-token-dropdown");
  const t = document.getElementById("send-token-trigger");
  openDropdown(d, { trigger: t });
}

function toggleTokenDropdown() {
  const d = document.getElementById("send-token-dropdown");
  if (!d) return;
  if (d.classList.contains("hidden") || d.classList.contains("neo-dropdown-closing")) {
    openTokenDropdown();
  }
  else closeTokenDropdown();
}

function setAssetBalanceHeader(text) {
  const v = document.getElementById("send-asset-balance-value");
  if (v) v.textContent = text;
}

/** @param {Map<string, any>} dsMap DexScreener profile per mint (may be empty). */
function buildWalletHoldingsFromEntries(entries, dsMap) {
  return entries.map(([mint, balanceUi]) => {
    if (mint === SOL_MINT) {
      return {
        mint,
        balanceUi,
        decimals: 9,
        symbol: "SOL",
        name: "Solana",
        logoURI: TRUSTED_LOGO_BY_MINT[SOL_MINT],
      };
    }
    const ds = dsMap.get(mint);
    const jup = jupiterByMint.get(mint);
    const decimals = Number(jup?.decimals);
    const dec = Number.isFinite(decimals) ? decimals : 9;
    const sym =
      (ds?.symbol && String(ds.symbol).trim()) ||
      (jup?.symbol && String(jup.symbol).trim()) ||
      mint.slice(0, 4) + "…";
    const name =
      (ds?.name && String(ds.name).trim()) ||
      (jup?.name && String(jup.name).trim()) ||
      sym;
    const logoURI = mergeLogoUri(mint, ds?.logoURI, jup?.logoURI);
    return { mint, balanceUi, decimals: dec, symbol: sym.slice(0, 14), name, logoURI };
  });
}

async function refreshWalletHoldings() {
  const gen = ++holdingsRefreshGen;
  const listEl = document.getElementById("send-token-dropdown-list");
  const hintEl = document.getElementById("send-wallet-balances-hint");

  const pk = getPublicKey();
  if (!pk) {
    walletHoldings = [];
    if (listEl) listEl.innerHTML = "";
    setBalancesHint(hintEl, "Connect wallet to see balances.");
    reconcileSelectedToken();
    return;
  }

  const pk58 = pk.toBase58();
  const cachedRows = readSendHoldingsSnapshot(pk58);
  if (cachedRows && cachedRows.length) {
    walletHoldings = cachedRows;
    if (listEl) renderWalletBalancesList(listEl);
    reconcileSelectedToken();
    setBalancesHint(hintEl, "Showing cached balances…");
  }

  if (!cachedRows?.length) {
    if (listEl) listEl.innerHTML = "";
    setBalancesHint(hintEl, "Loading balances…");
  } else {
    setBalancesHint(hintEl, "Refreshing balances…");
  }

  let balMap;
  try {
    balMap = await withRpcRetry((conn) => getWalletUiBalanceMap(conn, pk));
  } catch (e) {
    if (gen !== holdingsRefreshGen) return;
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    const hadCached = cachedRows && cachedRows.length;
    if (!hadCached) {
      walletHoldings = [];
      if (listEl) listEl.innerHTML = "";
      setBalancesHint(hintEl, "Could not load balances.");
      reconcileSelectedToken();
    } else {
      walletHoldings = cachedRows;
      if (listEl) renderWalletBalancesList(listEl);
      setBalancesHint(hintEl, "Showing cached balances.");
      reconcileSelectedToken();
    }
    return;
  }

  if (gen !== holdingsRefreshGen) return;

  const entries = [...balMap.entries()].filter(([, ui]) => ui > 0 && isFinite(ui));
  entries.sort((a, b) => {
    if (a[0] === SOL_MINT) return -1;
    if (b[0] === SOL_MINT) return 1;
    return b[1] - a[1];
  });

  if (!entries.length) {
    walletHoldings = [];
    setBalancesHint(hintEl, "No balances in this wallet.");
    if (listEl) renderWalletBalancesList(listEl);
    reconcileSelectedToken();
    return;
  }

  const mints = entries.map(([m]) => m);
  const emptyDs = new Map();
  walletHoldings = buildWalletHoldingsFromEntries(entries, emptyDs);
  if (listEl) renderWalletBalancesList(listEl);
  saveSendHoldingsSnapshot(pk58, walletHoldings);
  reconcileSelectedToken();
  void refreshSendAvailable();

  const needJup = mints.filter(
    (m) => m !== SOL_MINT && jupiterByMint.get(m)?.decimals == null
  );
  const jupStep = 6;
  for (let i = 0; i < needJup.length; i += jupStep) {
    if (gen !== holdingsRefreshGen) return;
    const slice = needJup.slice(i, i + jupStep);
    await Promise.all(
      slice.map(async (m) => {
        if (jupiterByMint.has(m)) return;
        const meta = await fetchTokenMetaByMint(m).catch(() => null);
        if (meta?.mint) jupiterByMint.set(m, meta);
      })
    );
  }
  if (gen !== holdingsRefreshGen) return;

  walletHoldings = buildWalletHoldingsFromEntries(entries, emptyDs);
  if (listEl) renderWalletBalancesList(listEl);
  saveSendHoldingsSnapshot(pk58, walletHoldings);
  reconcileSelectedToken();
  void refreshSendAvailable();

  void (async () => {
    let dsMap = new Map();
    try {
      dsMap = await batchDexscreenerProfiles(mints);
    } catch {
      dsMap = new Map();
    }
    if (gen !== holdingsRefreshGen) return;
    walletHoldings = buildWalletHoldingsFromEntries(entries, dsMap);
    const drop = document.getElementById("send-token-dropdown-list");
    if (drop) renderWalletBalancesList(drop);
    saveSendHoldingsSnapshot(pk58, walletHoldings);
    reconcileSelectedToken();
    void refreshSendAvailable();
  })();
}

function holdingToToken(h) {
  return {
    mint: h.mint,
    symbol: h.symbol,
    name: h.name,
    decimals: h.decimals,
    logoURI: h.logoURI,
  };
}

function reconcileSelectedToken() {
  const pk = getPublicKey();
  if (!pk) {
    selectedToken = {
      mint: SOL_MINT,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      logoURI: TRUSTED_LOGO_BY_MINT[SOL_MINT],
    };
    renderTokenSymbol();
    return;
  }
  if (
    selectedToken &&
    walletHoldings.some((h) => h.mint === selectedToken.mint)
  ) {
    const h = walletHoldings.find((x) => x.mint === selectedToken.mint);
    if (h) selectedToken = holdingToToken(h);
    renderTokenSymbol();
    return;
  }
  const first = walletHoldings[0];
  selectedToken = first
    ? holdingToToken(first)
    : {
        mint: SOL_MINT,
        symbol: "SOL",
        name: "Solana",
        decimals: 9,
        logoURI: TRUSTED_LOGO_BY_MINT[SOL_MINT],
      };
  renderTokenSymbol();
}

function renderWalletBalancesList(container) {
  if (!container) return;
  container.innerHTML = "";
  const selMint = selectedToken?.mint;
  for (const h of walletHoldings) {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/10 " +
      (h.mint === selMint ? "bg-black/10 dark:bg-white/15" : "");
    row.setAttribute("role", "listitem");

    const imgWrap = document.createElement("div");
    imgWrap.className =
      "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-black/20 bg-white text-[10px] font-bold uppercase dark:border-white/30";
    if (h.logoURI) {
      const img = document.createElement("img");
      img.src = h.logoURI;
      img.alt = "";
      img.className = "h-full w-full object-cover";
      img.referrerPolicy = "no-referrer";
      img.onerror = function () {
        img.remove();
        imgWrap.textContent = (h.symbol || "?").slice(0, 2);
      };
      imgWrap.appendChild(img);
    } else {
      imgWrap.textContent = (h.symbol || "?").slice(0, 2);
    }

    const mid = document.createElement("div");
    mid.className = "min-w-0 flex-1";
    const title = document.createElement("p");
    title.className = "truncate font-semibold text-on-surface";
    title.textContent = h.symbol;
    const sub = document.createElement("p");
    sub.className = "truncate text-xs text-outline";
    sub.textContent = h.name;
    mid.appendChild(title);
    mid.appendChild(sub);

    const bal = document.createElement("div");
    bal.className = "shrink-0 tabular-nums font-medium text-on-surface";
    bal.textContent = formatBalanceHintAmount(h.balanceUi);

    row.appendChild(imgWrap);
    row.appendChild(mid);
    row.appendChild(bal);

    row.addEventListener("click", () => {
      invalidateWalletBalSnapshot();
      selectedToken = holdingToToken(h);
      renderTokenSymbol();
      closeTokenDropdown();
      void refreshSendAvailable();
      const dropList = document.getElementById("send-token-dropdown-list");
      if (dropList) renderWalletBalancesList(dropList);
    });

    container.appendChild(row);
  }
}

function syncSendPageUi() {
  const hdr = document.getElementById("wallet-connect");
  refreshWalletConnectButtonLabel(hdr);
  const pk = getPublicKey();
  if (!pk) invalidateWalletBalSnapshot();
  else {
    void withRpcRetry(async (conn) => {
      await getWalletUiBalanceMap(conn, pk);
    }).catch(() => {});
  }
  updateSendSubmitState();
  syncPrivacySessionUi();
  void refreshWalletHoldings();
  void refreshSendAvailable();
  void refreshPrivacyPoolBalance();
}

function updateSendSubmitState() {
  const submit = document.getElementById("send-submit");
  if (!submit) return;
  if (!getPublicKey()) {
    submit.disabled = false;
    submit.textContent = "Connect wallet";
    return;
  }
  submit.textContent = "Send";
  submit.disabled = false;
}

async function ensureWalletForAction() {
  if (getPublicKey() && getProvider()) return true;
  const silent = await trySilentReconnect(syncSendPageUi);
  if (silent) return true;
  showToast("Choose a wallet to continue", "info", { durationMs: 3500 });
  openWalletPicker(syncSendPageUi);
  return false;
}

async function refreshSendAvailable() {
  const gen = ++sendBalanceHintGen;
  const el = document.getElementById("send-available");
  if (!el) return;
  const pk = getPublicKey();
  if (!pk) {
    setAssetBalanceHeader("—");
    el.textContent = "Connect wallet to see balance";
    return;
  }
  if (!selectedToken) {
    setAssetBalanceHeader("…");
    el.textContent = "Loading…";
    return;
  }

  const mint = selectedToken.mint;
  const sym = selectedToken.symbol || "?";
  const pk58 = pk.toBase58();
  const cacheMap = readWalletUiBalanceCache(pk58);
  const cacheHit = cacheMap != null;

  void withRpcRetry((conn) => getWalletUiBalanceMap(conn, pk)).catch(() => {});

  if (isSolMint(mint)) {
    const balPromise = withRpcRetry(async (conn) => {
      const lamports = await conn.getBalance(pk, "confirmed");
      return lamports / LAMPORTS_PER_SOL;
    });
    if (cacheHit) {
      const qb = cacheMap.get(mint) ?? 0;
      setAssetBalanceHeader("…");
      el.textContent =
        "Total (incl. wrapped) " +
        formatBalanceHintAmount(qb) +
        " " +
        sym +
        " · …";
    } else {
      setAssetBalanceHeader("…");
      el.textContent = "Loading balance…";
    }
    try {
      const nativeSol = await balPromise;
      if (gen !== sendBalanceHintGen) return;
      const spendable = Math.max(0, nativeSol - NATIVE_SOL_RESERVE_SOL);
      setAssetBalanceHeader(formatBalanceHintAmount(spendable));
      el.textContent =
        "Spendable (native) " +
        formatAmountForInput(spendable, 9) +
        " " +
        sym;
    } catch (e) {
      if (gen !== sendBalanceHintGen) return;
      if (isRpcAccessError(e)) {
        invalidateRpcCache();
        invalidateWalletBalSnapshot();
      }
      setAssetBalanceHeader("—");
      el.textContent = "Could not load balance";
    }
    return;
  }

  const balPromise = withRpcRetry((conn) =>
    fetchUiBalanceSingleMint(conn, pk, mint)
  );
  if (cacheHit) {
    const qb = cacheMap.get(mint) ?? 0;
    setAssetBalanceHeader(formatBalanceHintAmount(qb));
    el.textContent =
      "Available " + formatBalanceHintAmount(qb) + " " + sym + " · …";
  } else {
    setAssetBalanceHeader("…");
    el.textContent = "Available …";
  }
  try {
    const total = await balPromise;
    if (gen !== sendBalanceHintGen) return;
    setAssetBalanceHeader(formatBalanceHintAmount(total));
    el.textContent =
      "Available " +
      formatAmountForInput(total, selectedToken.decimals) +
      " " +
      sym;
  } catch (e) {
    if (gen !== sendBalanceHintGen) return;
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    setAssetBalanceHeader("—");
    el.textContent = "Could not load balance";
  }
}

function renderTokenSymbol() {
  const sym = document.querySelector("#send-token-trigger .send-token-symbol");
  if (sym) sym.textContent = selectedToken?.symbol || "—";
  const media = document.getElementById("send-token-pill-media");
  if (!media) return;
  media.innerHTML = "";
  const uri = selectedToken?.logoURI;
  const label = (selectedToken?.symbol || "?").slice(0, 4);
  if (uri) {
    const img = document.createElement("img");
    img.src = uri;
    img.alt = "";
    img.className = "h-full w-full object-cover";
    img.referrerPolicy = "no-referrer";
    img.onerror = function () {
      img.remove();
      media.textContent = label.slice(0, 2);
    };
    media.appendChild(img);
  } else {
    media.textContent = label.slice(0, 2);
  }
}

function initTabs() {
  const root = document.getElementById("send-page");
  if (!root) return;
  const tabs = root.querySelectorAll("[data-send-tab]");
  const panels = root.querySelectorAll("[data-send-panel]");
  function activate(mode) {
    tabs.forEach((t) => {
      const active = t.getAttribute("data-send-tab") === mode;
      t.setAttribute("aria-selected", active ? "true" : "false");
      t.classList.toggle("bg-primary-container", active);
      t.classList.toggle("text-black", active);
      t.classList.toggle("bg-surface-container-low", !active);
      t.classList.toggle("text-on-surface", !active);
    });
    panels.forEach((p) => {
      p.classList.toggle(
        "hidden",
        p.getAttribute("data-send-panel") !== mode
      );
    });
  }
  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      activate(t.getAttribute("data-send-tab"));
    });
  });
  activate("standard");
}

function initPrivacyUi() {
  const panel = document.querySelector('[data-send-panel="privacy"]');
  if (!panel) return;
  const input = document.getElementById("privacy-amount-input");
  if (input) bindDecimalInput(input, { maxDecimals: 18 });
  const balanceEl = document.getElementById("privacy-balance-display");
  const maxBtn = panel.querySelector("[data-privacy-max]");
  const topupBtn = panel.querySelector("[data-privacy-topup]");
  const privacyRecipientInput = document.getElementById("privacy-recipient-input");
  const modal = document.getElementById("privacy-topup-modal");
  const modalAmount = document.getElementById("privacy-topup-amount");
  const modalMaxBtn = document.getElementById("privacy-topup-max");
  const modalSubmit = document.getElementById("privacy-topup-submit");
  const modalWalletBal = document.getElementById("privacy-topup-wallet-balance");
  const privacyTokenSymbol = document.getElementById("privacy-token-symbol");
  const privacyTokenIcon = document.getElementById("privacy-token-icon");
  const privacyBalanceRow = document.getElementById("privacy-balance-row");
  const privacyBalanceLabel = document.getElementById("privacy-balance-label");
  const privacyBalanceUnit = document.getElementById("privacy-balance-unit");
  const privacyTopupLabel = document.getElementById("privacy-topup-label");
  const topupTokenSymbol = document.getElementById("privacy-topup-token-symbol");
  const topupTokenIcon = document.getElementById("privacy-topup-token-icon");
  if (modalAmount) bindDecimalInput(modalAmount, { maxDecimals: 18 });

  function getPrivacyToken() {
    return { symbol: "SOL", mint: SOL_MINT, decimals: 9, icon: "toll" };
  }

  function updatePrivacyTokenUi() {
    const tok = getPrivacyToken();
    if (privacyTokenSymbol) privacyTokenSymbol.textContent = tok.symbol;
    if (privacyTokenIcon) privacyTokenIcon.textContent = tok.icon;
    if (topupTokenSymbol) topupTokenSymbol.textContent = tok.symbol;
    if (topupTokenIcon) topupTokenIcon.textContent = tok.icon;
    if (privacyBalanceRow) {
      privacyBalanceRow.classList.remove("hidden");
    }
    if (privacyBalanceLabel) privacyBalanceLabel.textContent = "Private balance:";
    if (privacyBalanceUnit) privacyBalanceUnit.textContent = "SOL";
    if (privacyTopupLabel) privacyTopupLabel.textContent = "Top up";
    if (balanceEl) {
      const current = String(balanceEl.textContent || "").trim();
      if (!current || /shield mode/i.test(current)) {
        balanceEl.textContent = "0.000000000";
      }
    }
  }

  function getBalance() {
    const tok = getPrivacyToken();
    if (tok.mint !== SOL_MINT) return 0;
    const raw = (balanceEl && balanceEl.textContent) || "0";
    const n = parseFloat(raw.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }

  if (maxBtn && input) {
    maxBtn.addEventListener("click", async () => {
      const tok = getPrivacyToken();
      const b = getBalance();
      input.value = b > 0 ? String(b) : "";
      input.focus();
    });
  }

  if (topupBtn) {
    topupBtn.addEventListener("click", async () => {
      const ok = await ensureWalletForAction();
      if (!ok || !modal) return;
      if (!hasPrivacySessionSignature()) {
        try {
          await ensurePrivacySessionSignature({
            showIntroToast: true,
            successToast: "Privacy Cash session enabled",
          });
        } catch (err) {
          showToast(normalizePrivacyError(err, "Privacy session"), "error", {
            durationMs: 7000,
          });
          return;
        }
      }
      if (modalAmount) modalAmount.value = (input?.value || "").trim();
      if (modalWalletBal) {
        modalWalletBal.textContent = "Loading...";
        try {
          const solBal = await fetchNativeWalletBalanceSol();
          modalWalletBal.textContent = Number.isFinite(solBal)
            ? formatAmountForInput(solBal, 9)
            : "—";
        } catch {
          modalWalletBal.textContent = "—";
        }
      }
      openPopup(modal);
      if (modalAmount) requestAnimationFrame(() => modalAmount.focus());
    });
  }

  function closeTopupModal() {
    if (!modal) return;
    closePopup(modal);
  }
  modal?.querySelectorAll("[data-privacy-topup-close]").forEach((el) => {
    el.addEventListener("click", closeTopupModal);
  });

  modalMaxBtn?.addEventListener("click", async () => {
    if (getPrivacyToken().mint !== SOL_MINT) {
      showToast("Top up max is available for SOL only", "info");
      return;
    }
    try {
      const solBal = await fetchNativeWalletBalanceSol();
      if (!Number.isFinite(solBal)) return;
      if (modalAmount) modalAmount.value = formatAmountForInput(solBal, 9);
    } catch {
      /* ignore */
    }
  });

  modalSubmit?.addEventListener("click", async () => {
    if (getPrivacyToken().mint !== SOL_MINT) {
      showToast("Top up is available for SOL only", "info");
      return;
    }
    const ui = (modalAmount?.value || "").trim();
    const lamports = parseUiAmountToAtomic(ui, 9);
    if (!lamports) return showToast("Enter a valid SOL amount first", "error");
    if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
      return showToast("Amount is too large", "error");
    }
    try {
      const owner = getPublicKey();
      const hadCachedSig = owner ? !!getCachedPrivacySignature(owner) : false;
      if (!hadCachedSig) {
        showToast(
          "One-time step: sign message to enable Privacy Cash. Transaction prompt comes next.",
          "info",
          { durationMs: 7000 }
        );
      }
      const ctx = await buildPrivacyContext();
      closeTopupModal();
      if (!hadCachedSig) {
        showToast("Message signed. Now confirm the top-up transaction.", "info", {
          durationMs: 4500,
        });
      }
      showToast("Depositing to Privacy Cash...", "info", { noAutoDismiss: true });
      const out = await withTimeout(
        ctx.sdk.deposit({
          lightWasm: ctx.lightWasm,
          storage: ctx.storage,
          keyBasePath: ctx.keyBasePath,
          publicKey: ctx.owner,
          connection: ctx.connection,
          amount_in_lamports: Number(lamports),
          encryptionService: ctx.encryptionService,
          transactionSigner: ctx.transactionSigner,
        }),
        PRIVACY_ACTION_TIMEOUT_MS,
        "Privacy deposit"
      );
      // Show expected balance immediately; relayer index can lag a bit.
      const added = Number(lamports);
      if (Number.isFinite(added) && added > 0) {
        const base = Number.isFinite(privacyLastKnownLamports)
          ? privacyLastKnownLamports
          : 0;
        setPrivacyBalanceLamports(base + added);
      }
      hideToast();
      showToast("Private deposit submitted", "success", {
        linkHref: "https://solscan.io/tx/" + out.tx,
        linkLabel: "View on Solscan",
        durationMs: 7000,
      });
      recordSiteSend({
        wallet: ctx.owner.toBase58(),
        signature: out.tx,
        amountHuman: ui,
        recipientCount: 1,
        symbol: "SOL",
        recipient: "Privacy Pool (Deposit)",
        mint: SOL_MINT,
        sendKind: "privacy_deposit",
      });
      // #region agent log
      fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H3',location:'send-main.js:privacyDeposit',message:'privacy deposit recorded to activity',data:{wallet:ctx.owner.toBase58(),tx:out.tx,amountUi:ui},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      void pollPrivacyBalanceAfterDeposit(Number(lamports));
    } catch (err) {
      hideToast();
      showToast(normalizePrivacyError(err, "Privacy deposit"), "error", {
        durationMs: 7000,
      });
    }
  });

  document.getElementById("privacy-pool-submit")?.addEventListener("click", async () => {
    const ok = await ensureWalletForAction();
    if (!ok) return;
    const recipientRaw = (privacyRecipientInput?.value || "").trim();
    let recipient;
    try {
      recipient = new PublicKey(recipientRaw);
    } catch {
      return showToast("Enter a valid recipient address", "error");
    }
    const tok = getPrivacyToken();
    const ui = (input?.value || "").trim();
    const amountAtomic = parseUiAmountToAtomic(ui, tok.decimals);
    if (!amountAtomic) return showToast("Enter a valid " + tok.symbol + " amount", "error");
    if (amountAtomic > BigInt(Number.MAX_SAFE_INTEGER)) {
      return showToast("Amount is too large", "error");
    }
    if (!hasPrivacySessionSignature()) {
      try {
        await ensurePrivacySessionSignature({
          showIntroToast: true,
          successToast: "Privacy Cash session enabled",
        });
      } catch (err) {
        return showToast(normalizePrivacyError(err, "Privacy session"), "error", {
          durationMs: 7000,
        });
      }
    }
    try {
      const owner = getPublicKey();
      const hadCachedSig = owner ? !!getCachedPrivacySignature(owner) : false;
      if (!hadCachedSig) {
        showToast(
          "One-time step: sign message to enable Privacy Cash. Transaction prompt comes next.",
          "info",
          { durationMs: 7000 }
        );
      }
      const ctx = await buildPrivacyContext();
      if (!hadCachedSig) {
        showToast("Message signed. Now confirm the private send transaction.", "info", {
          durationMs: 4500,
        });
      }
      showToast("Submitting Privacy Cash withdrawal...", "info", {
        noAutoDismiss: true,
      });
      const out = await withTimeout(
        ctx.sdk.withdraw({
          recipient,
          lightWasm: ctx.lightWasm,
          storage: ctx.storage,
          publicKey: ctx.owner,
          connection: ctx.connection,
          amount_in_lamports: Number(amountAtomic),
          encryptionService: ctx.encryptionService,
          keyBasePath: ctx.keyBasePath,
        }),
        PRIVACY_ACTION_TIMEOUT_MS,
        "Privacy send"
      );
      hideToast();
      showToast("Private send submitted", "success", {
        linkHref: "https://solscan.io/tx/" + out.tx,
        linkLabel: "View on Solscan",
        durationMs: 7000,
      });
      recordSiteSend({
        wallet: ctx.owner.toBase58(),
        signature: out.tx,
        amountHuman: ui,
        recipientCount: 1,
        symbol: "SOL",
        recipient: recipient.toBase58(),
        mint: SOL_MINT,
        sendKind: "privacy_shielded_send",
      });
      // #region agent log
      fetch('http://127.0.0.1:7266/ingest/8f27976a-4ceb-42a9-90ca-4f04f3c39944',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'29e7ee'},body:JSON.stringify({sessionId:'29e7ee',runId:'pre-fix',hypothesisId:'H3',location:'send-main.js:privacyShieldedSend',message:'privacy shielded send recorded to activity',data:{wallet:ctx.owner.toBase58(),tx:out.tx,amountUi:ui},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (input) input.value = "";
      void refreshPrivacyPoolBalance();
    } catch (err) {
      hideToast();
      showToast(normalizePrivacyError(err, "Privacy send"), "error", {
        durationMs: 7000,
      });
    }
  });

  updatePrivacyTokenUi();
  syncPrivacySessionUi();
}

async function fetchMaxSendableUi() {
  const pk = getPublicKey();
  if (!pk || !selectedToken) return NaN;
  if (isSolMint(selectedToken.mint)) {
    const lamports = await withRpcRetry((conn) =>
      conn.getBalance(pk, "confirmed")
    );
    const nativeSol = lamports / LAMPORTS_PER_SOL;
    return Math.max(0, nativeSol - NATIVE_SOL_RESERVE_SOL);
  }
  return withRpcRetry((conn) =>
    fetchUiBalanceSingleMint(conn, pk, selectedToken.mint)
  );
}

async function applyMaxAmount() {
  const amountIn = document.getElementById("send-amount");
  if (!amountIn || !selectedToken) return;
  if (!getPublicKey()) {
    showToast("Connect wallet first", "error", { durationMs: 3500 });
    return;
  }
  try {
    const max = await fetchMaxSendableUi();
    if (!isFinite(max) || max <= 0) {
      amountIn.value = "";
      return;
    }
    amountIn.value = formatAmountForInput(max, selectedToken.decimals);
  } catch (e) {
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    showToast((e && e.message) || "Could not read balance", "error", {
      durationMs: 4000,
    });
  }
}

async function applyHalfAmount() {
  const amountIn = document.getElementById("send-amount");
  if (!amountIn || !selectedToken) return;
  if (!getPublicKey()) {
    showToast("Connect wallet first", "error", { durationMs: 3500 });
    return;
  }
  try {
    const max = await fetchMaxSendableUi();
    if (!isFinite(max) || max <= 0) {
      amountIn.value = "";
      return;
    }
    amountIn.value = formatAmountForInput(max / 2, selectedToken.decimals);
  } catch (e) {
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    showToast((e && e.message) || "Could not read balance", "error", {
      durationMs: 4000,
    });
  }
}

async function fetchSplAtomicBalance(conn, owner, mintStr) {
  const mintPk = new PublicKey(mintStr);
  const info = await conn.getAccountInfo(mintPk, "confirmed");
  if (!info) throw new Error("Mint account not found");
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
  try {
    const acc = await getAccount(conn, ata, undefined, programId);
    return acc.amount;
  } catch {
    return 0n;
  }
}

function initRecipients() {
  const list = document.getElementById("send-recipients-list");
  const addBtn = document.getElementById("send-add-recipient");
  if (!list || !addBtn) return;
  let syncingTopAmount = false;

  function rows() {
    return [...list.querySelectorAll(".send-recipient-row")];
  }

  function setTopAmountValue(nextValue) {
    const top = document.getElementById("send-amount");
    if (!top) return;
    syncingTopAmount = true;
    top.value = nextValue;
    syncingTopAmount = false;
  }

  function syncTopAmountFromRows() {
    const allRows = rows();
    if (allRows.length <= 1 || !selectedToken) return;
    let totalAtomic = 0n;
    let filled = 0;
    for (const row of allRows) {
      const input = row.querySelector(".send-recipient-amount");
      const ui = String(input?.value || "").trim();
      if (!ui) continue;
      const atomic = parseUiAmountToAtomic(ui, selectedToken.decimals);
      if (!atomic) return;
      totalAtomic += atomic;
      filled += 1;
    }
    if (!filled) return;
    setTopAmountValue(
      formatAmountForInput(
        atomicToUiNumber(totalAtomic, selectedToken.decimals),
        selectedToken.decimals
      )
    );
  }

  function autoSplitFromTopAmount() {
    const amountTop = (document.getElementById("send-amount")?.value || "").trim();
    const allRows = rows();
    if (!amountTop || allRows.length <= 1 || !selectedToken) return;
    const totalAtomic = parseUiAmountToAtomic(amountTop, selectedToken.decimals);
    if (!totalAtomic || totalAtomic <= 0n) return;
    const n = BigInt(allRows.length);
    const base = totalAtomic / n;
    const rem = totalAtomic % n;
    if (base <= 0n) return;
    allRows.forEach((row, idx) => {
      const input = row.querySelector(".send-recipient-amount");
      if (!input) return;
      const isManual = input.dataset.manual === "1";
      if (isManual && String(input.value || "").trim()) return;
      const rowAtomic = base + (idx === 0 ? rem : 0n);
      input.value = formatAmountForInput(
        Number(rowAtomic) / Math.pow(10, selectedToken.decimals),
        selectedToken.decimals
      );
    });
  }

  function sumRowUiAmounts() {
    let total = 0;
    for (const row of rows()) {
      const amt = row.querySelector(".send-recipient-amount");
      const n = parseFloat((amt?.value || "").trim());
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total;
  }

  function syncRemoveButtons() {
    const r = rows();
    autoSplitFromTopAmount();
    syncTopAmountFromRows();
    const labelEl = document.getElementById("send-recipients-field-label");
    if (labelEl) labelEl.textContent = r.length > 1 ? "Recipients" : "Recipient";
    const hint = document.getElementById("send-recipient-hint");
    if (hint) {
      const totalUi = sumRowUiAmounts();
      hint.textContent =
        "Up to " +
        MAX_RECIPIENTS +
        " recipients · auto-split available for 2+ wallets · total debit: " +
        (totalUi > 0
          ? formatAmountForInput(totalUi, selectedToken?.decimals || 9) +
            " " +
            (selectedToken?.symbol || "")
          : "—") +
        " · " +
        r.length +
        " wallet" +
        (r.length === 1 ? "" : "s");
    }
    const multi = r.length > 1;
    r.forEach((row) => {
      const btn = row.querySelector(".send-recipient-remove");
      if (btn) btn.classList.toggle("hidden", !multi);
      const amountWrap = row.querySelector(".send-recipient-amount")?.parentElement;
      if (amountWrap) amountWrap.classList.toggle("hidden", !multi);
      row.classList.toggle("items-center", !multi);
    });
    const atMax = r.length >= MAX_RECIPIENTS;
    addBtn.disabled = atMax;
    addBtn.setAttribute("aria-disabled", atMax ? "true" : "false");
    addBtn.classList.toggle("opacity-50", atMax);
    addBtn.classList.toggle("cursor-not-allowed", atMax);
  }

  function bindRemoveRow(row) {
    row.querySelector(".send-recipient-remove")?.addEventListener("click", () => {
      if (rows().length <= 1) return;
      row.remove();
      syncRemoveButtons();
    });
  }

  function bindAmountRow(row) {
    const amountInput = row.querySelector(".send-recipient-amount");
    if (!amountInput) return;
    bindDecimalInput(amountInput, { maxDecimals: 18 });
    amountInput.addEventListener("input", () => {
      amountInput.dataset.manual = "1";
      syncTopAmountFromRows();
      syncRemoveButtons();
    });
  }

  addBtn.addEventListener("click", () => {
    if (rows().length >= MAX_RECIPIENTS) return;
    const first = list.querySelector(".send-recipient-row");
    if (!first) return;
    const clone = first.cloneNode(true);
    const inp = clone.querySelector(".send-recipient-input");
    if (inp) inp.value = "";
    const amt = clone.querySelector(".send-recipient-amount");
    if (amt) amt.value = "";
    list.appendChild(clone);
    syncRemoveButtons();
    bindRemoveRow(clone);
    bindAmountRow(clone);
    autoSplitFromTopAmount();
    syncRemoveButtons();
  });

  rows().forEach((row) => {
    bindRemoveRow(row);
    bindAmountRow(row);
  });
  document.getElementById("send-amount")?.addEventListener("input", () => {
    if (syncingTopAmount) {
      syncRemoveButtons();
      return;
    }
    rows().forEach((row) => {
      const amt = row.querySelector(".send-recipient-amount");
      if (!amt) return;
      amt.dataset.manual = "0";
    });
    autoSplitFromTopAmount();
    syncRemoveButtons();
  });
  autoSplitFromTopAmount();
  syncRemoveButtons();
}

function atomicToUiNumber(amountAtomic, decimals) {
  if (typeof amountAtomic !== "bigint") return NaN;
  return Number(amountAtomic) / Math.pow(10, decimals);
}

function resolveRecipientAmounts(recipientRows, defaultUiStr, decimals) {
  const perRow = recipientRows.map((row) =>
    (row?.querySelector(".send-recipient-amount")?.value || "").trim()
  );

  if (recipientRows.length <= 1) {
    const usedUi = perRow[0] || defaultUiStr;
    const atomic = parseUiAmountToAtomic(usedUi, decimals);
    if (!atomic) {
      throw new Error("Set a valid amount");
    }
    return {
      amountsAtomic: [atomic],
      amountsUi: [usedUi],
    };
  }

  const filled = perRow.filter(Boolean).length;
  if (filled === 0) {
    const totalAtomic = parseUiAmountToAtomic(defaultUiStr, decimals);
    if (!totalAtomic) {
      throw new Error("Enter a total amount to split across recipients");
    }
    const count = BigInt(recipientRows.length);
    const base = totalAtomic / count;
    const rem = totalAtomic % count;
    if (base <= 0n) {
      throw new Error("Amount is too small to split across recipients");
    }
    const amountsAtomic = recipientRows.map((_, idx) =>
      base + (idx === 0 ? rem : 0n)
    );
    const amountsUi = amountsAtomic.map((amount) =>
      formatAmountForInput(atomicToUiNumber(amount, decimals), decimals)
    );
    return { amountsAtomic, amountsUi };
  }

  if (filled !== recipientRows.length) {
    throw new Error(
      "For multiple recipients, either use the total amount only or fill every split amount"
    );
  }

  const amountsAtomic = [];
  const amountsUi = [];
  for (const ui of perRow) {
    const atomic = parseUiAmountToAtomic(ui, decimals);
    if (!atomic) {
      throw new Error("Set a valid amount for each recipient");
    }
    amountsAtomic.push(atomic);
    amountsUi.push(ui);
  }
  return { amountsAtomic, amountsUi };
}

async function executeStandardSend() {
  const owner = getPublicKey();
  const prov = getProvider();
  if (!owner || !prov || !selectedToken) return;

  const submit = document.getElementById("send-submit");

  const inputs = [...document.querySelectorAll(".send-recipient-input")];
  const recipients = [];
  const seen = new Set();
  const defaultUiStr = (document.getElementById("send-amount")?.value || "").trim();
  const recipientRows = [];
  for (const inp of inputs) {
    const raw = (inp.value || "").trim();
    if (!raw) {
      showToast(
        inputs.length > 1
          ? "Enter every recipient address"
          : "Enter recipient address",
        "error"
      );
      return;
    }
    let dest;
    try {
      dest = new PublicKey(raw);
    } catch {
      showToast("Invalid recipient address", "error");
      return;
    }
    const s = dest.toBase58();
    if (seen.has(s)) {
      showToast("Duplicate recipients are not allowed", "error");
      return;
    }
    seen.add(s);
    recipients.push(dest);
    recipientRows.push(inp.closest(".send-recipient-row"));
  }

  let amountsAtomic;
  let amountsUi;
  try {
    const resolved = resolveRecipientAmounts(
      recipientRows,
      defaultUiStr,
      selectedToken.decimals
    );
    amountsAtomic = resolved.amountsAtomic;
    amountsUi = resolved.amountsUi;
  } catch (err) {
    showToast(String(err?.message || err || "Set valid amounts"), "error");
    return;
  }

  const n = recipients.length;
  const totalAtomic = amountsAtomic.reduce((sum, v) => sum + v, 0n);
  const totalUi = amountsUi.reduce((sum, v) => {
    const n = Number(v);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  try {
    if (isSolMint(selectedToken.mint)) {
      const lamports = await withRpcRetry((conn) =>
        conn.getBalance(owner, "confirmed")
      );
      const reserveLam = BigInt(
        Math.ceil(NATIVE_SOL_RESERVE_SOL * LAMPORTS_PER_SOL)
      );
      /** One signed transaction for all transfers — single base fee. */
      const needed =
        totalAtomic +
        reserveLam +
        ESTIMATED_FEE_LAMPORTS_PER_TX;
      if (BigInt(lamports) < needed) {
        showToast(
          "Insufficient SOL for amount × " + n + " recipients",
          "error",
          { durationMs: 5500 }
        );
        return;
      }
    } else {
      const balAtomic = await withRpcRetry((conn) =>
        fetchSplAtomicBalance(conn, owner, selectedToken.mint)
      );
      if (balAtomic < totalAtomic) {
        showToast(
          "Insufficient balance for " + n + " × amount",
          "error",
          { durationMs: 5500 }
        );
        return;
      }
    }
  } catch (e) {
    if (isRpcAccessError(e)) {
      invalidateRpcCache();
      invalidateWalletBalSnapshot();
    }
    showToast((e && e.message) || "Could not verify balance", "error");
    return;
  }

  const prevLabel = submit?.textContent;
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Sending…";
  }

  try {
    showToast("Confirm in wallet (one transaction)…", "info", {
      noAutoDismiss: true,
    });
    const firstAmt = amountsUi[0] || "0";
    setSendStatus(
      "Sending " +
        n +
        " custom transfers · total " +
        formatAmountForInput(totalUi, selectedToken.decimals) +
        " " +
        selectedToken.symbol +
        " (first: " +
        firstAmt +
        ")",
      false
    );
    const conn = await withRpcRetry(async (c) => {
      await c.getLatestBlockhash("confirmed");
      return c;
    });
    const sig = isSolMint(selectedToken.mint)
      ? await sendNativeSolBatchVariable(conn, prov, {
          from: owner,
          recipientPubkeys: recipients,
          lamportsPerRecipient: amountsAtomic,
        })
      : await sendSplAmountBatchVariable(conn, prov, {
          owner,
          mintStr: selectedToken.mint,
          recipientPubkeys: recipients,
          amountAtomicPerRecipient: amountsAtomic,
        });
    const recipientSummary = recipients.map((r) => r.toBase58()).join(", ");
    recordSiteSend({
      wallet: owner.toBase58(),
      signature: sig,
      amountHuman: formatAmountForInput(totalUi, selectedToken.decimals),
      recipientCount: n,
      symbol: selectedToken.symbol,
      recipient: recipientSummary,
      mint: selectedToken.mint,
      sendKind: "standard_send",
    });
    hideToast();
    showToast(
      n > 1
        ? "Sent " + n + " transfers in one transaction"
        : "Transaction confirmed",
      "success",
      {
        linkHref: "https://solscan.io/tx/" + sig,
        linkLabel: "View on Solscan",
        durationMs: 5500,
      }
    );
    const amountEl = document.getElementById("send-amount");
    if (amountEl) amountEl.value = "";
    const rowAmounts = document.querySelectorAll(".send-recipient-amount");
    rowAmounts.forEach((el) => {
      el.value = "";
    });
    invalidateWalletBalSnapshot();
    void refreshWalletHoldings();
    void refreshSendAvailable();
  } catch (e) {
    console.error(e);
    const msg = (e && e.message) || "Send failed";
    hideToast();
    showToast(msg, "error", { durationMs: 5500 });
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = prevLabel || "Send";
    }
    updateSendSubmitState();
  }
}

async function init() {
  initTabs();
  initPrivacyUi();

  const wirePromise = wireWalletConnectButton(syncSendPageUi);

  void fetchJupiterTokenList()
    .then((tokenList) => {
      jupiterByMint = tokenMapByMint(tokenList);
      if (getPublicKey()) void refreshWalletHoldings();
    })
    .catch(() => {});

  selectedToken = {
    mint: SOL_MINT,
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    logoURI: TRUSTED_LOGO_BY_MINT[SOL_MINT],
  };
  renderTokenSymbol();

  document.getElementById("send-token-trigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTokenDropdown();
  });
  document.addEventListener("click", (e) => {
    const rel = document
      .getElementById("send-token-trigger")
      ?.closest(".relative");
    if (rel && e.target instanceof Node && rel.contains(e.target)) return;
    closeTokenDropdown();
  });

  document.getElementById("send-half")?.addEventListener("click", () => {
    void applyHalfAmount();
  });
  document.getElementById("send-max")?.addEventListener("click", () => {
    void applyMaxAmount();
  });
  await wirePromise;

  const sendAmount = document.getElementById("send-amount");
  if (sendAmount) {
    bindDecimalInput(sendAmount, { maxDecimals: 18 });
  }
  initRecipients();

  document.getElementById("send-submit")?.addEventListener("click", async () => {
    if (!getPublicKey()) {
      const ok = await ensureWalletForAction();
      if (!ok || !getPublicKey()) return;
      updateSendSubmitState();
      void refreshWalletHoldings();
      void refreshSendAvailable();
    }
    if (!getPublicKey()) return;
    await executeStandardSend();
  });

  syncSendPageUi();
  void autoSignPrivacyOnLoad();
}

init().catch((err) => {
  console.error("send page init failed", err);
});
