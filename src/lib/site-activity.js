const LS_KEY = "neo-dex-site-activity-v1";
const MAX = 80;

function readAll() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(arr) {
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}

function upsertRow(row) {
  const arr = readAll();
  const next = [row, ...arr.filter((e) => e.signature !== row.signature)].slice(0, MAX);
  writeAll(next);
}

/**
 * Persist a swap executed through this app (shown only in Activity Log here).
 */
export function recordSiteSend(entry) {
  const {
    wallet,
    signature,
    amountHuman,
    symbol,
    recipient,
    recipientCount,
    mint,
    sendKind,
  } = entry;
  if (!wallet || !signature) return;

  const row = {
    type: "send",
    wallet,
    signature,
    amountHuman,
    symbol,
    recipient,
    mint,
    sendKind: sendKind || "standard_send",
    ts: Date.now(),
  };
  if (typeof recipientCount === "number" && recipientCount > 0) {
    row.recipientCount = recipientCount;
  }

  upsertRow(row);
}

export function recordSiteSwap(entry) {
  const {
    wallet,
    signature,
    inputMint,
    outputMint,
    inputAmountHuman,
    outputAmountHuman,
    inputSymbol,
    outputSymbol,
  } = entry;
  if (!wallet || !signature) return;

  const row = {
    type: "swap",
    wallet,
    signature,
    inputMint,
    outputMint,
    inputAmountHuman,
    outputAmountHuman,
    inputSymbol,
    outputSymbol,
    ts: Date.now(),
  };

  upsertRow(row);
}

export function recordSiteBridge(entry) {
  const {
    wallet,
    signature,
    amountHuman,
    symbol,
    recipient,
    originChainId,
    destinationChainId,
    destinationChainName,
  } = entry;
  if (!wallet || !signature) return;

  const row = {
    type: "bridge",
    wallet,
    signature,
    amountHuman,
    symbol: symbol || "SOL",
    recipient,
    originChainId,
    destinationChainId,
    destinationChainName,
    ts: Date.now(),
  };

  upsertRow(row);
}

export function recordSiteBurn(entry) {
  const { wallet, signature, mint, symbol, amountHuman, tokenCount } = entry;
  if (!wallet || !signature) return;
  const row = {
    type: "burn",
    wallet,
    signature,
    mint: mint || "",
    symbol: symbol || "TOKEN",
    amountHuman,
    ts: Date.now(),
  };
  if (Number.isFinite(tokenCount) && tokenCount > 0) {
    row.tokenCount = tokenCount;
  }
  upsertRow(row);
}

export function recordSiteClaim(entry) {
  const { wallet, signature, closedCount, reclaimedSol } = entry;
  if (!wallet || !signature) return;
  upsertRow({
    type: "claim",
    wallet,
    signature,
    closedCount: Number.isFinite(closedCount) ? closedCount : 0,
    reclaimedSol: Number.isFinite(reclaimedSol) ? reclaimedSol : undefined,
    ts: Date.now(),
  });
}

/** Activity rows for the connected wallet only (from this site). */
export function getSiteActivityForWallet(walletBase58) {
  if (!walletBase58) return [];
  return readAll().filter((e) => e.wallet === walletBase58);
}

export function getSiteActivityStatsForWallet(walletBase58) {
  const rows = getSiteActivityForWallet(walletBase58);
  const stats = {
    total: rows.length,
    swap: 0,
    send: 0,
    bridge: 0,
    burn: 0,
    claim: 0,
    other: 0,
  };
  for (const e of rows) {
    if (e?.type === "swap") stats.swap += 1;
    else if (e?.type === "send") stats.send += 1;
    else if (e?.type === "bridge") stats.bridge += 1;
    else if (e?.type === "burn") stats.burn += 1;
    else if (e?.type === "claim") stats.claim += 1;
    else stats.other += 1;
  }
  return stats;
}

export function formatActivityTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
