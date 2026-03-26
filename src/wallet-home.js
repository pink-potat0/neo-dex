import { Buffer } from "buffer";

window.Buffer = Buffer;

import "./analytics.js";

import { getWalletBalanceSnapshot } from "./lib/wallet-balances.js";
import { withRpcRetry, isRpcAccessError, invalidateRpcCache } from "./lib/solana-rpc.js";
import {
  getPublicKey,
  fmtShortPk,
  wireWalletConnectButton,
  trySilentReconnect,
  refreshWalletConnectButtonLabel,
} from "./lib/wallet-session.js";
import {
  fetchJupiterTokenList,
  tokenMapByMint,
  SOL_MINT,
} from "./lib/jupiter-tokens.js";
import {
  fetchDexscreenerSolanaMintProfile,
  fetchUsdPricesForMints,
  formatUsd,
  USD_PEG_MINTS,
} from "./lib/jupiter-price.js";
import {
  getSiteActivityForWallet,
  getSiteActivityStatsForWallet,
  formatActivityTime,
} from "./lib/site-activity.js";

/** Last completed refresh id; prevents late writes from older async runs. */
let dashboardRefreshId = 0;

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setLoadingPulse(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("loading-pulse", !!on);
}

function setPortfolioUsdDisplay(totalUsd, opts = {}) {
  const { hasHoldings = false, loading = false } = opts;
  const el = document.getElementById("home-portfolio-usd");
  if (!el) return;
  if (loading) {
    el.textContent = "...";
    el.classList.add("loading-pulse");
    el.className =
      "text-5xl font-bold tracking-tighter text-black md:text-7xl loading-pulse";
  } else if (isFinite(totalUsd) && totalUsd > 0) {
    el.textContent = formatUsd(totalUsd);
    el.classList.remove("loading-pulse");
    el.className =
      "text-5xl font-bold tracking-tighter text-black md:text-7xl";
  } else if (
    hasHoldings &&
    isFinite(totalUsd) &&
    totalUsd === 0
  ) {
    /** Holdings exist but no USD price — still show a real number. */
    el.textContent = formatUsd(0);
    el.classList.remove("loading-pulse");
    el.className =
      "text-5xl font-bold tracking-tighter text-black md:text-7xl";
  } else {
    el.textContent = "Unavailable";
    el.classList.remove("loading-pulse");
    el.className =
      "text-2xl font-bold uppercase tracking-tight text-black md:text-3xl";
  }
}

function fmtAmount(n, maxDecimals) {
  if (!isFinite(n)) return "—";
  if (n >= 1)
    return n.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
  return n.toFixed(maxDecimals).replace(/\.?0+$/, "") || "0";
}

const HOME_SNAPSHOT_PREFIX = "neo-dex-home-snapshot-v1:";

function snapshotKey(walletBase58) {
  return HOME_SNAPSHOT_PREFIX + walletBase58;
}

function saveHomeSnapshot(walletBase58, payload) {
  if (!walletBase58 || !payload) return;
  try {
    sessionStorage.setItem(snapshotKey(walletBase58), JSON.stringify(payload));
  } catch {
    /* ignore storage limits/private mode */
  }
}

function readHomeSnapshot(walletBase58) {
  if (!walletBase58) return null;
  try {
    const raw = sessionStorage.getItem(snapshotKey(walletBase58));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function renderSnapshot(snapshot) {
  const listEl = document.getElementById("home-token-list");
  const tokenEmpty = document.getElementById("home-token-empty");
  if (!snapshot || !Array.isArray(snapshot.rows)) return false;
  if (listEl) {
    listEl.innerHTML = "";
    for (const row of snapshot.rows) {
      const meta = row?.meta || {};
      listEl.appendChild(
        renderTokenRow(
          {
            symbol: meta.symbol || "?",
            name: meta.name || "Token",
            decimals: Number.isFinite(meta.decimals) ? meta.decimals : 9,
            logoURI: meta.logoURI || "",
          },
          Number(row.balance) || 0,
          row.mint || "",
          Number.isFinite(row.unitUsd) ? row.unitUsd : undefined
        )
      );
    }
  }
  setText(
    "home-primary-balance",
    snapshot.primaryBalance || "—"
  );
  setPortfolioUsdDisplay(
    Number.isFinite(snapshot.totalUsd) ? snapshot.totalUsd : NaN,
    { hasHoldings: (snapshot.rows?.length || 0) > 0 }
  );
  if (tokenEmpty) tokenEmpty.classList.toggle("hidden", (snapshot.rows?.length || 0) > 0);
  return true;
}

async function buildFastPortfolioPriceMap(rows, snapshot) {
  const out = new Map();
  const snapRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  for (const row of snapRows) {
    const mint = String(row?.mint || "").trim();
    const unitUsd = Number(row?.unitUsd);
    if (!mint || !isFinite(unitUsd) || unitUsd <= 0) continue;
    out.set(mint, unitUsd);
  }
  const quickMints = [...new Set(
    rows
      .map((row) => row?.mint)
      .filter(Boolean)
      .slice(0, 18)
  )];
  if (!quickMints.length) return out;
  try {
    const live = await fetchUsdPricesForMints(quickMints, {
      skipDexscreener: true,
    });
    for (const [mint, price] of live.entries()) {
      if (isFinite(price) && price > 0) out.set(mint, price);
    }
  } catch {
    /* cached snapshot prices are still useful */
  }
  return out;
}

function totalUsdFromRows(rows, priceMap) {
  let total = 0;
  let pricedCount = 0;
  for (const row of rows) {
    const price = priceMap.get(row.mint);
    if (price != null && isFinite(price) && isFinite(row.balance)) {
      total += row.balance * price;
      pricedCount += 1;
    }
  }
  return { total, pricedCount };
}

function buildInitialDashboardRows(balanceSnapshot) {
  const balances = balanceSnapshot?.byMint instanceof Map
    ? balanceSnapshot.byMint
    : new Map();
  const detailsByMint = balanceSnapshot?.detailsByMint instanceof Map
    ? balanceSnapshot.detailsByMint
    : new Map();
  const rows = [...balances.entries()]
    .filter(([, balance]) => Number.isFinite(balance) && balance > 0)
    .map(([mint, balance]) => {
      const details = detailsByMint.get(mint);
      const decimals =
        mint === SOL_MINT
          ? 9
          : Number.isFinite(details?.decimals)
            ? details.decimals
            : 9;
      return {
        mint,
        balance,
        meta: mint === SOL_MINT
          ? {
              symbol: "SOL",
              name: "Solana",
              decimals: 9,
              logoURI: "",
            }
          : {
              symbol: mint.slice(0, 4) + "…",
              name:
                details?.tokenProgram === "token2022"
                  ? "Token-2022"
                  : "SPL token",
              decimals,
              logoURI: "",
            },
      };
    })
    .filter((row) => rowShowsNonZeroHoldings(row.balance, row.meta.decimals));
  return {
    balances,
    rows,
    solTotal: balances.get(SOL_MINT) || 0,
  };
}

/** Jupiter strict list often omits pump.fun mints — symbol falls back to truncated mint. */
function metaNeedsDexscreenerEnrichment(meta, mint) {
  const sym = (meta.symbol || "").trim();
  const name = (meta.name || "").trim();
  const prefix = mint.slice(0, 4);
  if (!sym || sym === "?") return true;
  if (sym === prefix + "…" || sym === prefix + "...") return true;
  if (sym.startsWith(prefix) && /…|\.\.\./.test(sym)) return true;
  if (/^spl token$/i.test(name) || /^token-2022$/i.test(name)) return true;
  return false;
}

function applyDexProfileToRow(row, patch) {
  if (!patch) return;
  if (patch.symbol && String(patch.symbol).trim()) {
    row.meta.symbol = String(patch.symbol).trim().slice(0, 14);
  }
  if (patch.name && String(patch.name).trim()) {
    row.meta.name = String(patch.name).trim().slice(0, 48);
  }
  const skipDsLogo =
    USD_PEG_MINTS.has(row.mint) || row.mint === SOL_MINT;
  if (
    !skipDsLogo &&
    patch.logoURI &&
    String(patch.logoURI).trim()
  ) {
    row.meta.logoURI = String(patch.logoURI).trim();
  }
}

/** Canonical icons — DexScreener pair art is often the wrong side for stables. */
const TRUSTED_LOGO_BY_MINT = {
  [SOL_MINT]:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd:
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BerwUEd/logo.png",
};

function tokenRowLogoUri(mint, meta) {
  return TRUSTED_LOGO_BY_MINT[mint] || meta.logoURI || "";
}

/**
 * Balance from parsed token account: uses raw integer amount so empty ATAs
 * (stale uiAmount, rent-exempt zeros) are not treated as holdings.
 */
function parsedTokenUiAmount(info) {
  const ta = info?.tokenAmount;
  if (!ta) return null;
  let rawAmt;
  try {
    const raw = ta.amount;
    let s;
    if (typeof raw === "bigint") s = raw.toString();
    else if (typeof raw === "number" && Number.isFinite(raw))
      s = String(Math.trunc(raw));
    else s = String(raw ?? "0").trim();
    if (!/^\d+$/.test(s)) return null;
    rawAmt = BigInt(s);
  } catch {
    return null;
  }
  if (rawAmt <= 0n) return null;
  const dec = Number(ta.decimals ?? 0);
  if (!Number.isFinite(dec) || dec < 0 || dec > 20) return null;
  const ui = Number(rawAmt) / Math.pow(10, dec);
  if (!Number.isFinite(ui) || ui <= 0) return null;
  return ui;
}

function rowShowsNonZeroHoldings(balanceUi, decimals) {
  if (!isFinite(balanceUi) || balanceUi <= 0) return false;
  const shown = fmtAmount(balanceUi, Math.min(decimals, 8));
  return shown !== "0" && shown !== "—";
}

function fmtActivityAmt(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return n.toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** Stored amount can be a number or string like "0.1" / legacy "0.1 × 3". */
function parseActivityAmountHuman(h) {
  if (h == null || h === "") return NaN;
  if (typeof h === "number") return isFinite(h) ? h : NaN;
  const s = String(h).trim();
  const m = s.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

function shortAddr(addr) {
  const a = String(addr || "").trim();
  if (a.length < 12) return a || "—";
  return a.slice(0, 4) + "…" + a.slice(-4);
}

let activityShowAll = false;
let activityWalletBase58 = "";

function tokenIconWrap(innerNode) {
  const wrap = document.createElement("div");
  wrap.className =
    "flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-black bg-inverse-surface";
  wrap.appendChild(innerNode);
  return wrap;
}

function renderTokenRow(meta, balanceUi, mint, unitUsd) {
  const row = document.createElement("div");
  row.className =
    "group flex items-center justify-between border-4 border-black bg-surface-container-low p-6 transition-colors hover:bg-primary-container gap-3";

  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-1 items-center gap-4";

  const logoUri = tokenRowLogoUri(mint, meta);
  let iconEl;
  if (logoUri) {
    const img = document.createElement("img");
    img.src = logoUri;
    img.alt = "";
    img.className = "h-8 w-8 rounded-full object-cover";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      const sp = document.createElement("span");
      sp.className = "material-symbols-outlined text-primary-fixed text-3xl";
      sp.textContent = "toll";
      img.replaceWith(sp);
    };
    iconEl = tokenIconWrap(img);
  } else {
    const sp = document.createElement("span");
    sp.className = "material-symbols-outlined text-primary-fixed text-3xl";
    sp.textContent = "toll";
    iconEl = tokenIconWrap(sp);
  }

  const titles = document.createElement("div");
  titles.className = "min-w-0";
  const h4 = document.createElement("h4");
  h4.className = "font-bold text-xl leading-none truncate";
  h4.textContent = meta.symbol;
  const p = document.createElement("p");
  p.className =
    "text-xs font-medium uppercase text-outline group-hover:text-on-primary-container truncate";
  p.textContent = meta.name;
  titles.appendChild(h4);
  titles.appendChild(p);

  left.appendChild(iconEl);
  left.appendChild(titles);

  const right = document.createElement("div");
  right.className = "flex shrink-0 flex-col items-end gap-0.5 text-right";

  const usdLine = document.createElement("p");
  usdLine.className =
    "font-bold text-xl leading-none text-black group-hover:text-on-primary-container";
  if (unitUsd != null && isFinite(unitUsd) && isFinite(balanceUi)) {
    usdLine.textContent = formatUsd(balanceUi * unitUsd);
  } else {
    usdLine.textContent = "—";
    usdLine.classList.add("text-outline");
  }

  const bal = document.createElement("p");
  bal.className =
    "text-sm font-bold leading-none text-outline group-hover:text-on-primary-container";
  bal.textContent = fmtAmount(balanceUi, Math.min(meta.decimals, 8));

  const displayName = (meta.name && String(meta.name).trim()) || meta.symbol || "Token";
  const foot = document.createElement("p");
  foot.className =
    "mt-1 max-w-[min(100%,14rem)] truncate text-right text-[10px] font-bold text-outline group-hover:text-on-primary-container";
  foot.textContent = displayName;
  foot.title = mint;

  right.appendChild(usdLine);
  right.appendChild(bal);
  right.appendChild(foot);

  row.appendChild(left);
  row.appendChild(right);
  return row;
}

function renderActivity(walletPk) {
  const log = document.getElementById("home-activity-log");
  const empty = document.getElementById("home-activity-empty");
  const statsEl = document.getElementById("home-activity-stats");
  if (!log || !empty) return;

  const base58 = walletPk ? walletPk.toBase58() : "";
  if (activityWalletBase58 !== base58) {
    activityWalletBase58 = base58;
    activityShowAll = false;
  }
  const rows = getSiteActivityForWallet(base58);
  const stats = getSiteActivityStatsForWallet(base58);
  log.innerHTML = "";
  if (statsEl) {
    const cells = [
      `Txns: ${stats.total}`,
      `Swaps: ${stats.swap}`,
      `Sends: ${stats.send}`,
      `Bridge: ${stats.bridge}`,
      `Burns: ${stats.burn}`,
      `Claims: ${stats.claim}`,
    ];
    statsEl.innerHTML = "";
    cells.forEach((text) => {
      const p = document.createElement("p");
      p.className =
        "truncate border border-black bg-white px-2 py-1 text-center text-[10px] font-extrabold uppercase tracking-tight";
      p.textContent = text;
      statsEl.appendChild(p);
    });
  }

  if (!rows.length) {
    log.style.maxHeight = "";
    log.style.overflowY = "";
    log.style.overscrollBehavior = "contain";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  const lockPanelScroll = activityShowAll && rows.length > 5;
  log.style.maxHeight = lockPanelScroll ? "min(62vh, 34rem)" : "";
  log.style.overflowY = lockPanelScroll ? "auto" : "";
  log.style.overscrollBehavior = "contain";

  const visibleRows = activityShowAll ? rows : rows.slice(0, 5);
  visibleRows.forEach((e, i) => {
    const wrap = document.createElement("div");
    wrap.className =
      "flex gap-4 items-start border-b-4 border-black p-4 " +
      (i % 2 ? "bg-surface-container-low" : "");

    const icon = document.createElement("div");
    icon.className = "mt-1";
    const sym = document.createElement("span");
    sym.className = "material-symbols-outlined font-bold text-black dark:text-primary";
    sym.textContent = "swap_horiz";
    icon.appendChild(sym);

    const body = document.createElement("div");
    const line = document.createElement("p");
    line.className = "font-bold leading-tight";
    let sendMultiAppended = false;
    if (e.type === "swap") {
      line.textContent =
        "Swapped " +
        fmtActivityAmt(e.inputAmountHuman) +
        " " +
        e.inputSymbol +
        " for " +
        fmtActivityAmt(e.outputAmountHuman) +
        " " +
        e.outputSymbol;
    } else if (e.type === "send") {
      sym.textContent = "send";
      const symLabel = e.symbol || "tokens";
      const rawRecipients = String(e.recipient || "").trim();
      const addrs = rawRecipients
        ? rawRecipients.split(",").map((x) => x.trim()).filter(Boolean)
        : [];
      const count =
        typeof e.recipientCount === "number" && e.recipientCount > 0
          ? e.recipientCount
          : Math.max(1, addrs.length);
      const perAmt = parseActivityAmountHuman(e.amountHuman);
      const amtStr = fmtActivityAmt(perAmt);
      if (count <= 1) {
        const to = addrs[0] ? shortAddr(addrs[0]) : "—";
        line.textContent =
          "Sent " + amtStr + " " + symLabel + " to recipient " + to;
      } else {
        line.textContent =
          "Sent " +
          amtStr +
          " " +
          symLabel +
          " each to " +
          count +
          " recipients (one transaction)";
        const detail = document.createElement("p");
        detail.className =
          "mt-1 max-w-full break-words text-[11px] font-bold uppercase leading-snug text-outline";
        const shown = addrs.length
          ? addrs.map(shortAddr).join(" · ")
          : count + " wallets";
        detail.textContent = "Recipients: " + shown;
        body.appendChild(line);
        body.appendChild(detail);
        sendMultiAppended = true;
      }
    } else if (e.type === "bridge") {
      sym.textContent = "hub";
      const amount = fmtActivityAmt(parseActivityAmountHuman(e.amountHuman));
      const chainName = String(e.destinationChainName || "destination chain");
      const to = shortAddr(e.recipient);
      line.textContent =
        "Bridged " +
        amount +
        " " +
        (e.symbol || "SOL") +
        " to " +
        chainName +
        " (" +
        to +
        ")";
    } else if (e.type === "burn") {
      sym.textContent = "local_fire_department";
      const amount = fmtActivityAmt(parseActivityAmountHuman(e.amountHuman));
      const tokenCount =
        Number.isFinite(e.tokenCount) && e.tokenCount > 0 ? e.tokenCount : 0;
      if (tokenCount > 1) {
        line.textContent = "Burned " + tokenCount + " token balances";
      } else {
        line.textContent =
          "Burned " + amount + " " + (e.symbol || "TOKEN") + " (" + shortAddr(e.mint) + ")";
      }
    } else if (e.type === "claim") {
      sym.textContent = "savings";
      const cnt = Number.isFinite(e.closedCount) ? e.closedCount : 0;
      const est =
        Number.isFinite(e.reclaimedSol) && e.reclaimedSol > 0
          ? " · ~" + fmtActivityAmt(e.reclaimedSol) + " SOL"
          : "";
      line.textContent =
        "Claimed SOL by closing " + cnt + " token account" + (cnt === 1 ? "" : "s") + est;
    } else {
      line.textContent = "Transaction";
    }
    const meta = document.createElement("p");
    meta.className = "text-[10px] font-bold uppercase text-outline mt-1";
    const a = document.createElement("a");
    a.href = "https://solscan.io/tx/" + e.signature;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "underline font-bold";
    a.textContent = "Confirmed · " + formatActivityTime(e.ts);
    meta.appendChild(a);

    if (!sendMultiAppended) body.appendChild(line);
    body.appendChild(meta);
    wrap.appendChild(icon);
    wrap.appendChild(body);
    log.appendChild(wrap);
  });

  if (rows.length > 5) {
    const actions = document.createElement("div");
    actions.className =
      "sticky bottom-0 z-10 border-t-2 border-black bg-surface-container-lowest px-4 py-3";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "border-2 border-black bg-white px-3 py-1 text-xs font-bold uppercase tracking-tight hover:bg-primary-container";
    btn.textContent = activityShowAll ? "View less" : "View all";
    btn.addEventListener("click", () => {
      activityShowAll = !activityShowAll;
      renderActivity(walletPk);
    });
    actions.appendChild(btn);
    log.appendChild(actions);
  }
}

async function refreshDashboardOnce() {
  const runId = ++dashboardRefreshId;
  const listEl = document.getElementById("home-token-list");
  const tokenEmpty = document.getElementById("home-token-empty");
  const solscan = document.getElementById("home-solscan-link");
  const pk = getPublicKey();

  renderActivity(pk);

  if (!pk) {
    const pEl = document.getElementById("home-portfolio-usd");
    if (pEl) {
      pEl.textContent = "—";
      pEl.className =
        "text-5xl font-bold tracking-tighter text-black md:text-7xl";
    }
    setText("home-primary-balance", "—");
    setLoadingPulse("home-primary-balance", false);
    setText("home-address-chip", "Not connected");
    if (listEl) listEl.innerHTML = "";
    if (tokenEmpty) tokenEmpty.classList.add("hidden");
    if (solscan) solscan.classList.add("hidden");
    return;
  }

  /** Connected — show address immediately (chip also synced from wallet-session on connect). */
  setText("home-address-chip", fmtShortPk(pk));
  if (solscan) {
    solscan.href = "https://solscan.io/account/" + pk.toBase58();
    solscan.classList.remove("hidden");
  }

  if (listEl) listEl.innerHTML = "";
  if (tokenEmpty) {
    tokenEmpty.classList.add("hidden");
    tokenEmpty.textContent = "No balances to show for this wallet.";
  }
  const portEl = document.getElementById("home-portfolio-usd");
  if (portEl) {
    portEl.textContent = "…";
    portEl.className =
      "text-5xl font-bold tracking-tighter text-black md:text-7xl";
  }
  setText("home-primary-balance", "…");
  setLoadingPulse("home-primary-balance", true);

  // Instant fallback while live refresh runs.
  const wallet58 = pk.toBase58();
  const cached = readHomeSnapshot(wallet58);
  if (cached) {
    renderSnapshot(cached);
  }

  try {
    const jupListPromise = fetchJupiterTokenList().catch(() => []);

    // Stage 1 (priority): get wallet balances and render immediately.
    const balancePack = await withRpcRetry((conn) =>
      getWalletBalanceSnapshot(conn, pk)
    );
    if (runId !== dashboardRefreshId) return;
    const { rows: initialRows, solTotal } = buildInitialDashboardRows(balancePack);

    const toShow = [...initialRows]; if (false) {

      /** Sum UI balance per mint (multiple ATAs for same mint → one row). */
      const splByMint = new Map();

      for (const { account } of parsed.value) {
        const p = account?.data?.parsed;
        if (p?.type !== "account" || !p.info) continue;
        const info = p.info;
        const mint = info.mint;
        const ui = parsedTokenUiAmount(info);
        if (ui == null) continue;

        if (mint === SOL_MINT) {
          solTotal += ui;
          continue;
        }

        const dec = info.tokenAmount?.decimals ?? 9;
        const prev = splByMint.get(mint);
        const add = ui;
        if (prev) {
          prev.balance += add;
        } else {
          const meta = {
            symbol: mint.slice(0, 4) + "…",
            name: "SPL token",
            decimals: dec,
            logoURI: "",
          };
          splByMint.set(mint, {
            mint,
            balance: add,
            meta: {
              symbol: meta.symbol,
              name: meta.name,
              decimals: meta.decimals ?? dec,
              logoURI: meta.logoURI || "",
            },
          });
        }
      }

      const splRows = [...splByMint.values()].filter((r) =>
        rowShowsNonZeroHoldings(r.balance, r.meta.decimals)
      );

      const solMeta = {
        symbol: "SOL",
        name: "Solana",
        decimals: 9,
        logoURI: "",
      };

      if (listEl) listEl.innerHTML = "";

      let toShow = [];
      if (rowShowsNonZeroHoldings(solTotal, 9)) {
        toShow.push({
          mint: SOL_MINT,
          balance: solTotal,
          meta: solMeta,
        });
      }
      toShow.push(...splRows);
      toShow = toShow.filter(
        (t) =>
          Number.isFinite(t.balance) &&
          t.balance > 0 &&
          rowShowsNonZeroHoldings(t.balance, t.meta.decimals)
      ); }

      setText("home-primary-balance", fmtAmount(solTotal, 6) + " SOL");
      setLoadingPulse("home-primary-balance", false);
      if (!toShow.length) {
        if (tokenEmpty) tokenEmpty.classList.remove("hidden");
        setPortfolioUsdDisplay(0, { hasHoldings: false });
        setLoadingPulse("home-portfolio-usd", false);
        return;
      }

      // Show balances first, then enrich names/USD in background.
      if (listEl) {
        listEl.innerHTML = "";
        for (const t of toShow) {
          listEl.appendChild(renderTokenRow(t.meta, t.balance, t.mint, undefined));
        }
      }
      setPortfolioUsdDisplay(NaN, { hasHoldings: true, loading: true });
      setLoadingPulse("home-portfolio-usd", true);
      void buildFastPortfolioPriceMap(toShow, cached).then((fastPriceMap) => {
        if (runId !== dashboardRefreshId) return;
        const { total, pricedCount } = totalUsdFromRows(toShow, fastPriceMap);
        if (pricedCount > 0) {
          setPortfolioUsdDisplay(total, { hasHoldings: true });
          setLoadingPulse("home-portfolio-usd", false);
        }
      });

      // Stage 2: metadata enrichment.
      const jupList = await jupListPromise;
      if (runId !== dashboardRefreshId) return;
      const byMint = tokenMapByMint(jupList);
      for (const t of toShow) {
        const jm = byMint.get(t.mint);
        if (!jm) continue;
        t.meta.symbol = jm.symbol || t.meta.symbol;
        t.meta.name = jm.name || t.meta.name;
        t.meta.decimals = Number.isFinite(jm.decimals) ? jm.decimals : t.meta.decimals;
        t.meta.logoURI = jm.logoURI || t.meta.logoURI;
      }

      // Stage 3: pricing + final sorted render.
      const mintsForPrice = toShow.map((t) => t.mint);
      /** Default DS cap (24) often skips long-tail mints → $ shown but sort key 0; cover full list (bounded). */
      const dexMeta = new Map();
      let priceMap = new Map();
      try {
        priceMap = await fetchUsdPricesForMints(mintsForPrice, {
          dexscreenerMax: Math.min(mintsForPrice.length, 100),
          outDexscreenerMeta: dexMeta,
        });
      } catch (err) {
        console.warn("neo-dex: USD price fetch failed, showing balances only", err);
      }
      if (runId !== dashboardRefreshId) return;

      for (const t of toShow) {
        applyDexProfileToRow(t, dexMeta.get(t.mint));
      }
      const extraMints = [
        ...new Set(
          toShow
            .filter((t) => metaNeedsDexscreenerEnrichment(t.meta, t.mint))
            .map((t) => t.mint)
        ),
      ];
      if (extraMints.length) {
        try {
          await Promise.all(
            extraMints.map(async (mint) => {
              const p = await fetchDexscreenerSolanaMintProfile(mint);
              if (!p || (!p.symbol && !p.name && !p.logoURI)) return;
              const cur = dexMeta.get(mint);
              const skipDsLogo =
                USD_PEG_MINTS.has(mint) || mint === SOL_MINT;
              dexMeta.set(mint, {
                symbol: p.symbol || cur?.symbol,
                name: p.name || cur?.name,
                logoURI: skipDsLogo
                  ? cur?.logoURI || ""
                  : p.logoURI || cur?.logoURI || "",
              });
            })
          );
        } catch (err) {
          console.warn("neo-dex: token metadata enrichment failed", err);
        }
        if (runId !== dashboardRefreshId) return;
        for (const t of toShow) {
          applyDexProfileToRow(t, dexMeta.get(t.mint));
        }
      }

      function rowValueUsd(t) {
        const p = priceMap.get(t.mint);
        if (p != null && isFinite(p) && isFinite(t.balance)) {
          return t.balance * p;
        }
        return 0;
      }

      toShow.sort((a, b) => {
        const vb = rowValueUsd(b);
        const va = rowValueUsd(a);
        if (vb > va) return 1;
        if (vb < va) return -1;
        const pricedB = priceMap.has(b.mint);
        const pricedA = priceMap.has(a.mint);
        if (pricedB !== pricedA) {
          return (pricedB ? 1 : 0) - (pricedA ? 1 : 0);
        }
        if (b.balance !== a.balance) {
          return b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0;
        }
        return a.meta.symbol.localeCompare(b.meta.symbol, undefined, {
          sensitivity: "base",
        });
      });

      let totalUsd = 0;
      for (const t of toShow) {
        totalUsd += rowValueUsd(t);
      }

      if (runId !== dashboardRefreshId) return;
      if (!toShow.length) {
        if (tokenEmpty) tokenEmpty.classList.remove("hidden");
        setPortfolioUsdDisplay(0, { hasHoldings: false });
      } else {
        if (listEl) {
          // Replace quick rows with enriched/sorted final rows (avoid duplicates).
          listEl.innerHTML = "";
          for (const t of toShow) {
            listEl.appendChild(
              renderTokenRow(t.meta, t.balance, t.mint, priceMap.get(t.mint))
            );
          }
        }
        if (runId !== dashboardRefreshId) return;
        setPortfolioUsdDisplay(totalUsd, { hasHoldings: toShow.length > 0 });
        setLoadingPulse("home-portfolio-usd", false);
        saveHomeSnapshot(wallet58, {
          totalUsd,
          primaryBalance: fmtAmount(solTotal, 6) + " SOL",
          rows: toShow.map((t) => ({
            mint: t.mint,
            balance: t.balance,
            unitUsd: priceMap.get(t.mint),
            meta: {
              symbol: t.meta.symbol,
              name: t.meta.name,
              decimals: t.meta.decimals,
              logoURI: t.meta.logoURI || "",
            },
          })),
        });
      }

  } catch (e) {
    if (runId !== dashboardRefreshId) return;
    if (isRpcAccessError(e)) invalidateRpcCache();
    const hadCached = cached ? renderSnapshot(cached) : false;
    if (!hadCached) {
      if (listEl) listEl.innerHTML = "";
      setPortfolioUsdDisplay(NaN, { hasHoldings: false });
      setText("home-primary-balance", "—");
      setLoadingPulse("home-primary-balance", false);
      if (pk) setText("home-address-chip", fmtShortPk(pk));
      if (tokenEmpty) {
        tokenEmpty.textContent = "Could not load token balances.";
        tokenEmpty.classList.remove("hidden");
      }
    }
  }
}

/** One in-flight refresh at a time; coalesce overlapping calls (fixes portfolio stuck on "…"). */
let _refreshDashPromise = null;
let _refreshDashQueued = false;

async function refreshDashboard() {
  if (_refreshDashPromise) {
    _refreshDashQueued = true;
    return _refreshDashPromise;
  }
  _refreshDashPromise = (async () => {
    try {
      do {
        _refreshDashQueued = false;
        await refreshDashboardOnce();
      } while (_refreshDashQueued);
    } finally {
      _refreshDashPromise = null;
    }
  })();
  return _refreshDashPromise;
}

async function init() {
  await wireWalletConnectButton(refreshDashboard);

  document.getElementById("home-refresh-balances")?.addEventListener(
    "click",
    async function () {
      const btn = this;
      btn.disabled = true;
      const unlockTimer = setTimeout(() => {
        btn.disabled = false;
      }, 700);
      void refreshDashboard().finally(() => {
        clearTimeout(unlockTimer);
        btn.disabled = false;
      });
    }
  );

  await refreshDashboard();

  /** Wallet extensions sometimes inject after first silent reconnect — retry once. */
  if (!getPublicKey()) {
    const hdr = document.getElementById("wallet-connect");
    await new Promise((r) => setTimeout(r, 450));
    const ok = await trySilentReconnect(refreshDashboard);
    if (ok) refreshWalletConnectButtonLabel(hdr);
    await refreshDashboard();
  }
}

init().catch((err) => {
  console.error("wallet home init failed", err);
  setText("home-primary-balance", "—");
  setPortfolioUsdDisplay(NaN, { hasHoldings: false });
});

window.addEventListener("neo-dex:wallet-changed", () => {
  renderActivity(getPublicKey());
});

/** Refresh on bfcache restore only; normal navigations already run init(). */
window.addEventListener("pageshow", (e) => {
  if (e.persisted) void refreshDashboard();
});
