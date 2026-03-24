import {
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  getPublicKey,
  getProvider,
  wireWalletConnectButton,
  trySilentReconnect,
  openWalletPicker,
  refreshWalletConnectButtonLabel,
} from "./lib/wallet-session.js";
import { withRpcRetry, waitForSignatureConfirmation } from "./lib/solana-rpc.js";
import {
  getSiteActivityStatsForWallet,
  recordSiteBurn,
  recordSiteClaim,
} from "./lib/site-activity.js";
import { fetchDexscreenerSolanaMintProfile } from "./lib/jupiter-price.js";

const RECLAIM_BATCH_SIZE = 8;
const BURN_BATCH_SIZE = 6;
const PROTECTED_BURN_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
]);
const TRUSTED_LOGO_BY_MINT = {
  So11111111111111111111111111111111111111112:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd/logo.png",
};

let reclaimRows = [];
let burnRows = [];
let selectedBurnRows = new Set();
let reclaimScannedOnce = false;
let burnScannedOnce = false;
let reclaimScanInFlight = false;
let burnScanInFlight = false;
let reclaimInFlight = false;
let burnInFlight = false;
let reclaimToastTimer = null;

const tokenProfileCache = new Map();

function shortAddr(value) {
  const s = String(value || "").trim();
  if (s.length <= 10) return s || "-";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

function addThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTokenAmount(rawAmount, decimals) {
  let raw;
  try {
    raw = BigInt(String(rawAmount || "0"));
  } catch {
    raw = 0n;
  }
  const safeDecimals = Math.max(0, Number(decimals || 0));
  if (raw === 0n) return "0";
  if (!safeDecimals) return addThousands(raw.toString());
  const scale = 10n ** BigInt(safeDecimals);
  const whole = raw / scale;
  const fraction = (raw % scale)
    .toString()
    .padStart(safeDecimals, "0")
    .replace(/0+$/, "")
    .slice(0, 6);
  return fraction
    ? addThousands(whole.toString()) + "." + fraction
    : addThousands(whole.toString());
}

function formatSol(lamports) {
  const sol = Number(lamports || 0) / LAMPORTS_PER_SOL;
  if (!Number.isFinite(sol) || sol <= 0) return "0";
  return sol >= 1
    ? sol.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : sol.toFixed(6).replace(/\.?0+$/, "");
}

function formatUsd(value) {
  if (value == null || !isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1) {
    return (
      "$" +
      value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  if (value >= 0.01) return "$" + value.toFixed(4);
  return "$" + value.toFixed(6);
}

function clearToastTimer() {
  if (reclaimToastTimer) {
    clearTimeout(reclaimToastTimer);
    reclaimToastTimer = null;
  }
}

function hideToast() {
  clearToastTimer();
  const host = document.getElementById("reclaim-toast-host");
  if (host) host.innerHTML = "";
}

function showToast(message, variant = "info", opts = {}) {
  const host = document.getElementById("reclaim-toast-host");
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
  reclaimToastTimer = setTimeout(() => {
    host.innerHTML = "";
    reclaimToastTimer = null;
  }, opts.durationMs ?? 4500);
}

function setStatus(message, isError = false) {
  const el = document.getElementById("reclaim-status");
  if (!el) return;
  el.textContent = String(message || "");
  el.className =
    (message ? "mt-3 min-h-[1.25rem] text-[10px] font-bold uppercase " : "hidden ") +
    (isError ? "text-error" : "text-on-surface-variant");
  if (!message) {
    el.classList.add("hidden");
  } else {
    el.classList.remove("hidden");
  }
}

function totalClosableLamports(rows = reclaimRows) {
  return rows.reduce((sum, row) => sum + BigInt(row.lamports || 0), 0n);
}

function getSelectedBurnRows() {
  return burnRows.filter((row) => selectedBurnRows.has(row.address));
}

function updateSummary() {
  const countEl = document.getElementById("reclaim-count");
  const totalEl = document.getElementById("reclaim-total");
  const burnCountEl = document.getElementById("burn-count");
  const burnUsdEl = document.getElementById("burn-total-usd");
  if (countEl) countEl.textContent = String(reclaimRows.length);
  if (totalEl) totalEl.textContent = formatSol(totalClosableLamports(reclaimRows));
  if (burnCountEl) burnCountEl.textContent = String(burnRows.length);
  if (burnUsdEl) {
    const burnUsd = getSelectedBurnRows().reduce(
      (sum, row) => sum + (Number(row.priceUsd) || 0) * (Number(row.balanceUi) || 0),
      0
    );
    burnUsdEl.textContent = formatUsd(burnUsd);
  }
}

function updateActivityStats() {
  const stats = getSiteActivityStatsForWallet(getPublicKey()?.toBase58() || "");
  const mapping = {
    "cleanup-stat-total": stats.total,
    "cleanup-stat-swap": stats.swap,
    "cleanup-stat-bridge": stats.bridge,
    "cleanup-stat-claim": stats.claim,
    "cleanup-stat-burn": stats.burn,
  };
  Object.entries(mapping).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value || 0);
  });
}

function scanBusy() {
  return reclaimScanInFlight || burnScanInFlight;
}

function updateButtons() {
  const hasWallet = Boolean(getPublicKey());
  const actionBusy = reclaimInFlight || burnInFlight;
  const anyScanBusy = scanBusy();
  const reclaimScanBtn = document.getElementById("reclaim-scan");
  const burnScanBtn = document.getElementById("burn-scan");
  const reclaimBtn = document.getElementById("reclaim-submit");
  const burnBtn = document.getElementById("burn-submit");
  const selectAllBtn = document.getElementById("burn-select-all");
  const selectedCount = getSelectedBurnRows().length;

  if (reclaimScanBtn) {
    reclaimScanBtn.disabled = actionBusy || anyScanBusy;
    reclaimScanBtn.textContent = reclaimScanInFlight ? "Scanning..." : "Scan";
  }
  if (burnScanBtn) {
    burnScanBtn.disabled = actionBusy || anyScanBusy;
    burnScanBtn.textContent = burnScanInFlight ? "Scanning..." : "Scan";
  }
  if (reclaimBtn) {
    reclaimBtn.disabled =
      !hasWallet || actionBusy || anyScanBusy || reclaimRows.length === 0;
    reclaimBtn.textContent = !hasWallet
      ? "Connect wallet"
      : reclaimInFlight
        ? "Claiming..."
        : reclaimRows.length
          ? "Claim all"
          : "Nothing to claim";
  }
  if (burnBtn) {
    burnBtn.disabled =
      !hasWallet || actionBusy || anyScanBusy || selectedCount === 0;
    burnBtn.textContent = burnInFlight
      ? "Burning..."
      : "Burn selected";
  }
  if (selectAllBtn) {
    selectAllBtn.disabled = !hasWallet || actionBusy || anyScanBusy || burnRows.length === 0;
    selectAllBtn.textContent =
      selectedCount && selectedCount === burnRows.length ? "Clear all" : "Select all";
  }
}

function makeTokenIcon(row) {
  const wrap = document.createElement("div");
  wrap.className =
    "flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-black bg-inverse-surface";
  const logoUri = row.logoURI || TRUSTED_LOGO_BY_MINT[row.mint] || "";
  if (logoUri) {
    const img = document.createElement("img");
    img.src = logoUri;
    img.alt = "";
    img.className = "h-8 w-8 rounded-full object-cover";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      wrap.innerHTML = "";
      const sp = document.createElement("span");
      sp.className = "material-symbols-outlined text-primary-fixed text-2xl";
      sp.textContent = "toll";
      wrap.appendChild(sp);
    };
    wrap.appendChild(img);
    return wrap;
  }
  const sp = document.createElement("span");
  sp.className = "material-symbols-outlined text-primary-fixed text-2xl";
  sp.textContent = "toll";
  wrap.appendChild(sp);
  return wrap;
}

function renderReclaimRows() {
  const list = document.getElementById("reclaim-list");
  const empty = document.getElementById("reclaim-empty");
  if (!list || !empty) return;
  list.innerHTML = "";
  if (!getPublicKey()) {
    empty.textContent = "Connect wallet";
    empty.classList.remove("hidden");
    return;
  }
  if (reclaimScanInFlight) {
    empty.textContent = "Scanning...";
    empty.classList.remove("hidden");
    return;
  }
  if (!reclaimScannedOnce) {
    empty.textContent = "Press scan";
    empty.classList.remove("hidden");
    return;
  }
  if (!reclaimRows.length) {
    empty.textContent = "No unused accounts";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  reclaimRows.forEach((row) => {
    const item = document.createElement("div");
    item.className =
      "flex items-center justify-between gap-3 border-4 border-black bg-surface-container-low p-3";

    const left = document.createElement("div");
    left.className = "flex min-w-0 flex-1 items-center gap-3";
    left.appendChild(makeTokenIcon(row));

    const textWrap = document.createElement("div");
    textWrap.className = "min-w-0";
    const title = document.createElement("p");
    title.className = "truncate text-sm font-extrabold uppercase text-on-surface";
    title.textContent = row.symbol || shortAddr(row.mint);
    const meta = document.createElement("p");
    meta.className = "mt-1 truncate text-[10px] font-bold uppercase text-outline";
    meta.textContent =
      (row.name || shortAddr(row.mint)) + " · " + formatSol(row.lamports) + " SOL";
    meta.title = row.mint;
    textWrap.appendChild(title);
    textWrap.appendChild(meta);
    left.appendChild(textWrap);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "shrink-0 border-2 border-black bg-white px-3 py-2 text-[10px] font-bold uppercase tracking-tight hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50";
    closeBtn.textContent = "Close";
    closeBtn.disabled = reclaimInFlight || burnInFlight || scanBusy();
    closeBtn.addEventListener("click", () => {
      void reclaimAccounts([row]);
    });

    item.appendChild(left);
    item.appendChild(closeBtn);
    list.appendChild(item);
  });
}

function renderBurnRows() {
  const list = document.getElementById("burn-list");
  const empty = document.getElementById("burn-empty");
  if (!list || !empty) return;
  list.innerHTML = "";
  if (!getPublicKey()) {
    empty.textContent = "Connect wallet";
    empty.classList.remove("hidden");
    return;
  }
  if (burnScanInFlight) {
    empty.textContent = "Scanning...";
    empty.classList.remove("hidden");
    return;
  }
  if (!burnScannedOnce) {
    empty.textContent = "Press scan";
    empty.classList.remove("hidden");
    return;
  }
  if (!burnRows.length) {
    empty.textContent = "No burnable tokens";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  burnRows.forEach((row) => {
    const item = document.createElement("label");
    item.className =
      "flex items-center gap-3 border-4 border-black bg-surface-container-low p-3 cursor-pointer";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className =
      "h-5 w-5 shrink-0 border-2 border-black text-black focus:ring-0";
    checkbox.checked = selectedBurnRows.has(row.address);
    checkbox.disabled = burnInFlight || reclaimInFlight || scanBusy();
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedBurnRows.add(row.address);
      else selectedBurnRows.delete(row.address);
      updateSummary();
      updateButtons();
    });

    const content = document.createElement("div");
    content.className = "flex min-w-0 flex-1 items-center gap-3";
    content.appendChild(makeTokenIcon(row));

    const textWrap = document.createElement("div");
    textWrap.className = "min-w-0";
    const title = document.createElement("p");
    title.className = "truncate text-sm font-extrabold uppercase text-on-surface";
    title.textContent = row.symbol || shortAddr(row.mint);
    const meta = document.createElement("p");
    meta.className = "mt-1 truncate text-[10px] font-bold uppercase text-outline";
    const usdText =
      Number(row.priceUsd) > 0 && Number(row.balanceUi) > 0
        ? " · " + formatUsd(Number(row.priceUsd) * Number(row.balanceUi))
        : "";
    meta.textContent = row.amountHuman + usdText + " · " + (row.name || shortAddr(row.mint));
    meta.title = row.mint;
    textWrap.appendChild(title);
    textWrap.appendChild(meta);

    content.appendChild(textWrap);
    item.appendChild(checkbox);
    item.appendChild(content);
    list.appendChild(item);
  });
}

function normalizeTokenAccount(entry, programId, ownerBase58) {
  const info = entry?.account?.data?.parsed?.info;
  if (!info) return null;
  if (String(info?.owner || "") !== ownerBase58) return null;
  if (info?.isNative === true || String(info?.isNative || "") === "true") return null;
  const state = String(info?.state || "").toLowerCase();
  if (state && state !== "initialized") return null;
  const mint = String(info?.mint || "").trim();
  const address = entry?.pubkey?.toBase58?.();
  const rawAmount = String(info?.tokenAmount?.amount || "0").trim();
  const decimals = Number(info?.tokenAmount?.decimals || 0);
  if (!mint || !address) return null;
  return {
    address,
    mint,
    programId,
    lamports: Number(entry?.account?.lamports || 0),
    rawAmount,
    decimals,
    balanceUi:
      decimals >= 0 && Number.isFinite(decimals)
        ? Number(rawAmount) / Math.pow(10, decimals)
        : 0,
    amountHuman: formatTokenAmount(rawAmount, decimals),
    closeAuthority: String(info?.closeAuthority || "").trim(),
    symbol: shortAddr(mint),
    name: shortAddr(mint),
    logoURI: TRUSTED_LOGO_BY_MINT[mint] || "",
    priceUsd: 0,
  };
}

async function fetchWalletTokenRows() {
  const owner = getPublicKey();
  if (!owner) return [];
  const ownerBase58 = owner.toBase58();
  const [spl, token2022] = await withRpcRetry(async (conn) =>
    Promise.all([
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ])
  );
  return [
    ...spl.value
      .map((entry) => normalizeTokenAccount(entry, TOKEN_PROGRAM_ID, ownerBase58))
      .filter(Boolean),
    ...token2022.value
      .map((entry) => normalizeTokenAccount(entry, TOKEN_2022_PROGRAM_ID, ownerBase58))
      .filter(Boolean),
  ];
}

function deriveReclaimRows(rows, ownerBase58) {
  return rows
    .filter((row) => {
      if (row.rawAmount !== "0") return false;
      if (row.closeAuthority && row.closeAuthority !== ownerBase58) return false;
      return true;
    })
    .sort((a, b) => b.lamports - a.lamports);
}

function deriveBurnRows(rows) {
  return rows
    .filter((row) => {
      try {
        return BigInt(row.rawAmount) > 0n && !PROTECTED_BURN_MINTS.has(row.mint);
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      try {
        const left = BigInt(a.rawAmount);
        const right = BigInt(b.rawAmount);
        if (left === right) return a.mint.localeCompare(b.mint);
        return left > right ? -1 : 1;
      } catch {
        return 0;
      }
    });
}

function applyTokenProfile(row, profile) {
  if (!row) return;
  const logo = TRUSTED_LOGO_BY_MINT[row.mint] || profile?.logoURI || row.logoURI || "";
  row.logoURI = String(logo || "").trim();
  if (profile?.symbol && String(profile.symbol).trim()) {
    row.symbol = String(profile.symbol).trim().slice(0, 14);
  }
  if (profile?.name && String(profile.name).trim()) {
    row.name = String(profile.name).trim().slice(0, 48);
  }
  if (Number.isFinite(profile?.priceUsd) && profile.priceUsd > 0) {
    row.priceUsd = profile.priceUsd;
  }
}

async function enrichRowsWithDex(rows) {
  const missingMints = [
    ...new Set(
      rows
        .map((row) => row?.mint)
        .filter(Boolean)
        .filter((mint) => !tokenProfileCache.has(mint))
    ),
  ];
  await Promise.all(
    missingMints.map(async (mint) => {
      const profile = await fetchDexscreenerSolanaMintProfile(mint);
      tokenProfileCache.set(mint, profile || null);
    })
  );
  rows.forEach((row) => {
    applyTokenProfile(row, tokenProfileCache.get(row.mint));
  });
}

async function ensureWalletForAction() {
  if (getPublicKey() && getProvider()) return true;
  const silent = await trySilentReconnect(syncCleanupUi);
  if (silent) return true;
  showToast("Choose a wallet to continue", "info", { durationMs: 3500 });
  openWalletPicker(syncCleanupUi);
  return false;
}

async function scanCleanupRows(opts = {}) {
  const ok = opts.skipEnsure ? true : await ensureWalletForAction();
  if (!ok || !getPublicKey()) return;
  reclaimScannedOnce = true;
  reclaimScanInFlight = true;
  setStatus("Scanning clean up...");
  updateButtons();
  renderReclaimRows();
  try {
    const ownerBase58 = getPublicKey()?.toBase58() || "";
    const rows = await fetchWalletTokenRows();
    const nextRows = deriveReclaimRows(rows, ownerBase58);
    await enrichRowsWithDex(nextRows);
    reclaimRows = nextRows;
    setStatus("");
  } catch (err) {
    reclaimRows = [];
    setStatus((err && err.message) || "Could not scan clean up", true);
    showToast((err && err.message) || "Could not scan clean up", "error");
  } finally {
    reclaimScanInFlight = false;
    updateSummary();
    updateButtons();
    renderReclaimRows();
  }
}

async function scanBurnRows(opts = {}) {
  const ok = opts.skipEnsure ? true : await ensureWalletForAction();
  if (!ok || !getPublicKey()) return;
  burnScannedOnce = true;
  burnScanInFlight = true;
  updateButtons();
  renderBurnRows();
  try {
    const rows = await fetchWalletTokenRows();
    const nextRows = deriveBurnRows(rows);
    await enrichRowsWithDex(nextRows);
    burnRows = nextRows;
    selectedBurnRows = new Set(
      Array.from(selectedBurnRows).filter((address) =>
        burnRows.some((row) => row.address === address)
      )
    );
    if (!reclaimInFlight && !burnInFlight) setStatus("");
  } catch (err) {
    burnRows = [];
    selectedBurnRows = new Set();
    setStatus((err && err.message) || "Could not scan burn list", true);
    showToast((err && err.message) || "Could not scan burn list", "error");
  } finally {
    burnScanInFlight = false;
    updateSummary();
    updateButtons();
    renderBurnRows();
  }
}

function chunkRows(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function signAndSendTransactions(txs, label) {
  const provider = getProvider();
  if (!provider) throw new Error("Connect wallet first");
  const signatures = [];
  return withRpcRetry(async (conn) => {
    if (typeof provider.signAllTransactions === "function" && txs.length > 1) {
      showToast(
        "Approve " + txs.length + " " + label + " transaction" + (txs.length === 1 ? "" : "s"),
        "info",
        { noAutoDismiss: true }
      );
      const signedAll = await provider.signAllTransactions(txs);
      for (const signed of signedAll) {
        const sig = await conn.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await waitForSignatureConfirmation(sig, { timeoutMs: 90_000 });
        signatures.push(sig);
      }
      return signatures;
    }

    for (let i = 0; i < txs.length; i += 1) {
      showToast(
        "Approve " + label + " transaction " + (i + 1) + " of " + txs.length,
        "info",
        { noAutoDismiss: true }
      );
      const signed = await provider.signTransaction(txs[i]);
      const sig = await conn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await waitForSignatureConfirmation(sig, { timeoutMs: 90_000 });
      signatures.push(sig);
    }
    return signatures;
  });
}

async function signAndSendCloseBatches(rows) {
  const owner = getPublicKey();
  if (!owner) throw new Error("Connect wallet first");
  return withRpcRetry(async (conn) => {
    const chunks = chunkRows(rows, RECLAIM_BATCH_SIZE);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const txs = chunks.map((batch) => {
      const instructions = batch.map((row) =>
        createCloseAccountInstruction(new PublicKey(row.address), owner, owner, [], row.programId)
      );
      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      return new VersionedTransaction(message);
    });
    return signAndSendTransactions(txs, "claim");
  });
}

async function signAndSendBurnBatches(rows) {
  const owner = getPublicKey();
  if (!owner) throw new Error("Connect wallet first");
  return withRpcRetry(async (conn) => {
    const chunks = chunkRows(rows, BURN_BATCH_SIZE);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const txs = chunks.map((batch) => {
      const instructions = batch.map((row) =>
        createBurnInstruction(
          new PublicKey(row.address),
          new PublicKey(row.mint),
          owner,
          BigInt(row.rawAmount),
          [],
          row.programId
        )
      );
      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      return new VersionedTransaction(message);
    });
    return signAndSendTransactions(txs, "burn");
  });
}

async function reclaimAccounts(rows) {
  if (!rows.length) return;
  const ok = await ensureWalletForAction();
  if (!ok || !getPublicKey()) return;
  reclaimInFlight = true;
  updateButtons();
  const totalLamports = rows.reduce((sum, row) => sum + BigInt(row.lamports || 0), 0n);
    setStatus("Claiming...");
  try {
    const signatures = await signAndSendCloseBatches(rows);
    const claimedAddresses = new Set(rows.map((row) => row.address));
    reclaimRows = reclaimRows.filter((row) => !claimedAddresses.has(row.address));
    const reclaimedSol = Number(totalLamports) / LAMPORTS_PER_SOL;
    recordSiteClaim({
      wallet: getPublicKey()?.toBase58() || "",
      signature: signatures[0],
      closedCount: rows.length,
      reclaimedSol,
    });
    updateActivityStats();
    hideToast();
    showToast(
      "Claimed " + formatSol(totalLamports) + " SOL",
      "success",
      signatures[0]
        ? {
            linkHref: "https://solscan.io/tx/" + signatures[0],
            linkLabel: "View on Solscan",
            durationMs: 6500,
          }
        : { durationMs: 6500 }
    );
    setStatus("");
  } catch (err) {
    hideToast();
    setStatus((err && err.message) || "Claim failed", true);
    showToast((err && err.message) || "Claim failed", "error", {
      durationMs: 6500,
    });
  } finally {
    reclaimInFlight = false;
    updateSummary();
    updateActivityStats();
    updateButtons();
    renderReclaimRows();
  }
}

function openBurnConfirm() {
  const rows = getSelectedBurnRows();
  if (!rows.length) return;
  const modal = document.getElementById("burn-confirm-modal");
  const text = document.getElementById("burn-confirm-text");
  if (text) {
    text.textContent =
      "Burn " +
      rows.length +
      " token balance" +
      (rows.length === 1 ? "" : "s") +
      "? This cannot be undone.";
  }
  modal?.classList.remove("hidden");
  modal?.setAttribute("aria-hidden", "false");
}

function closeBurnConfirm() {
  const modal = document.getElementById("burn-confirm-modal");
  modal?.classList.add("hidden");
  modal?.setAttribute("aria-hidden", "true");
}

async function burnSelectedRowsNow() {
  const rows = getSelectedBurnRows();
  if (!rows.length) return;
  const ok = await ensureWalletForAction();
  if (!ok || !getPublicKey()) return;
  burnInFlight = true;
  closeBurnConfirm();
  updateButtons();
  setStatus("Burning...");
  try {
    const signatures = await signAndSendBurnBatches(rows);
    const burnedAddresses = new Set(rows.map((row) => row.address));
    burnRows = burnRows.filter((row) => !burnedAddresses.has(row.address));
    selectedBurnRows = new Set();
    const first = rows[0];
    recordSiteBurn({
      wallet: getPublicKey()?.toBase58() || "",
      signature: signatures[0],
      mint: first?.mint || "",
      symbol: first?.symbol || shortAddr(first?.mint || ""),
      amountHuman: first?.amountHuman || "",
      tokenCount: rows.length,
    });
    updateActivityStats();
    hideToast();
    showToast(
      "Burn complete",
      "success",
      signatures[0]
        ? {
            linkHref: "https://solscan.io/tx/" + signatures[0],
            linkLabel: "View on Solscan",
            durationMs: 6500,
          }
        : { durationMs: 6500 }
    );
    setStatus("");
  } catch (err) {
    hideToast();
    setStatus((err && err.message) || "Burn failed", true);
    showToast((err && err.message) || "Burn failed", "error", {
      durationMs: 6500,
    });
  } finally {
    burnInFlight = false;
    updateSummary();
    updateActivityStats();
    updateButtons();
    renderBurnRows();
  }
}

function syncCleanupUi() {
  const btn = document.getElementById("wallet-connect");
  refreshWalletConnectButtonLabel(btn);
  if (!getPublicKey()) {
    reclaimRows = [];
    burnRows = [];
    selectedBurnRows = new Set();
    reclaimScannedOnce = false;
    burnScannedOnce = false;
    setStatus("");
    closeBurnConfirm();
  }
  updateSummary();
  updateActivityStats();
  updateButtons();
  renderReclaimRows();
  renderBurnRows();
}

async function init() {
  await wireWalletConnectButton(syncCleanupUi);

  document.getElementById("reclaim-scan")?.addEventListener("click", () => {
    void scanCleanupRows();
  });

  document.getElementById("burn-scan")?.addEventListener("click", () => {
    void scanBurnRows();
  });

  document.getElementById("reclaim-submit")?.addEventListener("click", async () => {
    if (!getPublicKey()) {
      const ok = await ensureWalletForAction();
      if (!ok || !getPublicKey()) return;
    }
    await reclaimAccounts(reclaimRows);
  });

  document.getElementById("burn-select-all")?.addEventListener("click", () => {
    if (selectedBurnRows.size === burnRows.length) selectedBurnRows = new Set();
    else selectedBurnRows = new Set(burnRows.map((row) => row.address));
    renderBurnRows();
    updateSummary();
    updateButtons();
  });

  document.getElementById("burn-submit")?.addEventListener("click", () => {
    openBurnConfirm();
  });

  document.getElementById("burn-confirm-cancel")?.addEventListener("click", () => {
    closeBurnConfirm();
  });

  document.getElementById("burn-confirm-backdrop")?.addEventListener("click", () => {
    closeBurnConfirm();
  });

  document.getElementById("burn-confirm-submit")?.addEventListener("click", () => {
    void burnSelectedRowsNow();
  });

  syncCleanupUi();
}

init().catch((err) => {
  console.error("cleanup page init failed", err);
  setStatus("Could not initialize clean up page", true);
});
