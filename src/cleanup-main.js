import {
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction,
  unpackAccount,
} from "@solana/spl-token";
import {
  getPublicKey,
  getProvider,
  wireWalletConnectButton,
  refreshWalletConnectButtonLabel,
  trySilentReconnect,
  openWalletPicker,
} from "./lib/wallet-session.js";
import { withRpcRetry, waitForSignatureConfirmation } from "./lib/solana-rpc.js";
import { bindDecimalInput } from "./lib/input-decimal.js";
import { openPopup, closePopup } from "./lib/popup-motion.js";
import {
  fetchJupiterTokenList,
  tokenMapByMint,
  SOL_MINT,
} from "./lib/jupiter-tokens.js";
import { fetchUsdPricesForMints, formatUsd, USD_PEG_MINTS } from "./lib/jupiter-price.js";
import { fetchDexscreenerSolanaMintProfile } from "./lib/jupiter-price.js";
import { recordSiteBurn, recordSiteClaim } from "./lib/site-activity.js";
import { getSiteActivityStatsForWallet } from "./lib/site-activity.js";
import {
  buildBurnTransaction,
  buildCloseAllPage,
  hasSolIncineratorApiKey,
  previewCloseAllPage,
  relaySignedTransactionsBatch,
  summarizeCloseAll,
} from "./lib/sol-incinerator.js";

const CLOSE_IXS_PER_TX = 8;
const DUST_BURN_DEFAULT_MAX_USD = 10;
const LS_CLEANUP_STATS_HIDDEN = "neo-dex-cleanup-stats-hidden";
const MAX_SOLANA_TX_WIRE_BYTES = 1232;
const RECLAIM_TARGET_TX_WIRE_BYTES = 1180;

let cleanupToastTimer = null;
let dustRows = [];
let reclaimableAccounts = [];
let jupiterByMint = new Map();
let dexscreenerByMint = new Map();

function cleanupErrorMessage(err, fallback) {
  const raw = String(err?.message || err || fallback || "Unexpected error");
  const upper = raw.toUpperCase();
  if (upper.includes("NO_SWAP_ROUTES_FOUND") || upper.includes('"ERRORCODE":9')) {
    return "No swap route found for one or more selected tokens right now. Try different tokens or a higher amount.";
  }
  if (
    upper.includes("API KEY IS NOT ALLOWED") ||
    upper.includes("JSON-RPC CODE: -32052") ||
    upper.includes('"ERROR":9')
  ) {
    return "RPC provider rejected this request (403). Try again in a moment or switch RPC endpoint.";
  }
  if (upper.includes("FAILED TO FETCH") || upper.includes("NETWORK ERROR")) {
    return "Network request failed. Check connection and try again.";
  }
  return raw;
}

function clearCleanupToastTimer() {
  if (cleanupToastTimer) {
    clearTimeout(cleanupToastTimer);
    cleanupToastTimer = null;
  }
}

function hideCleanupToast() {
  clearCleanupToastTimer();
  const host = document.getElementById("cleanup-toast-host");
  if (host) host.innerHTML = "";
}

function showCleanupToast(message, variant = "info", opts = {}) {
  const host = document.getElementById("cleanup-toast-host");
  if (!host) return;
  hideCleanupToast();
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
  const ms = opts.durationMs ?? (variant === "success" ? 6500 : 4500);
  cleanupToastTimer = setTimeout(() => {
    host.innerHTML = "";
    cleanupToastTimer = null;
  }, ms);
}

function setDustStatus(msg, isErr = false) {
  const el = document.getElementById("cleanup-dust-status");
  if (!el) return;
  el.textContent = msg;
  el.className =
    "mt-3 text-[10px] font-bold uppercase " +
    (isErr ? "text-error" : "text-on-surface-variant");
}

function setReclaimStatus(msg, isErr = false) {
  const el = document.getElementById("cleanup-reclaim-status");
  if (!el) return;
  el.textContent = msg;
  el.className =
    "mt-3 text-[10px] font-bold uppercase " +
    (isErr ? "text-error" : "text-on-surface-variant");
}

function setReclaimTotal(solAmount) {
  const el = document.getElementById("cleanup-reclaim-total");
  if (!el) return;
  const n = Number(solAmount);
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  el.textContent = safe.toFixed(4) + " SOL";
}

function syncWalletUi() {
  const btn = document.getElementById("wallet-connect");
  refreshWalletConnectButtonLabel(btn);
  renderCleanupActivityStats();
}

function shortAddress(value) {
  const raw = String(value || "").trim();
  return raw.length > 10 ? raw.slice(0, 4) + "..." + raw.slice(-4) : raw || "Unknown";
}

function requireIncineratorApiKey() {
  if (hasSolIncineratorApiKey()) return true;
  const msg = "Missing Sol Incinerator API key. Add VITE_SOL_INCINERATOR_API_KEY to .env.";
  setReclaimStatus(msg, true);
  setDustStatus(msg, true);
  showCleanupToast(msg, "error", { durationMs: 7000 });
  return false;
}

function cleanupStatsHidden() {
  try {
    return localStorage.getItem(LS_CLEANUP_STATS_HIDDEN) !== "0";
  } catch (_) {
    return true;
  }
}

function setCleanupStatsHidden(hidden) {
  try {
    localStorage.setItem(LS_CLEANUP_STATS_HIDDEN, hidden ? "1" : "0");
  } catch (_) {
    /* ignore */
  }
}

function renderCleanupActivityStats() {
  const wrap = document.getElementById("cleanup-activity-stats-wrap");
  const host = document.getElementById("cleanup-activity-stats");
  const toggle = document.getElementById("cleanup-stats-toggle");
  if (!wrap || !host || !toggle) return;
  const hidden = cleanupStatsHidden();
  wrap.classList.toggle("hidden", hidden);
  toggle.textContent = hidden ? "Show stats" : "Hide stats";

  const wallet = getPublicKey()?.toBase58?.() || "";
  const stats = getSiteActivityStatsForWallet(wallet);
  const cells = [
    `Txns: ${stats.total}`,
    `Swaps: ${stats.swap}`,
    `Sends: ${stats.send}`,
    `Bridge: ${stats.bridge}`,
    `Burns: ${stats.burn}`,
    `Claims: ${stats.claim}`,
  ];
  host.innerHTML = "";
  cells.forEach((text) => {
    const card = document.createElement("div");
    card.className =
      "border border-black bg-surface-container-low px-3 py-2 text-center text-[10px] font-extrabold uppercase tracking-tight";
    card.textContent = text;
    host.appendChild(card);
  });
}

async function ensureWallet() {
  if (getPublicKey() && getProvider()) return true;
  const silent = await trySilentReconnect(syncWalletUi);
  if (silent) return true;
  showCleanupToast("Choose a wallet to continue", "info", { durationMs: 3500 });
  openWalletPicker(syncWalletUi);
  return false;
}

function maxUsdThreshold() {
  const input = document.getElementById("cleanup-max-usd");
  const n = Number(String(input?.value || "").trim());
  return Number.isFinite(n) && n > 0 ? n : DUST_BURN_DEFAULT_MAX_USD;
}

function formatDustValueLabel(row) {
  const accountLabel =
    row.accountCount > 1 ? `${row.accountCount} accounts` : "1 account";
  if (Number.isFinite(row.usdValue) && row.usdValue > 0) {
    return `${row.balanceLabel} | ${formatUsd(row.usdValue)} | ${accountLabel}`;
  }
  return `${row.balanceLabel} | no price | ${accountLabel}`;
}

function renderDustRows() {
  const host = document.getElementById("cleanup-dust-list");
  if (!host) return;
  host.innerHTML = "";
  if (!dustRows.length) {
    host.innerHTML =
      '<p class="px-3 py-4 text-xs font-bold uppercase text-on-surface-variant">No burnable token positions found.</p>';
    updateDustSelectionUi();
    return;
  }
  dustRows.forEach((row, idx) => {
    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className =
      "flex w-full items-center gap-3 border-b-2 border-black px-3 py-3 text-left transition-colors hover:bg-primary-container/30 " +
      (idx % 2 ? "bg-surface-container-low" : "bg-surface-container-lowest");
    const box = document.createElement("div");
    box.className =
      "flex h-6 w-6 shrink-0 items-center justify-center border-2 border-black text-sm font-extrabold leading-none " +
      (row.selected
        ? "bg-primary-container text-black"
        : "bg-white text-transparent");
    box.textContent = "X";

    const icon = document.createElement("div");
    icon.className =
      "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-black bg-white text-[10px] font-bold";
    if (row.logoURI) {
      const img = document.createElement("img");
      img.src = row.logoURI;
      img.alt = "";
      img.className = "h-full w-full object-cover";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => {
        icon.textContent = row.symbol.slice(0, 2);
      };
      icon.appendChild(img);
    } else {
      icon.textContent = row.symbol.slice(0, 2);
    }

    const mid = document.createElement("div");
    mid.className = "min-w-0 flex-1";
    const title = document.createElement("p");
    title.className = "truncate text-sm font-extrabold uppercase";
    title.textContent = row.symbol + "  " + row.name;
    const sub = document.createElement("p");
    sub.className = "truncate text-xs font-bold uppercase text-outline";
    sub.textContent = formatDustValueLabel(row);
    mid.appendChild(title);
    mid.appendChild(sub);

    wrap.appendChild(box);
    wrap.appendChild(icon);
    wrap.appendChild(mid);
    wrap.addEventListener("click", () => {
      row.selected = !row.selected;
      renderDustRows();
    });
    host.appendChild(wrap);
  });
  updateDustSelectionUi();
}

function updateDustSelectionUi() {
  const total = dustRows.length;
  const selected = dustRows.filter((r) => r.selected).length;
  const allSelected = total > 0 && selected === total;
  const el = document.getElementById("cleanup-dust-selection");
  if (el) {
    el.textContent =
      "Selected: " +
      selected +
      "/" +
      total +
      (allSelected ? " (ALL SELECTED)" : selected > 0 ? " (PARTIAL)" : "");
  }
  const btn = document.getElementById("cleanup-dust-select-all");
  if (btn) btn.textContent = allSelected ? "Clear all" : "Select all";
}

function parseRawTokenAmount(raw) {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return BigInt(Math.trunc(raw));
  }
  const text = String(raw ?? "0").trim();
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

async function fetchOwnedTokenAccounts(conn, owner) {
  async function fetchForProgram(programId) {
    const rows = await conn.getParsedTokenAccountsByOwner(
      owner,
      { programId },
      "confirmed"
    );
    const out = [];
    for (const row of rows?.value || []) {
      const parsed = row?.account?.data?.parsed;
      const info = parsed?.info;
      if (parsed?.type !== "account" || !info) continue;
      const decimals = Number(info?.tokenAmount?.decimals);
      const uiAmount = Number(info?.tokenAmount?.uiAmount);
      out.push({
        pubkey: row.pubkey?.toBase58?.() || String(row.pubkey || ""),
        programId,
        mint: String(info.mint || ""),
        owner: String(info.owner || ""),
        amount: parseRawTokenAmount(info?.tokenAmount?.amount),
        decimals: Number.isFinite(decimals) ? decimals : 0,
        uiAmount: Number.isFinite(uiAmount) ? uiAmount : NaN,
        closeAuthority: String(info.closeAuthority || info.owner || owner.toBase58()),
        lamports: Number(row.account?.lamports || 0),
      });
    }
    return out;
  }

  const [legacy, token22] = await Promise.allSettled([
    fetchForProgram(TOKEN_PROGRAM_ID),
    fetchForProgram(TOKEN_2022_PROGRAM_ID),
  ]);
  const out = [];
  if (legacy.status === "fulfilled") out.push(...legacy.value);
  if (token22.status === "fulfilled") out.push(...token22.value);
  if (!out.length) {
    const fallbackRows = await Promise.allSettled([
      conn.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
      conn.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
    ]);
    const decoded = [];
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].forEach((programId, idx) => {
      const bucket = fallbackRows[idx];
      if (bucket.status !== "fulfilled") return;
      for (const row of bucket.value?.value || []) {
        try {
          const account = unpackAccount(row.pubkey, row.account, programId);
          decoded.push({
            pubkey: row.pubkey?.toBase58?.() || String(row.pubkey || ""),
            programId,
            mint: account.mint.toBase58(),
            owner: account.owner.toBase58(),
            amount: account.amount,
            decimals: 0,
            uiAmount: NaN,
            closeAuthority: account.closeAuthority?.toBase58?.() || owner.toBase58(),
            lamports: Number(row.account?.lamports || 0),
          });
        } catch {
          /* ignore malformed token account rows */
        }
      }
    });
    if (decoded.length) return decoded;
    throw (
      (legacy.status === "rejected" && legacy.reason) ||
      (token22.status === "rejected" && token22.reason) ||
      new Error("Could not scan token accounts")
    );
  }
  return out;
}

async function fetchReclaimableTokenAccounts(conn, owner) {
  const owner58 = owner.toBase58();

  async function fetchForProgram(programId) {
    const rows = await conn.getParsedTokenAccountsByOwner(
      owner,
      { programId },
      "confirmed"
    );
    const out = [];
    for (const row of rows?.value || []) {
      const parsed = row?.account?.data?.parsed;
      const info = parsed?.info;
      if (parsed?.type !== "account" || !info) continue;
      const tokenOwner = String(info.owner || "");
      if (tokenOwner !== owner58) continue;
      const amount = parseRawTokenAmount(info.tokenAmount?.amount);
      if (amount !== 0n) continue;
      const closeAuthority = String(info.closeAuthority || tokenOwner || owner58);
      if (closeAuthority !== owner58) continue;
      out.push({
        pubkey: row.pubkey?.toBase58?.() || String(row.pubkey || ""),
        programId,
        mint: String(info.mint || ""),
        owner: tokenOwner,
        amount,
        closeAuthority,
        lamports: Number(row.account?.lamports || 0),
      });
    }
    return out;
  }

  const [legacy, token22] = await Promise.allSettled([
    fetchForProgram(TOKEN_PROGRAM_ID),
    fetchForProgram(TOKEN_2022_PROGRAM_ID),
  ]);

  const out = [];
  if (legacy.status === "fulfilled") out.push(...legacy.value);
  if (token22.status === "fulfilled") out.push(...token22.value);
  if (!out.length && legacy.status === "rejected" && token22.status === "rejected") {
    throw legacy.reason || token22.reason || new Error("Could not scan token accounts");
  }
  if (out.length) return out;

  const decodedAccounts = await fetchOwnedTokenAccounts(conn, owner);
  return decodedAccounts.filter(
    (acc) =>
      acc &&
      acc.owner === owner58 &&
      acc.amount === 0n &&
      String(acc.closeAuthority || owner58) === owner58
  );
}

async function hydrateReclaimMintMetadata(accounts) {
  const mints = [...new Set(accounts.map((x) => x.mint).filter(Boolean))]
    .filter((mint) => !dexscreenerByMint.has(mint))
    .slice(0, 30);
  if (!mints.length) return;
  await Promise.allSettled(
    mints.map(async (mint) => {
      const ds = await fetchDexscreenerSolanaMintProfile(mint).catch(() => null);
      if (ds) dexscreenerByMint.set(mint, ds);
    })
  );
  renderReclaimRows();
}

async function scanDustTokens() {
  const ok = await ensureWallet();
  if (!ok) return;
  const pk = getPublicKey();
  const threshold = maxUsdThreshold();
  setDustStatus("Scanning burnable token positions...");
  try {
    const ownedAccounts = await withRpcRetry((conn) =>
      fetchOwnedTokenAccounts(conn, pk)
    );
    const candidateRows = [];
    for (const acc of ownedAccounts) {
      const mint = String(acc?.mint || "");
      if (!mint || mint === SOL_MINT) continue;
      const amount = typeof acc.amount === "bigint" ? acc.amount : 0n;
      if (amount <= 0n) continue;
      const decimals = Number.isFinite(acc.decimals) ? acc.decimals : 0;
      const balanceUi =
        Number.isFinite(acc.uiAmount) && acc.uiAmount > 0
          ? acc.uiAmount
          : Number(amount) / Math.pow(10, decimals || 0);
      if (!Number.isFinite(balanceUi) || balanceUi <= 0) continue;
      candidateRows.push({
        assetId: String(acc.pubkey || ""),
        mint,
        decimals,
        balanceUi,
        closableAccountCount:
          String(acc.closeAuthority || pk.toBase58()) === pk.toBase58() ? 1 : 0,
      });
    }

    const mints = [...new Set(candidateRows.map((row) => row.mint))];
    const prices = mints.length
      ? await fetchUsdPricesForMints(mints, {})
      : new Map();

    const rows = candidateRows.map((row) => {
      const meta = jupiterByMint.get(row.mint);
      const price = prices.get(row.mint);
      const usdValue =
        price != null && Number.isFinite(price) && price > 0
          ? row.balanceUi * price
          : NaN;
      const decimals = Number.isFinite(meta?.decimals)
        ? meta.decimals
        : Number.isFinite(row.decimals)
          ? row.decimals
          : 9;
      const balanceLabel =
        row.balanceUi.toFixed(Math.min(6, decimals)).replace(/\.?0+$/, "") || "0";
      return {
        assetId: row.assetId,
        mint: row.mint,
        symbol: meta?.symbol || row.mint.slice(0, 4) + "...",
        name: meta?.name || "Token",
        decimals,
        logoURI: meta?.logoURI || "",
        balanceUi: row.balanceUi,
        balanceLabel,
        usdValue,
        accountCount: 1,
        closableAccountCount: row.closableAccountCount,
        selected:
          !USD_PEG_MINTS.has(row.mint) &&
          (!Number.isFinite(usdValue) || (usdValue > 0 && usdValue <= threshold)),
      };
    });
    rows.sort((a, b) => {
      const aScore = Number.isFinite(a.usdValue) ? a.usdValue : -1;
      const bScore = Number.isFinite(b.usdValue) ? b.usdValue : -1;
      return bScore - aScore || b.balanceUi - a.balanceUi;
    });
    await Promise.all(
      rows.map(async (row) => {
        if (row.name && row.name !== "Token" && row.symbol && !row.symbol.includes("...")) {
          return;
        }
        let ds = dexscreenerByMint.get(row.mint);
        if (!ds) {
          ds = await fetchDexscreenerSolanaMintProfile(row.mint).catch(() => null);
          if (ds) dexscreenerByMint.set(row.mint, ds);
        }
        if (!ds) return;
        if (ds.symbol && String(ds.symbol).trim()) {
          row.symbol = String(ds.symbol).trim().slice(0, 14);
        }
        if (ds.name && String(ds.name).trim()) {
          row.name = String(ds.name).trim().slice(0, 48);
        }
        if (ds.logoURI && String(ds.logoURI).trim()) {
          row.logoURI = String(ds.logoURI).trim();
        }
      })
    );
    dustRows = rows;
    renderDustRows();
    const autoSelectedCount = rows.filter((row) => row.selected).length;
    setDustStatus(
      rows.length
        ? "Found " + rows.length + " burnable token positions. Auto-selected " + autoSelectedCount + " low-value or unpriced positions."
        : "No burnable token positions found."
    );
  } catch (err) {
    setDustStatus(cleanupErrorMessage(err, "Could not scan burnable tokens"), true);
  }
}
function buildBurnOpsForToken(owner, row, accountsByMint) {
  const owner58 = owner.toBase58();
  const mintPk = new PublicKey(row.mint);
  const pulls = [accountsByMint.get(row.mint) || []];
  const out = [];
  for (const list of pulls) {
    for (const acc of list) {
      if (!acc) continue;
      if (String(acc.owner || "") !== owner58) continue;
      const amount = typeof acc.amount === "bigint" ? acc.amount : 0n;
      if (amount <= 0n) continue;
      const tokenAccPk = new PublicKey(acc.pubkey);
      const programId = acc.programId;
      out.push(
        createBurnInstruction(tokenAccPk, mintPk, owner, amount, [], programId)
      );
      const closeAuthority = String(acc.closeAuthority || owner58);
      if (closeAuthority === owner58) {
        out.push(createCloseAccountInstruction(tokenAccPk, owner, owner, [], programId));
      }
    }
  }
  return out;
}

async function collectBurnOps(selected) {
  const owner = getPublicKey();
  const routable = [];
  const skipped = [];
  const accountsByMint = new Map();
  await withRpcRetry(async (conn) => {
    const ownedAccounts = await fetchOwnedTokenAccounts(conn, owner);
    for (const acc of ownedAccounts) {
      const mint = String(acc?.mint || "");
      if (!mint) continue;
      if (!accountsByMint.has(mint)) accountsByMint.set(mint, []);
      accountsByMint.get(mint).push(acc);
    }

    for (const row of selected) {
      try {
        const ixs = buildBurnOpsForToken(owner, row, accountsByMint);
        if (!ixs.length) {
          skipped.push({
            row,
            message: `No burnable token accounts found for ${row.symbol}.`,
          });
          continue;
        }
        routable.push({ row, instructions: ixs });
      } catch (err) {
        skipped.push({
          row,
          message: cleanupErrorMessage(err, `Failed to prepare burn for ${row.symbol}`),
        });
      }
    }
  });
  return { routable, skipped };
}

function isChunkableBundlingError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("transaction too large") ||
    msg.includes("encoding overruns") ||
    msg.includes("rangeerror") ||
    msg.includes("versionedtransaction too large") ||
    msg.includes("exceeded maximum") ||
    msg.includes("max loaded accounts data size exceeded") ||
    msg.includes("compute budget exceeded") ||
    msg.includes("would exceed max block cost limit")
  );
}

async function buildBundleDraft(conn, owner, bundles) {
  if (!bundles.length) throw new Error("No bundles to build");
  const allIxs = [];
  bundles.forEach((b) => {
    (b.instructions || []).forEach((ix) => allIxs.push(ix));
  });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message([]);
  const tx = new VersionedTransaction(msg);
  const feeInfo = await conn.getFeeForMessage(msg, "confirmed");
  return {
    bundles,
    tx,
    estFeeLamports: Number(feeInfo?.value || 0),
  };
}

async function buildReclaimDrafts(conn, owner, accounts) {
  if (!accounts.length) return [];
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const drafts = [];
  let chunk = [];

  function buildDraftFromAccounts(chunkAccounts) {
    const instructions = chunkAccounts.map((acc) =>
      createCloseAccountInstruction(
        new PublicKey(acc.pubkey),
        owner,
        owner,
        [],
        acc.programId
      )
    );
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message([]);
    const tx = new VersionedTransaction(message);
    return {
      accounts: chunkAccounts,
      tx,
      message,
      wireBytes: tx.serialize().length,
    };
  }

  for (const acc of accounts) {
    const nextChunk = [...chunk, acc];
    const draft = buildDraftFromAccounts(nextChunk);
    if (
      chunk.length > 0 &&
      draft.wireBytes > RECLAIM_TARGET_TX_WIRE_BYTES
    ) {
      drafts.push(buildDraftFromAccounts(chunk));
      chunk = [acc];
      continue;
    }
    if (draft.wireBytes > MAX_SOLANA_TX_WIRE_BYTES) {
      throw new Error("A close-account transaction exceeded the Solana size limit.");
    }
    chunk = nextChunk;
  }

  if (chunk.length) {
    drafts.push(buildDraftFromAccounts(chunk));
  }

  const feeValues = await Promise.all(
    drafts.map((draft) => conn.getFeeForMessage(draft.message, "confirmed"))
  );
  return drafts.map((draft, idx) => ({
    accounts: draft.accounts,
    tx: draft.tx,
    estFeeLamports: Number(feeValues[idx]?.value || 0),
  }));
}

function splitGroupInHalf(group) {
  const splitAt = Math.ceil(group.length / 2);
  return [group.slice(0, splitAt), group.slice(splitAt)];
}

async function buildChunkPlan(conn, owner, routable) {
  const queue = [routable];
  const drafts = [];
  const failed = [];
  while (queue.length) {
    const group = queue.shift();
    try {
      drafts.push(await buildBundleDraft(conn, owner, group));
    } catch (err) {
      if (group.length > 1 && isChunkableBundlingError(err)) {
        const [left, right] = splitGroupInHalf(group);
        queue.unshift(right);
        queue.unshift(left);
      } else {
        group.forEach((b) => {
          failed.push({
            row: b.row,
            message: cleanupErrorMessage(err, "Burn transaction build failed"),
          });
        });
      }
    }
  }
  return { drafts, failed };
}

async function signDraftTransactions(provider, drafts) {
  const txs = drafts.map((d) => d.tx);
  if (provider?.signAllTransactions) {
    return provider.signAllTransactions(txs);
  }
  const out = [];
  for (const tx of txs) {
    out.push(await provider.signTransaction(tx));
  }
  return out;
}

async function sellSelectedDustSmartBundled(selected) {
  const owner = getPublicKey();
  const provider = getProvider();
  const { routable, skipped } = await collectBurnOps(selected);
  if (!routable.length) {
    const first = skipped[0]?.message || "No selected tokens had burnable balances.";
    throw new Error(first);
  }

  const { drafts, failed: buildFailed } = await withRpcRetry((conn) =>
    buildChunkPlan(conn, owner, routable)
  );
  if (!drafts.length) return { sent: [], skipped, failed: buildFailed };

  const estFeeLamports = drafts.reduce((sum, d) => {
    const n = Number.isFinite(d.estFeeLamports) ? d.estFeeLamports : 0;
    return sum + n;
  }, 0);
  await withRpcRetry(async (conn) => {
    const balLamports = await conn.getBalance(owner, "confirmed");
    const feeBufferLamports = 15000 * drafts.length;
    if (balLamports < estFeeLamports + feeBufferLamports) {
      const need = (estFeeLamports + feeBufferLamports) / LAMPORTS_PER_SOL;
      const have = balLamports / LAMPORTS_PER_SOL;
      throw new Error(
        `Not enough SOL for bulk fees. Need ~${need.toFixed(5)} SOL, have ${have.toFixed(5)} SOL.`
      );
    }
  });

  const signedTxs = await signDraftTransactions(provider, drafts);
  const sent = [];
  const failed = [...buildFailed];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const signed = signedTxs[i];
    try {
      const sig = await withRpcRetry((conn) =>
        conn.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        })
      );
      await waitForSignatureConfirmation(sig);
      sent.push({ sig, bundles: draft.bundles });
      for (const b of draft.bundles) {
        try {
          recordSiteBurn({
            wallet: owner.toBase58(),
            signature: `${sig}:${b.row.mint}`,
            mint: b.row.mint,
            symbol: b.row.symbol,
            amountHuman: b.row.balanceUi,
          });
        } catch {
          /* non-fatal */
        }
      }
    } catch (err) {
      draft.bundles.forEach((b) => {
        failed.push({
          row: b.row,
          message: cleanupErrorMessage(err, "Burn transaction failed"),
        });
      });
    }
  }

  return { sent, skipped, failed };
}

async function sellSelectedDust() {
  const ok = await ensureWallet();
  if (!ok) return;
  if (!requireIncineratorApiKey()) return;
  const selected = dustRows.filter((r) => r.selected);
  if (!selected.length) {
    showCleanupToast("Select at least one token first", "error");
    setDustStatus("No tokens selected. Pick one or use Select all.", true);
    return;
  }
  setDustStatus(`Preparing burn transactions for ${selected.length} selected token account(s)...`);
  showCleanupToast("Building Sol Incinerator burn transactions...", "info", {
    noAutoDismiss: true,
  });
  try {
    const owner58 = getPublicKey().toBase58();
    const provider = getProvider();
    const built = await Promise.allSettled(
      selected.map((row) => buildBurnTransaction(owner58, row.assetId))
    );
    const txDrafts = [];
    const buildErrors = [];
    built.forEach((result, idx) => {
      if (result.status === "fulfilled" && result.value?.serializedTransaction) {
        txDrafts.push({
          row: selected[idx],
          serializedTransaction: result.value.serializedTransaction,
        });
      } else {
        buildErrors.push(
          cleanupErrorMessage(
            result.status === "rejected" ? result.reason : "Could not build burn transaction",
            `Could not build burn transaction for ${selected[idx]?.symbol || "token"}`
          )
        );
      }
    });
    if (!txDrafts.length) {
      throw new Error(buildErrors[0] || "No burn transactions were built.");
    }
    const signed = await signDraftTransactions(
      provider,
      txDrafts.map((draft) => ({
        tx: VersionedTransaction.deserialize(bs58.decode(draft.serializedTransaction)),
      }))
    );
    const relay = await relaySignedTransactionsBatch(
      signed.map((tx) => bs58.encode(tx.serialize())),
      {
        maxConcurrency: 4,
        waitForConfirmation: true,
        confirmationCommitment: "confirmed",
        confirmationTimeoutMs: 45000,
      }
    );
    const results = Array.isArray(relay?.results) ? relay.results : [];
    const successes = results.filter((item) => item?.sent);
    const latestSig = successes[successes.length - 1]?.signature || "";
    successes.forEach((item) => {
      const row = txDrafts[item.index]?.row;
      if (!row) return;
      try {
        recordSiteBurn({
          wallet: owner58,
          signature: `${item.signature}:${row.assetId}`,
          mint: row.mint,
          symbol: row.symbol,
          amountHuman: row.balanceUi,
        });
      } catch {
        /* non-fatal */
      }
    });
    const failedCount = (Number(relay?.failedCount) || 0) + buildErrors.length;
    if (!successes.length) {
      throw new Error(buildErrors[0] || results.find((item) => item?.error)?.error || "No burns were executed.");
    }
    const successMsg =
      successes.length === 1
        ? "Burned 1 token account"
        : `Burned ${successes.length} token accounts`;
    showCleanupToast(successMsg, failedCount ? "info" : "success", {
      linkHref: latestSig ? "https://solscan.io/tx/" + latestSig : undefined,
      linkLabel: latestSig ? "View latest tx" : undefined,
      durationMs: 8000,
    });
    setDustStatus(
      failedCount
        ? `${successMsg}. Failed/skipped: ${failedCount}.`
        : `${successMsg}.`
    );
  } catch (bulkErr) {
    const msg = cleanupErrorMessage(
      bulkErr,
      "Bulk burn failed. Try again in a moment."
    );
    hideCleanupToast();
    showCleanupToast(msg, "error", { durationMs: 8000 });
    setDustStatus(msg, true);
  }
  await scanDustTokens();
}

function initBurnConfirmModal() {
  const modal = document.getElementById("cleanup-burn-confirm-modal");
  const summary = document.getElementById("cleanup-burn-confirm-summary");
  const confirmBtn = document.getElementById("cleanup-burn-confirm");
  const backdrop = modal?.querySelector("[data-popup-backdrop]");
  const panel = modal?.querySelector("[data-popup-panel]");
  if (!modal || !summary || !confirmBtn) return;

  function close() {
    closePopup(modal, { panel, backdrop });
  }

  function open() {
    const selected = dustRows.filter((r) => r.selected);
    if (!selected.length) {
      showCleanupToast("Select at least one token first", "error");
      setDustStatus("No tokens selected. Pick one or use Select all.", true);
      return;
    }
    summary.textContent =
      selected.length === 1
        ? `You are about to permanently burn ${selected[0].symbol}.`
        : `You are about to permanently burn ${selected.length} selected tokens.`;
    openPopup(modal, { panel, backdrop });
  }

  document.getElementById("cleanup-dust-sell")?.addEventListener("click", open);
  modal
    .querySelectorAll("[data-cleanup-burn-close]")
    .forEach((el) => el.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
  confirmBtn.addEventListener("click", () => {
    close();
    void sellSelectedDust();
  });
}

function renderReclaimRows() {
  const host = document.getElementById("cleanup-reclaim-list");
  if (!host) return;
  host.innerHTML = "";
  if (!reclaimableAccounts.length) {
    host.innerHTML =
      '<p class="px-3 py-4 text-xs font-bold uppercase text-on-surface-variant">No reclaimable token accounts found.</p>';
    return;
  }
  reclaimableAccounts.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.className =
      "flex items-center gap-3 border-b-2 border-black px-3 py-3 " +
      (idx % 2 ? "bg-surface-container-low" : "bg-surface-container-lowest");
    const icon = document.createElement("div");
    icon.className =
      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-black bg-white text-[10px] font-bold";
    icon.textContent = "SOL";
    const txt = document.createElement("div");
    txt.className = "min-w-0 flex-1";
    const sol = Number(row.solanaReclaimed) || Number(row.lamportsReclaimed || 0) / LAMPORTS_PER_SOL || 0;
    txt.innerHTML =
      `<p class="truncate text-sm font-extrabold uppercase">${shortAddress(row.assetId || row.pubkey || row.mint)}</p>` +
      `<p class="truncate text-[10px] font-bold uppercase text-outline">${sol.toFixed(4)} SOL</p>`;
    wrap.appendChild(icon);
    wrap.appendChild(txt);
    host.appendChild(wrap);
  });
}

async function scanReclaimable() {
  const ok = await ensureWallet();
  if (!ok) return;
  const owner = getPublicKey();
  setReclaimStatus("Scanning empty token accounts...");
  try {
    if (hasSolIncineratorApiKey()) {
      const owner58 = owner.toBase58();
      const summary = await summarizeCloseAll(owner58);
      if (!summary?.emptyAccountCount) {
        reclaimableAccounts = [];
        setReclaimStatus("No reclaimable token accounts found.");
        setReclaimTotal(0);
        renderReclaimRows();
        return;
      }
      let offset = 0;
      const previews = [];
      while (true) {
        const page = await previewCloseAllPage(owner58, offset, 500);
        previews.push(...(page?.accountPreviews || []));
        if (!page?.truncated) break;
        if (!Number.isFinite(page?.nextOffset)) break;
        offset = page.nextOffset;
      }
      reclaimableAccounts = previews;
      setReclaimStatus(`Found ${summary.emptyAccountCount} reclaimable accounts`);
      setReclaimTotal(Number(summary.totalSolanaReclaimable || 0));
      renderReclaimRows();
      return;
    }
    reclaimableAccounts = await withRpcRetry((conn) =>
      fetchReclaimableTokenAccounts(conn, owner)
    );
    const estSol = reclaimableAccounts.reduce(
      (sum, acc) => sum + (Number(acc.lamports || 0) / LAMPORTS_PER_SOL),
      0
    );
    setReclaimStatus(`Found ${reclaimableAccounts.length} reclaimable accounts`);
    setReclaimTotal(estSol);
    renderReclaimRows();
    void hydrateReclaimMintMetadata(reclaimableAccounts);
  } catch (err) {
    setReclaimStatus(cleanupErrorMessage(err, "Could not scan reclaimable accounts"), true);
    reclaimableAccounts = [];
    setReclaimTotal(0);
    renderReclaimRows();
  }
}

async function reclaimSolRent() {
  const ok = await ensureWallet();
  if (!ok) return;
  if (!requireIncineratorApiKey()) return;
  const owner = getPublicKey();
  const provider = getProvider();
  if (!reclaimableAccounts.length) {
    showCleanupToast("Run reclaim scan first", "info");
    return;
  }
  let closed = 0;
  let lastSig = "";
  let reclaimedLamports = 0;
  try {
    const owner58 = owner.toBase58();
    showCleanupToast("Building Sol Incinerator close transactions...", "info", {
      noAutoDismiss: true,
    });
    let offset = 0;
    const serializedTransactions = [];
    while (true) {
      const page = await buildCloseAllPage(owner58, offset, 500);
      serializedTransactions.push(...(page?.transactions || []));
      closed += Number(page?.accountsClosed || 0);
      reclaimedLamports += Number(page?.totalLamportsReclaimed || 0);
      if (!page?.truncated) break;
      if (!Number.isFinite(page?.nextOffset)) break;
      offset = page.nextOffset;
    }
    if (!serializedTransactions.length) {
      throw new Error("No close transactions were returned by Sol Incinerator.");
    }
    const signedTxs = await signDraftTransactions(
      provider,
      serializedTransactions.map((raw) => ({
        tx: VersionedTransaction.deserialize(bs58.decode(raw)),
      }))
    );
    const relay = await relaySignedTransactionsBatch(
      signedTxs.map((tx) => bs58.encode(tx.serialize())),
      {
        maxConcurrency: 4,
        waitForConfirmation: true,
        confirmationCommitment: "confirmed",
        confirmationTimeoutMs: 45000,
      }
    );
    const successResults = (relay?.results || []).filter((item) => item?.sent);
    lastSig = successResults[successResults.length - 1]?.signature || "";
    if (!successResults.length) {
      throw new Error(
        relay?.results?.find((item) => item?.error)?.error ||
        "No close transactions were submitted."
      );
    }
    reclaimableAccounts = [];
  } catch (err) {
    const msg = cleanupErrorMessage(err, "Could not close token accounts");
    hideCleanupToast();
    showCleanupToast(msg, "error", { durationMs: 8000 });
    setReclaimStatus(msg, true);
    return;
  }
  renderReclaimRows();
  setReclaimTotal(0);
  setReclaimStatus(`Reclaimed SOL by closing ${closed} token accounts.`);
  try {
    recordSiteClaim({
      wallet: owner.toBase58(),
      signature: lastSig || `claim:${Date.now()}`,
      closedCount: closed,
      reclaimedSol:
        reclaimedLamports > 0
          ? reclaimedLamports / LAMPORTS_PER_SOL
          : undefined,
    });
  } catch {
    /* non-fatal */
  }
  showCleanupToast(`Closed ${closed} token accounts`, "success", {
    linkHref: lastSig ? "https://solscan.io/tx/" + lastSig : undefined,
    linkLabel: lastSig ? "View latest tx" : undefined,
  });
}

async function init() {
  const threshold = document.getElementById("cleanup-max-usd");
  if (threshold) {
    bindDecimalInput(threshold, { maxDecimals: 2 });
    threshold.value = String(DUST_BURN_DEFAULT_MAX_USD);
  }
  const burnBtn = document.getElementById("cleanup-dust-sell");
  if (burnBtn) burnBtn.textContent = "Burn selected";
  await wireWalletConnectButton(syncWalletUi);
  const list = await fetchJupiterTokenList().catch(() => []);
  jupiterByMint = tokenMapByMint(list);

  document.getElementById("cleanup-dust-refresh")?.addEventListener("click", () => {
    void scanDustTokens();
  });
  document.getElementById("cleanup-dust-select-all")?.addEventListener("click", () => {
    const total = dustRows.length;
    const selected = dustRows.filter((r) => r.selected).length;
    const shouldSelectAll = !(total > 0 && selected === total);
    dustRows.forEach((r) => {
      r.selected = shouldSelectAll;
    });
    renderDustRows();
    const nextSelected = dustRows.filter((r) => r.selected).length;
    setDustStatus(
      shouldSelectAll
        ? `Selected ${nextSelected}/${total} tokens for burn.`
        : "Cleared all token selections."
    );
  });
  document.getElementById("cleanup-reclaim-scan")?.addEventListener("click", () => {
    void scanReclaimable();
  });
  document.getElementById("cleanup-reclaim-run")?.addEventListener("click", () => {
    void reclaimSolRent();
  });
  document.getElementById("cleanup-stats-toggle")?.addEventListener("click", () => {
    setCleanupStatsHidden(!cleanupStatsHidden());
    renderCleanupActivityStats();
  });
  window.addEventListener("neo-dex:wallet-changed", renderCleanupActivityStats);

  renderReclaimRows();
  setReclaimTotal(0);
  updateDustSelectionUi();
  initBurnConfirmModal();
  syncWalletUi();
  renderCleanupActivityStats();
}

init().catch((err) => {
  console.error("cleanup page init failed", err);
  setDustStatus("Could not initialize cleanup page", true);
});
